import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { exists, isDir, readJson, readText, toPosix, walk } from "../../core/fs.js"
import { readPkg, allDeps } from "../../core/project.js"
import { UsageError, type Finding, type ToolDef, type ToolResult } from "../../core/types.js"
import { analyzeKnex } from "./knex.js"
import { analyzeSql, RISK_POINTS, riskLevel, type Issue } from "./rules.js"

export type Framework = "prisma" | "drizzle" | "knex" | "sql"

const CANDIDATE_DIRS = ["prisma/migrations", "drizzle", "migrations", "db/migrations", "database/migrations", "src/migrations", "src/db/migrations", "supabase/migrations", "api/migrations", "server/migrations", "packages/db/migrations"]

/** Works out which framework wrote the migrations in `dir`. */
export function detectFramework(root: string, dir: string, files: string[]): Framework {
  if (/prisma\/migrations/.test(dir) || files.some((f) => f.endsWith("/migration.sql"))) return "prisma"
  if (exists(join(root, dir, "meta", "_journal.json")) || exists(join(root, "drizzle.config.ts")) || exists(join(root, "drizzle.config.js"))) return "drizzle"
  if (files.some((f) => /\.(c|m)?[jt]s$/.test(f)) && (allDeps(readPkg(root)).knex || files.some((f) => /\.(c|m)?[jt]s$/.test(f)))) return "knex"
  return "sql"
}

export async function findMigrationDirs(root: string): Promise<string[]> {
  const found = CANDIDATE_DIRS.filter((d) => isDir(join(root, d)))
  if (found.length) return found
  // Fall back to any folder named migrations (monorepos).
  const all = await walk(root, { extensions: [".sql", ".js", ".ts", ".mjs", ".cjs"] })
  return [...new Set(all.map((f) => f.match(/^(.*\/)?migrations\//)?.[0]?.replace(/\/$/, "")).filter(Boolean) as string[])].slice(0, 10)
}

/** Migration files added since a git ref (only new migrations need checking in CI). */
export function addedSince(rootIn: string, ref: string): Set<string> {
  // git reports real paths (macOS: /private/var/... for /var/...), so compare real paths.
  const root = realpathSync(rootIn)
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim()
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=AR", `${ref}...HEAD`], { cwd: root, encoding: "utf8" })
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    return new Set([...out.split("\n"), ...untracked.split("\n").map((f) => toPosix(relative(top, join(root, f))))].filter(Boolean).map((f) => toPosix(relative(root, join(top, f)))))
  } catch (err) {
    throw new UsageError(`Couldn't compare with git ref "${ref}": ${(err as Error).message.split("\n")[0]}`)
  }
}

export type FileReport = { file: string; framework: Framework; risk: ReturnType<typeof riskLevel>; points: number; issues: Issue[] }

export async function checkMigrations(root: string, opts: { paths?: string[]; framework?: Framework; since?: string; pgVersion?: number } = {}): Promise<{ reports: FileReport[]; result: ToolResult }> {
  const dirs = opts.paths?.length ? opts.paths : await findMigrationDirs(root)
  if (!dirs.length) throw new UsageError("No migrations folder found. Pass one: migraguard check ./migrations")
  const reports: FileReport[] = []
  const newTables = new Set<string>()
  const only = opts.since ? addedSince(root, opts.since) : null

  for (const d of dirs) {
    const abs = resolve(root, d)
    if (!exists(abs)) throw new UsageError(`Not found: ${d}`)
    const rel = toPosix(relative(root, abs)) || "."
    const files = isDir(abs)
      ? (await walk(abs, { extensions: [".sql", ".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"], respectGitignore: false })).filter((f) => !/\.(test|spec|d)\.[cm]?[jt]s$|(^|\/)meta\//.test(f) && !/(^|\/)(down|rollback)\.sql$|\.down\.sql$/.test(f)).map((f) => (rel === "." ? f : `${rel}/${f}`))
      : [rel]
    const framework = opts.framework ?? detectFramework(root, rel, files)
    // Migration order is filename order for every supported tool (timestamps or sequence numbers).
    const ordered = files
      .filter((f) => (framework === "knex" ? /\.(c|m)?[jt]s$/.test(f) : f.endsWith(".sql")) || (framework === "prisma" && f.endsWith(".sql")))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    if (framework === "drizzle") {
      const journal = readJson<{ entries?: { tag: string }[] }>(join(abs, "meta", "_journal.json"))
      if (journal?.entries?.length) {
        const order = new Map(journal.entries.map((e, i) => [e.tag, i]))
        ordered.sort((a, b) => (order.get(a.split("/").pop()!.replace(/\.sql$/, "")) ?? 1e9) - (order.get(b.split("/").pop()!.replace(/\.sql$/, "")) ?? 1e9))
      }
    }
    for (const file of ordered) {
      const src = await readText(join(root, file))
      const isNew = !only || only.has(file)
      const res = framework === "knex" && !file.endsWith(".sql") ? analyzeKnex(src, { newTables, pgVersion: opts.pgVersion, wrappedInTransaction: true }) : analyzeSql(src, { newTables, pgVersion: opts.pgVersion, wrappedInTransaction: framework === "drizzle" })
      // A table created in an earlier migration may hold data by the time a later one runs.
      // Only an undeployed batch (--since) deploys together, so its new tables are still empty.
      if (only && isNew) for (const t of res.created) newTables.add(t)
      if (!isNew) continue
      const points = res.issues.reduce((n, i) => n + RISK_POINTS[i.severity], 0)
      reports.push({ file, framework, risk: riskLevel(points), points, issues: res.issues })
    }
  }

  const findings: Finding[] = reports.flatMap((r) => r.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message, hint: i.hint, file: r.file, line: i.line })))
  const high = reports.filter((r) => r.risk === "high").length
  const frameworks = [...new Set(reports.map((r) => r.framework))]
  const result: ToolResult = {
    tool: "migraguard",
    title: "MigraGuard: migration safety (PostgreSQL)",
    summary: { checked: reports.length, framework: frameworks.join(", ") || "none", "high risk": high, ...(opts.since ? { since: opts.since } : {}) },
    sections: [
      {
        kind: "table",
        title: "Risk by migration",
        headers: ["Migration", "Risk", "Errors", "Warnings"],
        rows: reports.filter((r) => r.points > 0).map((r) => [r.file, r.risk, r.issues.filter((i) => i.severity === "error").length, r.issues.filter((i) => i.severity === "warning").length]),
      },
    ],
    findings,
  }
  return { reports, result }
}

export const migraguard: ToolDef = {
  name: "migraguard",
  tagline: "Catch destructive and lock-heavy PostgreSQL migrations (SQL, Prisma, Drizzle, Knex) before they deploy",
  commands: {
    check: {
      description: "Analyse migrations and report risky operations",
      usage: "[dir or file ...] [--since origin/main]",
      options: {
        since: { type: "string", description: "Only check migrations added since this git ref (recommended in CI)" },
        framework: { type: "string", description: "prisma, drizzle, knex or sql (default: detected)" },
        "pg-version": { type: "string", description: "PostgreSQL major version you deploy to (default: 15)" },
      },
      async run(ctx) {
        const cfg = ctx.config as { dirs?: string[]; dir?: string; framework?: Framework; pgVersion?: number; since?: string }
        const fw = (ctx.options.framework as string | undefined) ?? cfg.framework
        if (fw && !["prisma", "drizzle", "knex", "sql"].includes(fw)) throw new UsageError("--framework must be prisma, drizzle, knex or sql")
        const paths = ctx.positionals.length ? ctx.positionals : cfg.dirs ?? (cfg.dir ? [cfg.dir] : undefined)
        ctx.log("Checking migrations…")
        const { result } = await checkMigrations(ctx.cwd, { paths, framework: fw as Framework | undefined, since: (ctx.options.since as string) ?? cfg.since, pgVersion: Number(ctx.options["pg-version"] ?? cfg.pgVersion ?? 15) })
        return result
      },
    },
  },
}
