import { builtinModules } from "node:module"
import { dirname, join, normalize, relative } from "node:path"
import { exists, isDir, readJson, readText, toPosix, walk } from "./fs.js"

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".json", ".d.ts"]
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

export type ImportRef = { specifier: string; line: number; typeOnly: boolean; kind: "static" | "dynamic" | "require" | "reexport" | "side-effect" }

/**
 * Blanks out comments, regex literals and the contents of strings and template literals,
 * keeping offsets and newlines. Strings that are module specifiers (right after `from`,
 * `import`, `require(` or `import(`) are kept, so only real imports survive: an import
 * statement inside a string (a code sample, a test fixture) or a regex is ignored.
 */
export function stripComments(src: string, opts: { keepStrings?: boolean } = {}): string {
  const out = src.split("")
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < src.length; k++) if (out[k] !== "\n") out[k] = " "
  }
  /** The last significant character before i, ignoring whitespace and blanked text. */
  const prevSignificant = (i: number) => {
    let j = i - 1
    while (j >= 0 && /\s/.test(out[j]!)) j--
    return { ch: j >= 0 ? out[j]! : "", word: out.slice(Math.max(0, j - 12), j + 1).join("").match(/[\w$]+$/)?.[0] ?? "" }
  }
  const isSpecifierPosition = (i: number) => /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/.test(out.slice(Math.max(0, i - 40), i).join(""))
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i)
      blank(i, end === -1 ? src.length : end)
      i = end === -1 ? src.length : end
      continue
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      blank(i, end === -1 ? src.length : end + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1
      if (!opts.keepStrings && !isSpecifierPosition(i)) blank(i + 1, j)
      i = j + 1
      continue
    }
    if (ch === "`") {
      // Template literals are text; their ${ } expressions are code and are kept.
      const keep = opts.keepStrings || isSpecifierPosition(i)
      i++
      let depth = 0
      while (i < src.length) {
        const c = src[i]!
        if (depth === 0) {
          if (c === "\\") {
            if (!keep) blank(i, i + 2)
            i += 2
            continue
          }
          if (c === "`") break
          if (c === "$" && src[i + 1] === "{") {
            depth = 1
            i += 2
            continue
          }
          if (!keep) blank(i, i + 1)
          i++
        } else {
          if (c === "{") depth++
          else if (c === "}") depth--
          i++
        }
      }
      i++
      continue
    }
    if (ch === "/") {
      // A regex literal can follow an operator, an opening bracket, or keywords like return.
      const p = prevSignificant(i)
      if (!p.ch || /[(,=:[!&|?{};+\-*%<>~^]/.test(p.ch) || /^(return|typeof|case|do|else|in|of|void|yield|await)$/.test(p.word)) {
        let j = i + 1
        let inClass = false
        while (j < src.length && src[j] !== "\n") {
          const c = src[j]!
          if (c === "\\") {
            j += 2
            continue
          }
          if (c === "[") inClass = true
          else if (c === "]") inClass = false
          else if (c === "/" && !inClass) break
          j++
        }
        if (src[j] === "/") {
          if (!opts.keepStrings) blank(i, j + 1)
          i = j + 1
          continue
        }
      }
    }
    i++
  }
  return out.join("")
}

const lineAt = (s: string, idx: number) => {
  let n = 1
  for (let i = 0; i < idx; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** Extracts every module reference from JS/TS source. Vue/Svelte: only the <script> blocks. */
export function extractImports(source: string, file = ""): ImportRef[] {
  let src = source
  if (file.endsWith(".vue") || file.endsWith(".svelte")) {
    // Keep offsets: blank everything outside <script> blocks.
    src = source.replace(/([\s\S]*?)(<script[^>]*>[\s\S]*?<\/script>|$)/g, (_, before: string, script: string) => before.replace(/[^\n]/g, " ") + script)
  }
  const code = stripComments(src)
  const refs: ImportRef[] = []
  const add = (specifier: string, idx: number, kind: ImportRef["kind"], typeOnly = false) => refs.push({ specifier, line: lineAt(code, idx), typeOnly, kind })

  const patterns: [RegExp, (m: RegExpExecArray) => void][] = [
    [/\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*(['"])([^'"\n]+)\3/g, (m) => add(m[4]!, m.index, "static", Boolean(m[1]) || allTypeSpecifiers(m[2]!))],
    [/\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g, (m) => add(m[4]!, m.index, "reexport", Boolean(m[1]) || allTypeSpecifiers(m[2]!))],
    [/(^|[^.\w$])import\s*(['"])([^'"\n]+)\2/g, (m) => add(m[3]!, m.index + m[1]!.length, "side-effect")],
    [/(^|[^.\w$])import\s*\(\s*(['"`])([^'"`\n$]+)\2\s*\)/g, (m) => add(m[3]!, m.index + m[1]!.length, "dynamic")],
    [/(^|[^.\w$])require\s*\(\s*(['"`])([^'"`\n$]+)\2\s*\)/g, (m) => add(m[3]!, m.index + m[1]!.length, "require")],
    // `import x = require("y")` (TS)
    [/\bimport\s+[\w$]+\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, (m) => add(m[2]!, m.index, "require")],
    // Type-position imports: `typeof import("x")`, `import("x").Foo`
    [/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)\s*\./g, (m) => add(m[2]!, m.index, "dynamic", true)],
  ]
  for (const [re, fn] of patterns) for (let m; (m = re.exec(code)); ) fn(m)
  // De-duplicate identical refs on the same line (the type-position pattern overlaps dynamic import).
  const seen = new Map<string, ImportRef>()
  for (const r of refs) {
    const key = `${r.specifier}:${r.line}`
    const prev = seen.get(key)
    if (!prev) seen.set(key, r)
    else if (r.typeOnly && r.kind === "dynamic") prev.typeOnly = true // `import("x").T` is a type position
  }
  return [...seen.values()]
}

function allTypeSpecifiers(clause: string) {
  const m = clause.match(/^\s*\{([^}]*)\}\s*$/)
  if (!m) return false
  const parts = m[1]!.split(",").map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((p) => p.startsWith("type "))
}

/** The npm package a bare specifier refers to, or null for relative/builtin/URL imports. */
export function packageName(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]!) || /^[a-z]+:/i.test(spec)) return null
  const parts = spec.split("/")
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  return parts[0] || null
}

export const isBuiltin = (spec: string) => BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]!)

type Paths = { baseUrl: string | null; paths: [RegExp, string[]][] }

/** Reads compilerOptions.baseUrl and paths, following one level of "extends". */
export function loadTsPaths(root: string): Paths {
  const read = (file: string, depth = 0): { baseUrl?: string; paths?: Record<string, string[]>; dir: string } => {
    const json = readJson(file)
    const dir = dirname(file)
    const own = { baseUrl: json?.compilerOptions?.baseUrl as string | undefined, paths: json?.compilerOptions?.paths as Record<string, string[]> | undefined, dir }
    if (json?.extends && depth < 3 && typeof json.extends === "string" && json.extends.startsWith(".")) {
      const parentFile = join(dir, json.extends.endsWith(".json") ? json.extends : `${json.extends}.json`)
      const parent = read(parentFile, depth + 1)
      return { baseUrl: own.baseUrl ?? parent.baseUrl, paths: own.paths ?? parent.paths, dir: own.baseUrl || own.paths ? dir : parent.dir }
    }
    return own
  }
  const cfg = exists(join(root, "tsconfig.json")) ? read(join(root, "tsconfig.json")) : exists(join(root, "jsconfig.json")) ? read(join(root, "jsconfig.json")) : null
  if (!cfg) return { baseUrl: null, paths: [] }
  const base = cfg.baseUrl ? join(cfg.dir, cfg.baseUrl) : cfg.dir
  const paths = Object.entries(cfg.paths ?? {}).map(([k, targets]) => {
    const re = new RegExp(`^${k.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "(.*)")}$`)
    return [re, targets.map((t) => join(base, t))] as [RegExp, string[]]
  })
  return { baseUrl: cfg.baseUrl ? base : null, paths }
}

function tryFile(abs: string): string | null {
  const candidates = [abs, ...RESOLVE_EXTENSIONS.map((e) => abs + e)]
  // ESM TypeScript writes `./x.js` for `./x.ts`.
  const m = abs.match(/\.(m|c)?jsx?$/)
  if (m) {
    const stem = abs.slice(0, -m[0].length)
    candidates.push(stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".cts")
  }
  for (const c of candidates) if (exists(c) && !isDir(c)) return c
  if (isDir(abs)) {
    const pkg = readJson(join(abs, "package.json"))
    if (pkg?.main || pkg?.module) {
      const r = tryFile(join(abs, pkg.module ?? pkg.main))
      if (r) return r
    }
    for (const e of RESOLVE_EXTENSIONS) if (exists(join(abs, `index${e}`))) return join(abs, `index${e}`)
  }
  return null
}

/** Resolves a specifier to a project file (absolute), or null if it's a package or unresolvable. */
export function resolveLocal(fromFile: string, spec: string, tsPaths: Paths): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return tryFile(normalize(spec.startsWith("/") ? spec : join(dirname(fromFile), spec)))
  for (const [re, targets] of tsPaths.paths) {
    const m = spec.match(re)
    if (!m) continue
    for (const t of targets) {
      const r = tryFile(t.replace("*", m[1] ?? ""))
      if (r) return r
    }
  }
  if (tsPaths.baseUrl && !packageName(spec)?.startsWith("@")) {
    const r = tryFile(join(tsPaths.baseUrl, spec))
    if (r) return r
  }
  return null
}

export type Edge = { to: string; line: number; typeOnly: boolean; specifier: string }
export type ImportGraph = {
  root: string
  files: string[]
  /** file → local files it imports (relative POSIX paths). */
  edges: Map<string, Edge[]>
  /** package name → files that import it. */
  packages: Map<string, { file: string; line: number; typeOnly: boolean }[]>
  /** Relative imports that point nowhere. */
  unresolved: { file: string; line: number; specifier: string }[]
}

export async function buildGraph(root: string, opts: { include?: string[]; ignore?: string[] } = {}): Promise<ImportGraph> {
  const files = (await walk(root, { extensions: SOURCE_EXTENSIONS, ignore: opts.ignore })).filter((f) => !f.endsWith(".d.ts") && (!opts.include?.length || opts.include.some((p) => f.startsWith(p.replace(/^\.\//, "").replace(/\/?\*.*$/, "")))))
  const tsPaths = loadTsPaths(root)
  const edges = new Map<string, Edge[]>()
  const packages: ImportGraph["packages"] = new Map()
  const unresolved: ImportGraph["unresolved"] = []
  for (const file of files) {
    const abs = join(root, file)
    let src: string
    try {
      src = await readText(abs)
    } catch {
      continue
    }
    const list: Edge[] = []
    for (const ref of extractImports(src, file)) {
      const local = resolveLocal(abs, ref.specifier, tsPaths)
      if (local) {
        list.push({ to: toPosix(relative(root, local)), line: ref.line, typeOnly: ref.typeOnly, specifier: ref.specifier })
        continue
      }
      const pkg = packageName(ref.specifier)
      if (pkg) {
        const arr = packages.get(pkg) ?? []
        arr.push({ file, line: ref.line, typeOnly: ref.typeOnly })
        packages.set(pkg, arr)
      } else if (ref.specifier.startsWith(".")) unresolved.push({ file, line: ref.line, specifier: ref.specifier })
    }
    edges.set(file, list)
  }
  return { root, files, edges, packages, unresolved }
}

/**
 * Import cycles: one shortest representative cycle per strongly connected component
 * (Tarjan), so a tangle of 30 files is reported once rather than thousands of times.
 */
export type Cycle = { cycle: string[]; members: string[] }

export function findCycles(graph: ImportGraph, opts: { includeTypeOnly?: boolean } = {}): Cycle[] {
  const adj = new Map<string, string[]>()
  for (const [from, es] of graph.edges) adj.set(from, [...new Set(es.filter((e) => opts.includeTypeOnly || !e.typeOnly).map((e) => e.to))].filter((t) => graph.edges.has(t)))

  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  // Iterative Tarjan to survive very deep graphs.
  for (const start of adj.keys()) {
    if (idx.has(start)) continue
    const work: [string, number][] = [[start, 0]]
    while (work.length) {
      const frame = work[work.length - 1]!
      const [v, i] = frame
      if (i === 0) {
        idx.set(v, index)
        low.set(v, index)
        index++
        stack.push(v)
        onStack.add(v)
      }
      const next = adj.get(v) ?? []
      if (i < next.length) {
        frame[1]++
        const w = next[i]!
        if (!idx.has(w)) work.push([w, 0])
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
        continue
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
        } while (w !== v)
        if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) sccs.push(comp)
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1]![0]
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!))
      }
    }
  }

  return sccs.map((comp) => {
    const inComp = new Set(comp)
    const start = [...comp].sort()[0]!
    // BFS for the shortest path from start back to start inside the component.
    const prev = new Map<string, string>()
    const queue = [start]
    const seen = new Set([start])
    while (queue.length) {
      const v = queue.shift()!
      for (const w of adj.get(v) ?? []) {
        if (!inComp.has(w)) continue
        if (w === start) {
          const path = [v]
          let p = v
          while (p !== start) {
            p = prev.get(p)!
            path.push(p)
          }
          return { cycle: [...path.reverse(), start], members: [...comp].sort() }
        }
        if (!seen.has(w)) {
          seen.add(w)
          prev.set(w, v)
          queue.push(w)
        }
      }
    }
    return { cycle: [start, start], members: [start] }
  }).sort((a, b) => a.cycle.length - b.cycle.length || a.cycle[0]!.localeCompare(b.cycle[0]!))
}

/** Mermaid and Graphviz renderings for dependency graphs. */
export function toMermaid(edges: [string, string][], opts: { direction?: "LR" | "TD"; highlight?: Set<string> } = {}) {
  const ids = new Map<string, string>()
  const id = (n: string) => {
    if (!ids.has(n)) ids.set(n, `n${ids.size}`)
    return ids.get(n)!
  }
  const lines = [`graph ${opts.direction ?? "LR"}`]
  for (const [a, b] of edges) lines.push(`  ${id(a)}["${a}"] --> ${id(b)}["${b}"]`)
  for (const h of opts.highlight ?? []) if (ids.has(h)) lines.push(`  style ${ids.get(h)} stroke:#d33,stroke-width:2px`)
  return lines.join("\n")
}

export function toDot(edges: [string, string][], opts: { name?: string; highlight?: Set<string> } = {}) {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`
  const nodes = new Set(edges.flat())
  return [
    `digraph ${q(opts.name ?? "deps")} {`,
    "  rankdir=LR; node [shape=box, fontname=Helvetica, fontsize=10];",
    ...[...nodes].map((n) => `  ${q(n)}${opts.highlight?.has(n) ? " [color=red, penwidth=2]" : ""};`),
    ...edges.map(([a, b]) => `  ${q(a)} -> ${q(b)};`),
    "}",
  ].join("\n")
}
