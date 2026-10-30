import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { exists, isDir, readJson } from "./fs.js"

export type PackageJson = {
  name?: string
  version?: string
  description?: string
  license?: string
  private?: boolean
  repository?: unknown
  main?: string
  module?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: unknown
  type?: string
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
  [k: string]: unknown
}

export const readPkg = (dir: string) => readJson<PackageJson>(join(dir, "package.json"))

export const allDeps = (pkg: PackageJson | null) => ({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies, ...pkg?.optionalDependencies })

/** Workspace package directories (relative), from package.json "workspaces" or pnpm-workspace.yaml. */
export function workspaceDirs(root: string): string[] {
  const pkg = readPkg(root)
  let patterns: string[] = Array.isArray(pkg?.workspaces) ? pkg!.workspaces : (pkg?.workspaces as { packages?: string[] } | undefined)?.packages ?? []
  if (!patterns.length && exists(join(root, "pnpm-workspace.yaml"))) {
    try {
      const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
      patterns = [...text.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]!)
    } catch {}
  }
  const dirs = new Set<string>()
  for (const p of patterns) {
    if (p.startsWith("!")) continue
    const clean = p.replace(/\/$/, "")
    if (clean.endsWith("/*") || clean.endsWith("/**")) {
      const base = clean.replace(/\/\*\*?$/, "")
      if (!isDir(join(root, base))) continue
      for (const e of readdirSync(join(root, base), { withFileTypes: true })) if (e.isDirectory() && exists(join(root, base, e.name, "package.json"))) dirs.add(`${base}/${e.name}`)
    } else if (exists(join(root, clean, "package.json"))) dirs.add(clean)
  }
  return [...dirs].sort()
}

export function lockfiles(root: string) {
  return ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"].filter((f) => exists(join(root, f)))
}

export function packageManager(root: string): "npm" | "yarn" | "pnpm" | "bun" {
  const pkg = readPkg(root)
  const declared = typeof pkg?.packageManager === "string" ? (pkg.packageManager as string).split("@")[0] : null
  if (declared === "yarn" || declared === "pnpm" || declared === "bun" || declared === "npm") return declared
  const locks = lockfiles(root)
  if (locks.includes("pnpm-lock.yaml")) return "pnpm"
  if (locks.includes("yarn.lock")) return "yarn"
  if (locks.some((l) => l.startsWith("bun"))) return "bun"
  return "npm"
}
