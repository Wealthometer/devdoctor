import { readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { exists, readJson, readText } from "../../core/fs.js"

/** One installed copy of a package. */
export type Installed = { name: string; version: string; path: string; dev?: boolean; dependencies: Record<string, string> }

export type Lock = { kind: "npm" | "pnpm" | "yarn" | "node_modules" | "none"; packages: Installed[] }

/** Reads whichever lockfile exists, falling back to walking node_modules. */
export async function readLock(root: string): Promise<Lock> {
  if (exists(join(root, "package-lock.json")) || exists(join(root, "npm-shrinkwrap.json"))) {
    const json = readJson(join(root, exists(join(root, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json"))
    if (json) return { kind: "npm", packages: parseNpmLock(json) }
  }
  if (exists(join(root, "pnpm-lock.yaml"))) return { kind: "pnpm", packages: parsePnpmLock(await readText(join(root, "pnpm-lock.yaml"))) }
  if (exists(join(root, "yarn.lock"))) return { kind: "yarn", packages: parseYarnLock(await readText(join(root, "yarn.lock"))) }
  if (exists(join(root, "node_modules"))) return { kind: "node_modules", packages: scanNodeModules(join(root, "node_modules")) }
  return { kind: "none", packages: [] }
}

const nameFromPath = (p: string) => {
  const i = p.lastIndexOf("node_modules/")
  return i === -1 ? null : p.slice(i + "node_modules/".length)
}

export function parseNpmLock(json: any): Installed[] {
  const out: Installed[] = []
  if (json.packages) {
    for (const [path, info] of Object.entries<any>(json.packages)) {
      if (!path || info.link) continue
      const name = info.name ?? nameFromPath(path)
      if (!name || !info.version) continue
      out.push({ name, version: info.version, path, dev: Boolean(info.dev), dependencies: { ...info.dependencies, ...info.optionalDependencies } })
    }
    return out
  }
  // lockfileVersion 1: nested "dependencies".
  const visit = (deps: Record<string, any>, prefix: string) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const path = `${prefix}node_modules/${name}`
      out.push({ name, version: info.version, path, dev: Boolean(info.dev), dependencies: info.requires ?? {} })
      if (info.dependencies) visit(info.dependencies, `${path}/`)
    }
  }
  visit(json.dependencies, "")
  return out
}

export function parsePnpmLock(text: string): Installed[] {
  const doc: any = parseYaml(text) ?? {}
  const out: Installed[] = []
  const snapshots = doc.snapshots ?? {}
  for (const [key, info] of Object.entries<any>(doc.packages ?? {})) {
    const clean = key.replace(/^\//, "").replace(/\(.*$/, "")
    const at = clean.lastIndexOf("@")
    if (at <= 0) continue
    const name = clean.slice(0, at)
    const version = clean.slice(at + 1).split("_")[0]!
    const deps = { ...(info?.dependencies ?? snapshots[key]?.dependencies ?? {}), ...(info?.optionalDependencies ?? {}) }
    out.push({ name, version, path: key, dev: Boolean(info?.dev), dependencies: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, String(v).replace(/\(.*$/, "")])) })
  }
  return out
}

export function parseYarnLock(text: string): Installed[] {
  const out: Installed[] = []
  const blocks = text.split(/\n(?=\S)/)
  for (const block of blocks) {
    const lines = block.split("\n")
    const header = lines[0]!.trim()
    if (!header || header.startsWith("#") || header.startsWith("__metadata")) continue
    const first = header.replace(/:$/, "").split(",")[0]!.trim().replace(/^"|"$/g, "")
    const at = first.indexOf("@", first.startsWith("@") ? 1 : 0)
    if (at <= 0) continue
    const name = first.slice(0, at)
    const version = block.match(/^\s+version:?\s+"?([^"\n]+)"?/m)?.[1]
    if (!version) continue
    const deps: Record<string, string> = {}
    const depsBlock = block.match(/^\s+dependencies:\s*\n((?:\s{4,}.+\n?)+)/m)?.[1] ?? ""
    for (const l of depsBlock.split("\n")) {
      const m = l.trim().match(/^"?([^"\s:]+)"?:?\s+"?([^"]+)"?$/)
      if (m) deps[m[1]!] = m[2]!
    }
    out.push({ name, version, path: first, dependencies: deps })
  }
  return out
}

export function scanNodeModules(dir: string, prefix = "node_modules/", depth = 0): Installed[] {
  const out: Installed[] = []
  if (depth > 6) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue
    const names = e.name.startsWith("@") ? readdirSync(join(dir, e.name), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => `${e.name}/${x.name}`) : [e.name]
    for (const name of names) {
      const pkg = readJson(join(dir, name, "package.json"))
      if (!pkg?.version) continue
      out.push({ name, version: pkg.version, path: `${prefix}${name}`, dependencies: { ...pkg.dependencies, ...pkg.optionalDependencies } })
      if (exists(join(dir, name, "node_modules"))) out.push(...scanNodeModules(join(dir, name, "node_modules"), `${prefix}${name}/node_modules/`, depth + 1))
    }
  }
  return out
}

/** Name → distinct versions installed, for packages with more than one. */
export function duplicates(lock: Lock): Map<string, { version: string; count: number }[]> {
  const by = new Map<string, Map<string, number>>()
  for (const p of lock.packages) {
    const m = by.get(p.name) ?? new Map()
    m.set(p.version, (m.get(p.version) ?? 0) + 1)
    by.set(p.name, m)
  }
  const out = new Map<string, { version: string; count: number }[]>()
  for (const [name, versions] of by) if (versions.size > 1) out.set(name, [...versions].map(([version, count]) => ({ version, count })))
  return out
}

/**
 * The installed copy a package at `fromPath` gets for `dep`, following Node's lookup:
 * nearest node_modules first, then each parent up to the root (npm lockfiles only).
 */
export function resolveIn(index: Map<string, Installed>, fromPath: string, dep: string): Installed | undefined {
  let base = fromPath
  while (true) {
    const hit = index.get(`${base ? `${base}/` : ""}node_modules/${dep}`)
    if (hit) return hit
    if (!base) return undefined
    const i = base.lastIndexOf("/node_modules/")
    base = i === -1 ? "" : base.slice(0, i)
  }
}

/** Every package a direct dependency pulls in (itself included), as lock paths. */
export function closure(lock: Lock, root: Installed): Set<Installed> {
  const seen = new Set<Installed>()
  if (lock.kind === "npm") {
    const index = new Map(lock.packages.map((p) => [p.path, p]))
    const stack = [root]
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      for (const d of Object.keys(p.dependencies)) {
        const r = resolveIn(index, p.path, d)
        if (r && !seen.has(r)) stack.push(r)
      }
    }
    return seen
  }
  // pnpm/yarn: resolve by name (and version when recorded).
  const byName = new Map<string, Installed[]>()
  for (const p of lock.packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p)) continue
    seen.add(p)
    for (const [d, v] of Object.entries(p.dependencies)) {
      const cands = byName.get(d) ?? []
      const r = cands.find((c) => c.version === v) ?? cands[0]
      if (r && !seen.has(r)) stack.push(r)
    }
  }
  return seen
}
