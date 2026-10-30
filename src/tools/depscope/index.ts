import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { exists, readJson } from "../../core/fs.js"
import { buildGraph, findCycles, isBuiltin, toDot, toMermaid, type ImportGraph } from "../../core/imports.js"
import { allDeps, readPkg, workspaceDirs, type PackageJson } from "../../core/project.js"
import { behind, compareVersions } from "../../core/semver.js"
import { UsageError, type Finding, type Section, type ToolDef, type ToolResult } from "../../core/types.js"
import { BIN_PACKAGES } from "../repodoctor.js"
import { closure, duplicates, readLock, type Installed, type Lock } from "./lockfile.js"

/**
 * DepScope: what's really inside node_modules. Duplicate versions, unused and undeclared
 * dependencies, import cycles, the weight each dependency brings, and how far behind they are.
 */

const TEST_OR_TOOLING = /(^|\/)(test|tests|__tests__|__mocks__|e2e|cypress|playwright|scripts?|stories|\.storybook|fixtures?|benchmarks?)\/|\.(test|spec|stories|bench)\.[cm]?[jt]sx?$|(^|\/)[\w.-]*\.config\.[cm]?[jt]s$|(^|\/)(vite|vitest|jest|webpack|rollup|eslint|tailwind|postcss|babel|playwright|next|nuxt|astro|svelte|tsup)\.config/
const CONFIG_FILE = /(^|\/)([\w.-]*(rc|config)(\.[\w]+)?|\.[\w-]+rc(\.\w+)?)$|^\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose\.ya?ml|Makefile|turbo\.json|nx\.json|lerna\.json|\.husky\/.*)$/
const BUNDLERS = ["vite", "webpack", "next", "nuxt", "@sveltejs/kit", "astro", "parcel", "react-scripts", "@angular/cli", "esbuild", "rollup", "@remix-run/dev", "expo", "react-native", "electron-vite", "tsup", "@rsbuild/core"]
/** Packages that are needed without ever being imported. */
const IMPLICIT: Record<string, (root: string, pkg: PackageJson) => boolean> = {
  typescript: (root) => exists(join(root, "tsconfig.json")),
  tslib: (root) => /importHelpers"\s*:\s*true/.test(safeRead(join(root, "tsconfig.json"))),
  "@types/node": (root) => exists(join(root, "tsconfig.json")),
  "@types/jest": () => true,
  "@types/mocha": () => true,
  "ts-node": (_r, pkg) => JSON.stringify(pkg.scripts ?? {}).includes("ts-node") || JSON.stringify(pkg).includes("ts-node/"),
}

function safeRead(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function dirSize(dir: string, skipNested = true): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (skipNested && e.name === "node_modules") continue
      total += dirSize(join(dir, e.name), skipNested)
    } else {
      try {
        total += statSync(join(dir, e.name)).size
      } catch {}
    }
  }
  return total
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

type Analysis = { findings: Finding[]; sections: Section[]; summary: Record<string, string | number> }

/** Which declared dependencies are used, unused, missing, or misplaced, for one package directory. */
export function usage(root: string, dir: string, graph: ImportGraph, nestedDirs: string[], workspaceNames: Set<string>) {
  const pkgDir = join(root, dir)
  const pkg = readPkg(pkgDir) ?? {}
  const rootPkg = dir === "." ? pkg : readPkg(root) ?? {}
  const prefix = dir === "." ? "" : `${dir}/`
  const inScope = (f: string) => f.startsWith(prefix) && !nestedDirs.some((n) => n !== dir && f.startsWith(`${n}/`) && (dir === "." || n.startsWith(prefix)))
  const imports = new Map<string, { file: string; line: number; typeOnly: boolean }[]>()
  for (const [name, refs] of graph.packages) {
    const own = refs.filter((r) => inScope(r.file))
    if (own.length) imports.set(name, own)
  }
  const deps = pkg.dependencies ?? {}
  const devDeps = pkg.devDependencies ?? {}
  const declared = { ...deps, ...devDeps, ...pkg.peerDependencies, ...pkg.optionalDependencies }
  const rootDeclared = dir === "." ? {} : allDeps(rootPkg)

  // Text of everything that can mention a package without importing it.
  const scripts = Object.values({ ...pkg.scripts, ...(dir === "." ? {} : rootPkg.scripts) }).join("\n")
  const pkgRest = JSON.stringify({ ...pkg, dependencies: undefined, devDependencies: undefined, peerDependencies: undefined, optionalDependencies: undefined })
  const configs = [pkgRest, ...configFilesIn(root, dir).map((f) => safeRead(join(root, f)))].join("\n")

  const binsOf = (name: string): string[] => {
    const p = readJson(join(pkgDir, "node_modules", name, "package.json")) ?? readJson(join(root, "node_modules", name, "package.json"))
    const fromPkg = p?.bin ? (typeof p.bin === "string" ? [name.split("/").pop()!] : Object.keys(p.bin)) : []
    const fromMap = Object.entries(BIN_PACKAGES).filter(([, pkgs]) => pkgs.includes(name)).map(([b]) => b)
    return [...new Set([...fromPkg, ...fromMap])]
  }
  const peersOfUsed = new Set<string>()
  for (const name of imports.keys()) {
    const p = readJson(join(pkgDir, "node_modules", name, "package.json")) ?? readJson(join(root, "node_modules", name, "package.json"))
    for (const peer of Object.keys(p?.peerDependencies ?? {})) peersOfUsed.add(peer)
  }

  const used = (name: string): string | null => {
    if (imports.has(name)) return "imported"
    if (name.startsWith("@types/")) {
      const base = name.slice(7).replace(/^(.+)__(.+)$/, "@$1/$2")
      if (imports.has(base) || isBuiltin(base) || declared[base] || IMPLICIT[name]?.(pkgDir, pkg)) return "types"
      if (configs.includes(name.slice(7))) return "types"
      return null
    }
    if (IMPLICIT[name]?.(pkgDir, pkg) || IMPLICIT[name]?.(root, rootPkg)) return "implicit"
    for (const bin of binsOf(name)) if (new RegExp(`(^|[\\s;&|(/"'\`])${bin.replace(/[.+]/g, "\\$&")}($|[\\s;&|)"'\`])`, "m").test(scripts)) return "script"
    if (new RegExp(`(^|[\\s;&|(/"'\`])${name.replace(/[.+/]/g, "\\$&")}($|[\\s;&|)@/"'\`])`, "m").test(scripts)) return "script"
    const short = name.replace(/^(@[\w-]+\/)?(eslint-plugin-|eslint-config-|prettier-plugin-|babel-plugin-|babel-preset-|postcss-|stylelint-config-|stylelint-|@?vitejs\/plugin-|remark-|rehype-)/, "$1")
    if (configs.includes(name) || (short !== name && new RegExp(`["'\`/:]${short.replace(/[.+/]/g, "\\$&")}["'\`/]`).test(configs))) return "config"
    if (peersOfUsed.has(name)) return "peer"
    return null
  }

  const unused: { name: string; dev: boolean }[] = []
  for (const name of Object.keys({ ...deps, ...devDeps })) if (!used(name)) unused.push({ name, dev: !(name in deps) })
  // Packages loaded by name at runtime (logger transports, plugins): a quoted mention counts.
  if (unused.length) {
    const sources = graph.files.filter(inScope).map((f) => safeRead(join(root, f))).join("\n")
    for (let i = unused.length - 1; i >= 0; i--) {
      const n = unused[i]!.name.replace(/[.+/]/g, "\\$&")
      if (new RegExp(`["'\`]${n}(/[^"'\`]*)?["'\`]`).test(sources)) unused.splice(i, 1)
    }
  }

  const missing: { name: string; file: string; line: number }[] = []
  const devAtRuntime: { name: string; file: string; line: number }[] = []
  const isApp = !pkg.main && !pkg.bin && !pkg.exports && !pkg.module
  const bundled = isApp && BUNDLERS.some((b) => declared[b] || rootDeclared[b])
  for (const [name, refs] of imports) {
    const decl = name in declared || name in rootDeclared || workspaceNames.has(name)
    const typesOnly = refs.every((r) => r.typeOnly)
    if (!decl && !(typesOnly && (declared[`@types/${name}`] || rootDeclared[`@types/${name}`]))) {
      missing.push({ name, ...refs[0]! })
      continue
    }
    if (!bundled && name in devDeps && !(name in deps) && !(name in (pkg.peerDependencies ?? {}))) {
      const runtime = refs.find((r) => !r.typeOnly && !TEST_OR_TOOLING.test(r.file))
      if (runtime) devAtRuntime.push({ name, ...runtime })
    }
  }
  return { pkg, unused, missing, devAtRuntime }
}

function configFilesIn(root: string, dir: string): string[] {
  const out: string[] = []
  const base = join(root, dir)
  try {
    for (const e of readdirSync(base, { withFileTypes: true })) if (e.isFile() && CONFIG_FILE.test(e.name)) out.push(dir === "." ? e.name : `${dir}/${e.name}`)
  } catch {}
  const wf = join(root, ".github", "workflows")
  if (dir === "." && exists(wf)) for (const f of readdirSync(wf)) out.push(`.github/workflows/${f}`)
  return out
}

/** Registry lookups for latest versions (abbreviated metadata, small concurrency, timeouts). */
export async function latestVersions(names: string[], opts: { fetch: typeof fetch; registry?: string; timeoutMs?: number; concurrency?: number }) {
  const registry = (opts.registry ?? "https://registry.npmjs.org").replace(/\/$/, "")
  const out = new Map<string, { latest: string; deprecated: Record<string, string> } | { error: string }>()
  const queue = [...names]
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift()!
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
      try {
        const res = await opts.fetch(`${registry}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" }, signal: ctrl.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const meta: any = await res.json()
        const deprecated: Record<string, string> = {}
        for (const [v, info] of Object.entries<any>(meta.versions ?? {})) if (info?.deprecated) deprecated[v] = String(info.deprecated)
        out.set(name, { latest: meta["dist-tags"]?.latest, deprecated })
      } catch (err) {
        out.set(name, { error: (err as Error).name === "AbortError" ? "timed out" : (err as Error).message })
      } finally {
        clearTimeout(t)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, names.length) }, worker))
  return out
}

export function installedVersion(lock: Lock, root: string, dir: string, name: string): string | null {
  if (lock.kind === "npm") {
    const local = dir === "." ? null : lock.packages.find((p) => p.path === `${dir}/node_modules/${name}`)
    return (local ?? lock.packages.find((p) => p.path === `node_modules/${name}`))?.version ?? null
  }
  const fromFs = readJson(join(root, dir, "node_modules", name, "package.json"))?.version ?? readJson(join(root, "node_modules", name, "package.json"))?.version
  if (fromFs) return fromFs
  const all = lock.packages.filter((p) => p.name === name).map((p) => p.version).sort(compareVersions)
  return all.at(-1) ?? null
}

export async function analyze(root: string, opts: { offline?: boolean; fetch?: typeof fetch; registry?: string; includeTypeCycles?: boolean; top?: number; ignorePackages?: string[] } = {}): Promise<ToolResult> {
  const rootPkg = readPkg(root)
  if (!rootPkg) throw new UsageError(`No package.json in ${root}`)
  const findings: Finding[] = []
  const sections: Section[] = []
  const ignore = new Set(opts.ignorePackages ?? [])
  const lock = await readLock(root)
  const graph = await buildGraph(root)
  const dirs = [".", ...workspaceDirs(root)]
  const wsNames = new Set(dirs.map((d) => readPkg(join(root, d))?.name).filter(Boolean) as string[])

  // Unused, undeclared, misplaced.
  let unusedCount = 0
  for (const dir of dirs) {
    const pkgFile = dir === "." ? "package.json" : `${dir}/package.json`
    const u = usage(root, dir, graph, dirs.filter((d) => d !== "."), wsNames)
    for (const x of u.unused) {
      if (ignore.has(x.name)) continue
      unusedCount++
      findings.push({ rule: x.dev ? "unused-dev-dependency" : "unused-dependency", severity: x.dev ? "info" : "warning", message: `${x.name} is in ${x.dev ? "devDependencies" : "dependencies"} of ${pkgFile} but nothing uses it`, file: pkgFile, hint: x.dev ? "Remove it if it isn't used by a tool this check can't see." : `npm uninstall ${x.name}${dir === "." ? "" : ` -w ${dir}`}` })
    }
    for (const x of u.missing) if (!ignore.has(x.name)) findings.push({ rule: "undeclared-dependency", severity: "error", message: `${x.name} is imported but not declared in ${pkgFile}`, file: x.file, line: x.line, hint: "It only works because something else installed it. Add it explicitly." })
    for (const x of u.devAtRuntime) if (!ignore.has(x.name)) findings.push({ rule: "dev-dependency-at-runtime", severity: "warning", message: `${x.name} is a devDependency but runtime code imports it`, file: x.file, line: x.line, hint: "Production installs (npm ci --omit=dev) won't have it. Move it to dependencies." })
  }

  // Duplicates.
  const dups = duplicates(lock)
  const dupRows = [...dups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([name, vs]) => [name, vs.sort((a, b) => compareVersions(a.version, b.version)).map((v) => v.version).join(", "), vs.reduce((n, v) => n + v.count, 0)] as (string | number)[])
  // Direct dependencies of the root and every workspace package (minus the packages themselves).
  const declaredBy = new Map<string, { dir: string; range: string; prod: boolean }>()
  for (const dir of dirs) {
    const p = readPkg(join(root, dir))
    for (const [name, range] of Object.entries(allDeps(p))) if (!wsNames.has(name) && !declaredBy.has(name)) declaredBy.set(name, { dir, range: String(range), prod: Boolean(p?.dependencies?.[name]) })
  }
  const direct = new Set(declaredBy.keys())
  for (const [name, vs] of dups) {
    if (!direct.has(name) || ignore.has(name)) continue
    findings.push({ rule: "duplicate-versions", severity: "info", message: `${vs.length} versions of ${name} are installed (${vs.map((v) => v.version).join(", ")})`, hint: `"npm ls ${name}" shows who needs which; "npm dedupe" may merge them.` })
  }
  sections.push({ kind: "table", title: `Packages installed in more than one version (${dups.size})`, headers: ["Package", "Versions", "Copies"], rows: dupRows.slice(0, opts.top ?? 15) })

  // Size.
  const hasNodeModules = exists(join(root, "node_modules"))
  let totalSize = 0
  if (hasNodeModules) {
    const sizeOf = new Map<Installed, number>()
    const own = (p: Installed) => {
      if (!sizeOf.has(p)) sizeOf.set(p, dirSize(join(root, lock.kind === "npm" || lock.kind === "node_modules" ? p.path : `node_modules/${p.name}`)))
      return sizeOf.get(p)!
    }
    const rows: [string, number, number, string][] = []
    for (const name of direct) {
      const d = declaredBy.get(name)!
      const top = lock.packages.find((p) => p.path === `${d.dir === "." ? "" : `${d.dir}/`}node_modules/${name}`) ?? lock.packages.find((p) => p.path === `node_modules/${name}`) ?? lock.packages.find((p) => p.name === name)
      if (!top) continue
      const deps = closure(lock, top)
      const size = [...deps].reduce((n, p) => n + own(p), 0)
      rows.push([name, size, deps.size - 1, d.prod ? "prod" : "dev"])
    }
    totalSize = dirSize(join(root, "node_modules"), false)
    rows.sort((a, b) => b[1] - a[1])
    sections.push({ kind: "table", title: "Heaviest direct dependencies (with everything they pull in)", headers: ["Package", "Size", "Transitive deps", "Type"], rows: rows.slice(0, opts.top ?? 10).map(([n, s, t, k]) => [n, fmtBytes(s), t, k]) })
    for (const [name, size, , kind] of rows) if (kind === "prod" && size > 20 * 1024 * 1024) findings.push({ rule: "heavy-dependency", severity: "info", message: `${name} adds ${fmtBytes(size)} to production installs`, hint: "Check for a lighter alternative or a more specific import." })
  }

  // Import cycles.
  const cycles = findCycles(graph, { includeTypeOnly: opts.includeTypeCycles })
  for (const c of cycles) {
    const edge = graph.edges.get(c.cycle[0]!)?.find((e) => e.to === c.cycle[1])
    findings.push({ rule: "circular-import", severity: "warning", message: `Import cycle: ${c.cycle.join(" → ")}${c.members.length > c.cycle.length - 1 ? ` (${c.members.length} files are tangled together)` : ""}`, file: c.cycle[0], line: edge?.line, hint: "Move the shared code into a module both can import, or invert one dependency." })
  }

  // Outdated.
  let outdatedCount = 0
  if (!opts.offline && opts.fetch) {
    const names = [...direct].filter((n) => !ignore.has(n) && !/^(file|link|workspace|git|github|http|npm:)/.test(declaredBy.get(n)!.range))
    const latest = await latestVersions(names, { fetch: opts.fetch, registry: opts.registry })
    const rows: (string | number)[][] = []
    const failed: string[] = []
    const majors: string[] = []
    for (const name of names) {
      const info = latest.get(name)
      if (!info) continue
      if ("error" in info) {
        failed.push(name)
        continue
      }
      const d = declaredBy.get(name)!
      const pkgFile = d.dir === "." ? "package.json" : `${d.dir}/package.json`
      const current = installedVersion(lock, root, d.dir, name) ?? d.range.replace(/^[^\d]*/, "")
      const dep = info.deprecated[current]
      if (dep) findings.push({ rule: "deprecated", severity: "warning", message: `${name}@${current} is deprecated: ${dep.slice(0, 160)}`, file: pkgFile })
      const gap = info.latest ? behind(current, info.latest) : null
      if (!gap) continue
      outdatedCount++
      rows.push([name, current, info.latest, gap])
      if (gap === "major") majors.push(`${name} ${current} → ${info.latest}`)
    }
    if (majors.length) findings.push({ rule: "outdated-major", severity: "info", message: `${majors.length} direct ${majors.length === 1 ? "dependency is" : "dependencies are"} a major version behind: ${majors.slice(0, 6).join(", ")}${majors.length > 6 ? ", …" : ""}`, hint: "Major upgrades can break things; read each changelog and upgrade one at a time." })
    rows.sort((a, b) => ["major", "minor", "patch", "prerelease"].indexOf(String(a[3])) - ["major", "minor", "patch", "prerelease"].indexOf(String(b[3])))
    sections.push({ kind: "table", title: `Outdated direct dependencies (${rows.length})`, headers: ["Package", "Installed", "Latest", "Behind"], rows })
    if (failed.length) findings.push({ rule: "registry-unreachable", severity: "info", message: `Couldn't check ${failed.length} package${failed.length > 1 ? "s" : ""} against the registry (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` })
  }

  return {
    tool: "depscope",
    title: `DepScope: ${rootPkg.name ?? "dependencies"}`,
    summary: {
      direct: direct.size,
      installed: lock.packages.length,
      lockfile: lock.kind,
      ...(hasNodeModules ? { "node_modules": fmtBytes(totalSize) } : {}),
      unused: unusedCount,
      duplicated: dups.size,
      cycles: cycles.length,
      ...(opts.offline ? {} : { outdated: outdatedCount }),
    },
    sections,
    findings,
  }
}

/** Package tree (from the lockfile) or local module graph, as Mermaid or DOT. */
export async function graphOf(root: string, opts: { modules?: boolean; depth?: number; format?: "mermaid" | "dot"; focus?: string }): Promise<string> {
  const edges: [string, string][] = []
  const highlight = new Set<string>()
  if (opts.modules) {
    const g = await buildGraph(root)
    const cycles = findCycles(g)
    for (const c of cycles) for (const f of c.members) highlight.add(f)
    for (const [from, es] of g.edges) for (const e of es) if (!opts.focus || from.startsWith(opts.focus) || e.to.startsWith(opts.focus)) edges.push([from, e.to])
  } else {
    const pkg = readPkg(root)
    if (!pkg) throw new UsageError(`No package.json in ${root}`)
    const lock = await readLock(root)
    if (lock.kind === "none") throw new UsageError("No lockfile or node_modules to read the dependency tree from. Run npm install first.")
    const depth = opts.depth ?? 2
    const index = new Map(lock.packages.map((p) => [p.path, p]))
    const label = (p: Installed) => `${p.name}@${p.version}`
    const seen = new Set<string>()
    const roots = Object.keys(opts.focus ? { [opts.focus]: "" } : allDeps(pkg))
    const visit = (p: Installed, d: number) => {
      if (d >= depth || seen.has(p.path)) return
      seen.add(p.path)
      for (const dep of Object.keys(p.dependencies)) {
        const child = lock.kind === "npm" ? resolveChild(index, p.path, dep) : lock.packages.find((x) => x.name === dep)
        if (!child) continue
        edges.push([label(p), label(child)])
        visit(child, d + 1)
      }
    }
    for (const name of roots) {
      const top = lock.packages.find((p) => p.path === `node_modules/${name}`) ?? lock.packages.find((p) => p.name === name)
      if (!top) continue
      edges.push([pkg.name ?? "(root)", label(top)])
      visit(top, 1)
    }
    for (const [name] of duplicates(lock)) for (const [a, b] of edges) for (const n of [a, b]) if (n.startsWith(`${name}@`)) highlight.add(n)
  }
  const unique = [...new Map(edges.map((e) => [e.join("→"), e])).values()]
  return opts.format === "dot" ? toDot(unique, { highlight }) : toMermaid(unique, { highlight })
}

function resolveChild(index: Map<string, Installed>, from: string, dep: string) {
  let base = from
  while (true) {
    const hit = index.get(`${base ? `${base}/` : ""}node_modules/${dep}`)
    if (hit) return hit
    if (!base) return undefined
    const i = base.lastIndexOf("/node_modules/")
    base = i === -1 ? "" : base.slice(0, i)
  }
}

export const depscope: ToolDef = {
  name: "depscope",
  tagline: "Find duplicate, unused, undeclared, heavy and outdated npm dependencies, and import cycles",
  commands: {
    analyze: {
      description: "Analyse dependencies and imports",
      usage: "[dir]",
      options: {
        offline: { type: "boolean", description: "Skip registry lookups for outdated packages" },
        registry: { type: "string", description: "npm registry URL (default: npm_config_registry or registry.npmjs.org)" },
        "type-cycles": { type: "boolean", description: "Count type-only imports when looking for cycles" },
        top: { type: "string", description: "Rows per table (default: 10–15)" },
      },
      async run(ctx) {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        const cfg = ctx.config as { ignore?: string[]; ignorePackages?: string[]; registry?: string; offline?: boolean }
        ctx.log("Reading the lockfile and import graph…")
        return analyze(root, {
          offline: Boolean(ctx.options.offline ?? cfg.offline),
          fetch: ctx.fetch,
          registry: (ctx.options.registry as string) ?? cfg.registry ?? ctx.env.npm_config_registry,
          includeTypeCycles: Boolean(ctx.options["type-cycles"]),
          top: ctx.options.top ? Number(ctx.options.top) : undefined,
          ignorePackages: cfg.ignorePackages,
        })
      },
    },
    graph: {
      description: "Print the dependency tree (or local module graph) as Mermaid or Graphviz",
      usage: "[dir] [--modules] [--depth 2] [--graph-format mermaid|dot] [--focus name]",
      options: {
        modules: { type: "boolean", description: "Graph your own modules instead of npm packages (cycles in red)" },
        depth: { type: "string", description: "How many levels of the package tree (default: 2)" },
        "graph-format": { type: "string", description: "mermaid or dot (default: mermaid)" },
        focus: { type: "string", description: "Start from one package (or, with --modules, a folder)" },
      },
      async run(ctx) {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        const format = (ctx.options["graph-format"] as string) ?? "mermaid"
        if (format !== "mermaid" && format !== "dot") throw new UsageError("--graph-format must be mermaid or dot")
        const text = await graphOf(root, { modules: Boolean(ctx.options.modules), depth: ctx.options.depth ? Number(ctx.options.depth) : undefined, format, focus: ctx.options.focus as string | undefined })
        return { tool: "depscope", title: "DepScope graph", summary: {}, findings: [], raw: text, sections: [{ kind: "code", title: "Graph", language: format, body: text }] }
      },
    },
  },
}

