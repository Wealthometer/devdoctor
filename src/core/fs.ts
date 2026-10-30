import { existsSync, readFileSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

export const DEFAULT_IGNORES = ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".vercel", ".svelte-kit", "vendor", "target", "__pycache__", ".venv"]

/** Converts .gitignore-style patterns to a matcher on POSIX-style relative paths. */
export function ignoreMatcher(patterns: string[]) {
  const rules = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"))
    .map((p) => {
      const negate = p.startsWith("!")
      let pat = negate ? p.slice(1) : p
      const dirOnly = pat.endsWith("/")
      if (dirOnly) pat = pat.slice(0, -1)
      const anchored = pat.startsWith("/") || pat.includes("/")
      pat = pat.replace(/^\//, "")
      const re = pat
        .split("")
        .map((ch, i, a) => {
          if (ch === "*") return a[i + 1] === "*" ? "" : a[i - 1] === "*" ? ".*" : "[^/]*"
          if (ch === "?") return "[^/]"
          return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
        })
        .join("")
      const prefix = anchored ? "^" : "(^|/)"
      // Matches the path itself, or anything inside it.
      return { negate, dirOnly, regex: new RegExp(`${prefix}${re}(/.*)?$`), inside: new RegExp(`${prefix}${re}/`) }
    })
  return (path: string, isDir: boolean) => {
    let ignored = false
    for (const r of rules) {
      // "build/" ignores a directory named build and its contents, not a file named build.
      const hit = r.dirOnly && !isDir ? r.inside.test(path) : r.regex.test(path)
      if (hit) ignored = !r.negate
    }
    return ignored
  }
}

export type WalkOptions = { ignore?: string[]; extensions?: string[]; maxFiles?: number; respectGitignore?: boolean }

/** Lists files under `root` (relative POSIX paths), skipping common build output and .gitignore entries. */
export async function walk(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const extra = opts.respectGitignore === false ? [] : readLines(join(root, ".gitignore"))
  const match = ignoreMatcher([...DEFAULT_IGNORES, ...extra, ...(opts.ignore ?? [])])
  const out: string[] = []
  const max = opts.maxFiles ?? 50_000
  async function visit(dir: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= max) return
      const abs = join(dir, e.name)
      const rel = toPosix(relative(root, abs))
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (!match(rel, true)) await visit(abs)
      } else if (e.isFile() && !match(rel, false)) {
        if (!opts.extensions || opts.extensions.some((x) => e.name.endsWith(x))) out.push(rel)
      }
    }
  }
  await visit(root)
  return out
}

export const toPosix = (p: string) => p.split(sep).join("/")

export function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/)
  } catch {
    return []
  }
}

export function readJson<T = any>(path: string): T | null {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as T
  } catch {
    return null
  }
}

/** tsconfig.json allows comments and trailing commas. */
export function stripJsonComments(s: string) {
  let out = ""
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      out += ch
      if (ch === "\\") out += s[++i] ?? ""
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
      out += ch
    } else if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++
      out += "\n"
    } else if (ch === "/" && s[i + 1] === "*") {
      i += 2
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++
      i++
    } else out += ch
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

export async function readText(path: string) {
  return readFile(path, "utf8")
}

export const exists = (p: string) => existsSync(p)
export const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number) {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
