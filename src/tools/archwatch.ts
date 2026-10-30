import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { isDir } from "../core/fs.js"
import { anyGlob, globMatch } from "../core/glob.js"
import { buildGraph, findCycles, toDot, toMermaid, type ImportGraph } from "../core/imports.js"
import { UsageError, type Finding, type Severity, type ToolDef, type ToolResult } from "../core/types.js"

/**
 * ArchWatch: write down which parts of the codebase may depend on which, and fail CI when an
 * import crosses a line. Rules refer to layers (named groups of globs) or to globs directly.
 */

export type LayerRule = {
  /** A layer name or glob for the importing files. */
  from: string
  /** Only these layers/globs may be imported (the same layer is always allowed). */
  allow?: string[]
  /** These layers/globs may not be imported. */
  disallow?: string[]
  /** With globs containing *, allow imports where the * matches the same name (e.g. a feature importing itself). */
  allowSameMatch?: boolean
  severity?: Severity
  message?: string
}
export type ForbiddenRule = { from?: string | string[]; import: string | string[]; message?: string; severity?: Severity; allowTypeOnly?: boolean }
export type ModuleRule = { module: string; entry?: string[]; message?: string; severity?: Severity }

export type ArchConfig = {
  include?: string[]
  ignore?: string[]
  layers?: Record<string, string | string[]>
  rules?: LayerRule[]
  forbidden?: ForbiddenRule[]
  /** Folders whose internals may only be reached through their entry files. */
  modules?: ModuleRule[]
  cycles?: Severity | "off"
  includeTypeOnly?: boolean
}

export function validateConfig(cfg: ArchConfig): string[] {
  const errors: string[] = []
  const layers = cfg.layers ?? {}
  const known = (ref: string) => ref in layers || ref.includes("/") || ref.includes("*")
  for (const [i, r] of (cfg.rules ?? []).entries()) {
    if (!r.from) errors.push(`rules[${i}] needs "from"`)
    else if (!known(r.from)) errors.push(`rules[${i}].from: "${r.from}" is not a layer (layers: ${Object.keys(layers).join(", ") || "none"}) or a path glob`)
    if (!r.allow && !r.disallow) errors.push(`rules[${i}] needs "allow" or "disallow"`)
    for (const ref of [...(r.allow ?? []), ...(r.disallow ?? [])]) if (!known(ref)) errors.push(`rules[${i}]: "${ref}" is not a layer or a path glob`)
  }
  for (const [i, f] of (cfg.forbidden ?? []).entries()) if (!f.import) errors.push(`forbidden[${i}] needs "import"`)
  for (const [i, m] of (cfg.modules ?? []).entries()) if (!m.module) errors.push(`modules[${i}] needs "module"`)
  if (cfg.cycles && !["error", "warning", "info", "off"].includes(cfg.cycles)) errors.push('cycles must be "error", "warning", "info" or "off"')
  return errors
}

export function layerOf(file: string, layers: Record<string, string | string[]>): string | null {
  for (const [name, globs] of Object.entries(layers)) if (anyGlob(globs, file)) return name
  return null
}

/** Does `file` belong to `ref` (a layer name or a glob)? Returns the glob captures when it does. */
function belongs(file: string, ref: string, layers: Record<string, string | string[]>): string[] | null {
  if (ref in layers) return layerOf(file, layers) === ref ? [] : null
  const m = globMatch(ref, file)
  return m ? m.slice(1) : null
}

export type Violation = Finding & { from: string; to: string; kind: "layer" | "forbidden" | "module" | "cycle" }

export function checkArchitecture(graph: ImportGraph, cfg: ArchConfig): { violations: Violation[]; layerEdges: Map<string, { count: number; bad: number }> } {
  const layers = cfg.layers ?? {}
  const violations: Violation[] = []
  const layerEdges = new Map<string, { count: number; bad: number }>()
  const typeOk = (typeOnly: boolean) => typeOnly && !cfg.includeTypeOnly

  for (const [from, edges] of graph.edges) {
    const fromLayer = layerOf(from, layers)
    for (const e of edges) {
      const toLayer = layerOf(e.to, layers)
      let bad = false
      if (fromLayer && toLayer && fromLayer !== toLayer) {
        const key = `${fromLayer}→${toLayer}`
        const stat = layerEdges.get(key) ?? { count: 0, bad: 0 }
        stat.count++
        layerEdges.set(key, stat)
      }
      if (!typeOk(e.typeOnly)) {
        for (const rule of cfg.rules ?? []) {
          const caps = belongs(from, rule.from, layers)
          if (!caps) continue
          if (rule.from in layers && toLayer === rule.from) continue
          const targetCaps = (ref: string) => belongs(e.to, ref, layers)
          const same = (ref: string) => {
            const t = targetCaps(ref)
            return rule.allowSameMatch && t && caps.length && t.length && t.join("/") === caps.join("/")
          }
          let reason: string | null = null
          if (rule.allow) {
            const ok = rule.allow.some((ref) => targetCaps(ref)) || (!(rule.from in layers) && targetCaps(rule.from) && (rule.allowSameMatch ? same(rule.from) : true))
            // Imports of files outside every layer are only checked when the rule uses globs.
            if (!ok && (toLayer || !Object.keys(layers).length || !(rule.from in layers))) reason = `${describe(rule.from, layers)} may only import ${rule.allow.length ? rule.allow.join(", ") : "itself"}`
          }
          if (!reason && rule.disallow) {
            const hit = rule.disallow.find((ref) => targetCaps(ref) && !same(ref))
            if (hit) reason = `${describe(rule.from, layers)} must not import ${describe(hit, layers)}`
          }
          if (reason) {
            bad = true
            violations.push({ kind: "layer", from, to: e.to, rule: "boundary", severity: rule.severity ?? "error", message: `${from} imports ${e.to}: ${rule.message ?? reason}`, file: from, line: e.line })
            break
          }
        }
        for (const m of cfg.modules ?? []) {
          const target = globMatch(m.module, e.to)
          if (!target) continue
          const source = globMatch(m.module, from)
          if (source && source.slice(1).join("/") === target.slice(1).join("/")) continue
          const rootDir = moduleDir(m.module, target)
          const inner = e.to.slice(rootDir.length + 1)
          const entries = m.entry ?? ["index.ts", "index.tsx", "index.js", "index.mjs", "public.ts", "api.ts"]
          if (!entries.includes(inner)) {
            bad = true
            violations.push({ kind: "module", from, to: e.to, rule: "module-internals", severity: m.severity ?? "error", message: `${from} reaches into ${rootDir} internals (${inner})${m.message ? `: ${m.message}` : ""}`, file: from, line: e.line, hint: `Import from ${rootDir}/${entries[0]} instead, and export what you need there.` })
          }
        }
      }
      if (bad && fromLayer && toLayer && fromLayer !== toLayer) layerEdges.get(`${fromLayer}→${toLayer}`)!.bad++
    }
  }

  // Forbidden imports: packages or paths, by importer glob.
  for (const f of cfg.forbidden ?? []) {
    const targets = Array.isArray(f.import) ? f.import : [f.import]
    for (const [pkg, refs] of graph.packages) {
      if (!targets.some((t) => t === pkg || globMatch(t, pkg))) continue
      for (const r of refs) {
        if (f.from && !anyGlob(f.from, r.file)) continue
        if (f.allowTypeOnly && r.typeOnly) continue
        violations.push({ kind: "forbidden", from: r.file, to: pkg, rule: "forbidden-import", severity: f.severity ?? "error", message: `${r.file} imports ${pkg}${f.message ? `: ${f.message}` : ", which is forbidden here"}`, file: r.file, line: r.line })
      }
    }
    for (const [from, edges] of graph.edges) {
      if (f.from && !anyGlob(f.from, from)) continue
      for (const e of edges) {
        if (f.allowTypeOnly && e.typeOnly) continue
        if (targets.some((t) => (t.includes("/") || t.includes("*")) && globMatch(t, e.to))) violations.push({ kind: "forbidden", from, to: e.to, rule: "forbidden-import", severity: f.severity ?? "error", message: `${from} imports ${e.to}${f.message ? `: ${f.message}` : ", which is forbidden here"}`, file: from, line: e.line })
      }
    }
    // Builtins (node:fs etc.) aren't packages, so check specifiers directly.
    if (targets.some((t) => t.startsWith("node:") || ["fs", "path", "child_process", "os", "crypto", "net", "http"].includes(t))) {
      for (const [from, edges] of rawSpecifiers(graph)) {
        if (f.from && !anyGlob(f.from, from)) continue
        for (const s of edges) if (targets.some((t) => t === s.spec || t === `node:${s.spec}` || (t.endsWith("*") && s.spec.startsWith(t.slice(0, -1))))) violations.push({ kind: "forbidden", from, to: s.spec, rule: "forbidden-import", severity: f.severity ?? "error", message: `${from} imports ${s.spec}${f.message ? `: ${f.message}` : ", which is forbidden here"}`, file: from, line: s.line })
      }
    }
  }

  if (cfg.cycles !== "off") {
    for (const c of findCycles(graph, { includeTypeOnly: cfg.includeTypeOnly })) {
      const edge = graph.edges.get(c.cycle[0]!)?.find((e) => e.to === c.cycle[1])
      violations.push({ kind: "cycle", from: c.cycle[0]!, to: c.cycle[1]!, rule: "circular-import", severity: cfg.cycles ?? "error", message: `Import cycle: ${c.cycle.join(" → ")}${c.members.length > c.cycle.length - 1 ? ` (${c.members.length} files involved)` : ""}`, file: c.cycle[0], line: edge?.line, hint: "Extract the shared part into a module both can depend on." })
    }
  }
  return { violations, layerEdges }
}

function moduleDir(glob: string, match: RegExpMatchArray): string {
  // Rebuild the concrete module folder by substituting captures into the glob.
  let i = 1
  return glob.replace(/^\.\//, "").replace(/\*\*.*$/, "").replace(/\*/g, () => match[i++] ?? "").replace(/\/$/, "")
}

const describe = (ref: string, layers: Record<string, unknown>) => (ref in layers ? `layer "${ref}"` : ref)

/** Builtin specifiers aren't kept in the graph, so re-read them for forbidden-builtin rules. */
function rawSpecifiers(graph: ImportGraph): Map<string, { spec: string; line: number }[]> {
  const out = new Map<string, { spec: string; line: number }[]>()
  for (const [file, list] of (graph as ImportGraph & { builtins?: Map<string, { spec: string; line: number }[]> }).builtins ?? new Map()) out.set(file, list)
  return out
}

/** A starting config from the folders under src/ (or the root): one layer each, cycles on. */
export function suggestConfig(root: string): ArchConfig {
  const base = isDir(join(root, "src")) ? "src" : "."
  const dirs = readdirSync(join(root, base), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "dist", "build", "test", "tests", "__tests__", "coverage", "public"].includes(e.name))
    .map((e) => e.name)
  const layers = Object.fromEntries(dirs.map((d) => [d, `${base === "." ? "" : `${base}/`}${d}/**`]))
  const common = dirs.filter((d) => /^(lib|utils?|shared|common|core|types|helpers|config)$/.test(d))
  const rules: LayerRule[] = dirs.filter((d) => common.includes(d)).map((d) => ({ from: d, allow: common.filter((c) => c !== d), message: "shared code can't depend on features" }))
  return { include: [base === "." ? "." : base], layers, rules, forbidden: [], modules: [], cycles: "error" }
}

async function loadGraph(root: string, cfg: ArchConfig) {
  const graph = await buildGraph(root, { include: cfg.include, ignore: cfg.ignore })
  // Keep builtin specifiers for forbidden rules like { import: "node:*" } on browser code.
  const builtins = new Map<string, { spec: string; line: number }[]>()
  const { extractImports, isBuiltin } = await import("../core/imports.js")
  const { readText } = await import("../core/fs.js")
  if ((cfg.forbidden ?? []).length) {
    for (const f of graph.files) {
      try {
        const refs = extractImports(await readText(join(root, f)), f).filter((r) => isBuiltin(r.specifier))
        if (refs.length) builtins.set(f, refs.map((r) => ({ spec: r.specifier.replace(/^node:/, ""), line: r.line })))
      } catch {}
    }
  }
  return Object.assign(graph, { builtins })
}

export const archwatch: ToolDef = {
  name: "archwatch",
  tagline: "Enforce architecture boundaries and catch circular imports",
  commands: {
    check: {
      description: "Check imports against your layer, forbidden-import and module rules",
      usage: "[dir]",
      options: { "type-only": { type: "boolean", description: "Also check type-only imports" } },
      async run(ctx): Promise<ToolResult> {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        const cfg = { ...(ctx.config as ArchConfig) }
        if (ctx.options["type-only"]) cfg.includeTypeOnly = true
        const errors = validateConfig(cfg)
        if (errors.length) throw new UsageError(`Invalid archwatch config:\n  ${errors.join("\n  ")}`)
        const configured = Boolean(cfg.rules?.length || cfg.forbidden?.length || cfg.modules?.length)
        ctx.log("Building the import graph…")
        const graph = await loadGraph(root, cfg)
        const { violations, layerEdges } = checkArchitecture(graph, cfg)
        const findings: Finding[] = violations.map(({ kind: _k, from: _f, to: _t, ...f }) => f)
        if (!configured) findings.push({ rule: "no-rules", severity: "info", message: "No architecture rules configured, so only import cycles were checked", hint: 'Run "archwatch init" for a starting config.' })
        for (const u of graph.unresolved.slice(0, 50)) findings.push({ rule: "unresolved-import", severity: "warning", message: `${u.specifier} doesn't resolve to a file`, file: u.file, line: u.line })
        const layerNames = Object.keys(cfg.layers ?? {})
        const unlayered = layerNames.length ? graph.files.filter((f) => !layerOf(f, cfg.layers!)).length : 0
        return {
          tool: "archwatch",
          title: "ArchWatch: architecture boundaries",
          summary: { files: graph.files.length, layers: layerNames.length, violations: violations.filter((v) => v.kind !== "cycle").length, cycles: violations.filter((v) => v.kind === "cycle").length, ...(layerNames.length ? { "outside any layer": unlayered } : {}) },
          sections: layerEdges.size
            ? [{ kind: "table", title: "Dependencies between layers", headers: ["From", "To", "Imports", "Violations"], rows: [...layerEdges].sort((a, b) => b[1].bad - a[1].bad || b[1].count - a[1].count).map(([k, v]) => [...k.split("→"), v.count, v.bad]) }]
            : [],
          findings,
        }
      },
    },
    graph: {
      description: "Print the layer graph (or the file graph) as Mermaid or Graphviz; violations in red",
      usage: "[dir] [--files] [--graph-format mermaid|dot]",
      options: { files: { type: "boolean", description: "Graph files instead of layers" }, "graph-format": { type: "string", description: "mermaid or dot (default: mermaid)" } },
      async run(ctx) {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        const cfg = ctx.config as ArchConfig
        const graph = await loadGraph(root, cfg)
        const { violations, layerEdges } = checkArchitecture(graph, cfg)
        const format = (ctx.options["graph-format"] as string) ?? "mermaid"
        if (format !== "mermaid" && format !== "dot") throw new UsageError("--graph-format must be mermaid or dot")
        let edges: [string, string][]
        let highlight = new Set<string>()
        if (ctx.options.files || !Object.keys(cfg.layers ?? {}).length) {
          edges = [...graph.edges].flatMap(([from, es]) => es.map((e) => [from, e.to] as [string, string]))
          highlight = new Set(violations.flatMap((v) => [v.from]))
        } else {
          edges = [...layerEdges.keys()].map((k) => k.split("→") as [string, string])
          highlight = new Set([...layerEdges].filter(([, v]) => v.bad).flatMap(([k]) => k.split("→")))
        }
        const text = format === "dot" ? toDot(edges, { name: "architecture", highlight }) : toMermaid(edges, { highlight, direction: "TD" })
        return { tool: "archwatch", title: "ArchWatch graph", summary: {}, findings: [], raw: text, sections: [{ kind: "code", title: "Graph", language: format, body: text }] }
      },
    },
    init: {
      description: "Suggest a starting config from your folder structure",
      usage: "[dir]",
      async run(ctx) {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        const suggestion = suggestConfig(root)
        const text = JSON.stringify({ archwatch: suggestion }, null, 2)
        return { tool: "archwatch", title: "ArchWatch: suggested config", summary: {}, findings: [], raw: `// Add to devdoctor.config.json, then tighten the rules:\n${text}`, sections: [{ kind: "code", title: "devdoctor.config.json", language: "json", body: text }] }
      },
    },
  },
}
