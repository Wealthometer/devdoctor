import { c, width } from "./color.js"
import { SEVERITY_RANK, type Finding, type Section, type Severity, type ToolResult } from "./types.js"

export type Format = "text" | "json" | "markdown" | "sarif"
export const FORMATS: Format[] = ["text", "json", "markdown", "sarif"]

const ICON: Record<Severity, string> = { error: "✖", warning: "▲", info: "●" }
const paint: Record<Severity, (s: string) => string> = { error: c.red, warning: c.yellow, info: c.blue }

export function sortFindings(f: Finding[]) {
  return [...f].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0))
}

export function counts(f: Finding[]) {
  return { error: f.filter((x) => x.severity === "error").length, warning: f.filter((x) => x.severity === "warning").length, info: f.filter((x) => x.severity === "info").length }
}

const loc = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ""}` : ""}` : "")

function table(headers: string[], rows: (string | number)[][], indent = "  ") {
  const cells = rows.map((r) => r.map(String))
  const w = headers.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i] ?? ""))))
  const line = (r: string[]) => indent + r.map((v, i) => v + " ".repeat(Math.max(0, w[i]! - width(v)))).join("  ").trimEnd()
  return [line(headers.map((h) => c.dim(h))), ...cells.map(line)].join("\n")
}

export function renderText(r: ToolResult): string {
  const out: string[] = []
  out.push(`${c.bold(r.title)}`)
  const summary = Object.entries(r.summary)
  if (r.score !== undefined) {
    const s = r.score
    const col = s >= 85 ? c.green : s >= 65 ? c.yellow : c.red
    const bar = "█".repeat(Math.round(s / 5)) + c.gray("░".repeat(20 - Math.round(s / 5)))
    out.push(`  ${col(bar)} ${col(c.bold(`${s}/100`))}`)
  }
  if (summary.length) out.push(c.gray("  " + summary.map(([k, v]) => `${k}: ${c.bold(String(v))}`).join(c.gray("   "))))
  out.push("")

  for (const s of r.sections ?? []) out.push(renderSectionText(s), "")

  const sorted = sortFindings(r.findings)
  if (sorted.length) {
    for (const f of sorted) {
      const where = loc(f)
      out.push(`  ${paint[f.severity](ICON[f.severity])} ${f.message} ${c.gray(`[${f.rule}]`)}`)
      if (where) out.push(`    ${c.cyan(where)}`)
      if (f.hint) out.push(`    ${c.dim("→ " + f.hint)}`)
    }
    out.push("")
  }
  const n = counts(r.findings)
  out.push(
    sorted.length
      ? `  ${[n.error && c.red(`${n.error} error${n.error > 1 ? "s" : ""}`), n.warning && c.yellow(`${n.warning} warning${n.warning > 1 ? "s" : ""}`), n.info && c.blue(`${n.info} note${n.info > 1 ? "s" : ""}`)].filter(Boolean).join(", ")}`
      : `  ${c.green("✔")} No problems found`,
  )
  return out.join("\n") + "\n"
}

function renderSectionText(s: Section): string {
  const head = `  ${c.bold(s.title)}`
  switch (s.kind) {
    case "table":
      return s.rows.length ? `${head}\n${table(s.headers, s.rows, "    ")}` : `${head}\n    ${c.gray("none")}`
    case "list":
      return `${head}\n${s.items.length ? s.items.map((i) => `    • ${i}`).join("\n") : `    ${c.gray("none")}`}`
    case "text":
      return `${head}\n${s.body.split("\n").map((l) => `    ${l}`).join("\n")}`
    case "code":
      return `${head}\n${s.body.split("\n").map((l) => `    ${c.gray(l)}`).join("\n")}`
  }
}

const mdEscape = (s: string | number) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ")

export function renderMarkdown(r: ToolResult): string {
  const out: string[] = [`## ${r.title}`, ""]
  if (r.score !== undefined) out.push(`**Score: ${r.score}/100**`, "")
  const summary = Object.entries(r.summary)
  if (summary.length) out.push(summary.map(([k, v]) => `**${k}:** ${v}`).join(" · "), "")
  for (const s of r.sections ?? []) {
    out.push(`### ${s.title}`, "")
    if (s.kind === "table") {
      if (!s.rows.length) out.push("_None_")
      else out.push(`| ${s.headers.map(mdEscape).join(" | ")} |`, `| ${s.headers.map(() => "---").join(" | ")} |`, ...s.rows.map((row) => `| ${row.map(mdEscape).join(" | ")} |`))
    } else if (s.kind === "list") out.push(...(s.items.length ? s.items.map((i) => `- ${i}`) : ["_None_"]))
    else if (s.kind === "code") out.push("```" + s.language, s.body, "```")
    else out.push(s.body)
    out.push("")
  }
  const sorted = sortFindings(r.findings)
  if (sorted.length) {
    out.push("### Findings", "", "| | Problem | Where | Rule |", "| --- | --- | --- | --- |")
    for (const f of sorted) out.push(`| ${f.severity === "error" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵"} | ${mdEscape(f.message)}${f.hint ? `<br>_${mdEscape(f.hint)}_` : ""} | ${mdEscape(loc(f) || "–")} | \`${f.rule}\` |`)
  } else out.push("✅ No problems found")
  return out.join("\n") + "\n"
}

/** SARIF 2.1.0, so findings show up inline in GitHub code scanning. */
export function renderSarif(results: ToolResult[]): string {
  const runs = results.map((r) => {
    const rules = [...new Set(r.findings.map((f) => f.rule))]
    return {
      tool: { driver: { name: r.tool, rules: rules.map((id) => ({ id })) } },
      results: r.findings.map((f) => ({
        ruleId: f.rule,
        level: f.severity === "info" ? "note" : f.severity,
        message: { text: f.hint ? `${f.message} ${f.hint}` : f.message },
        ...(f.file ? { locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, ...(f.line ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } } : {}) } }] } : {}),
      })),
    }
  })
  return JSON.stringify({ $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs }, null, 2) + "\n"
}

export function render(r: ToolResult, format: Format): string {
  switch (format) {
    case "json":
      return JSON.stringify({ ...r, findings: sortFindings(r.findings), counts: counts(r.findings) }, null, 2) + "\n"
    case "markdown":
      return renderMarkdown(r)
    case "sarif":
      return renderSarif([r])
    default:
      return renderText(r)
  }
}

/** True when any finding is at or above the threshold. */
export function shouldFail(f: Finding[], failOn: Severity | "none") {
  if (failOn === "none") return false
  return f.some((x) => SEVERITY_RANK[x.severity] >= SEVERITY_RANK[failOn])
}
