/** A SQL statement with its position in the file and any `migraguard-ignore` directives. */
export type Statement = { sql: string; line: number; ignores: Set<string>; text: string }

/**
 * Splits PostgreSQL into statements, respecting quotes, dollar-quoted bodies, comments and
 * BEGIN ... END blocks. `sql` is a normalised form for matching (comments removed, whitespace
 * collapsed, string contents blanked); `text` is the original.
 */
export function splitStatements(input: string): Statement[] {
  const out: Statement[] = []
  let buf = ""
  let norm = ""
  let start = -1
  let line = 1
  let startLine = 1
  let ignores = new Set<string>()
  let i = 0
  const flush = () => {
    const sql = norm.replace(/\s+/g, " ").trim()
    if (sql) out.push({ sql, line: startLine, ignores, text: buf.trim() })
    buf = ""
    norm = ""
    start = -1
    ignores = new Set()
  }
  const mark = () => {
    if (start === -1) {
      start = i
      startLine = line
    }
  }
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (ch === "\n") line++
    // Line comment (may carry an ignore directive).
    if (ch === "-" && next === "-") {
      const end = input.indexOf("\n", i)
      const comment = input.slice(i, end === -1 ? input.length : end)
      const m = comment.match(/migraguard[- ]ignore(?::|\s)\s*([\w/,\s-]+)/i)
      if (m) for (const r of m[1]!.split(/[,\s]+/).filter(Boolean)) ignores.add(r)
      else if (/migraguard[- ]ignore\b/i.test(comment)) ignores.add("*")
      buf += comment
      i = end === -1 ? input.length : end
      continue
    }
    if (ch === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2)
      const comment = input.slice(i, end === -1 ? input.length : end + 2)
      line += (comment.match(/\n/g) ?? []).length
      buf += comment
      norm += " "
      i = end === -1 ? input.length : end + 2
      continue
    }
    if (ch === "'" || (ch === "E" && next === "'") || ch === '"') {
      mark()
      const q = ch === '"' ? '"' : "'"
      let j = ch === "E" ? i + 2 : i + 1
      while (j < input.length) {
        if (input[j] === "\\" && ch === "E") j += 2
        else if (input[j] === q && input[j + 1] === q) j += 2
        else if (input[j] === q) break
        else j++
      }
      const lit = input.slice(i, j + 1)
      line += (lit.match(/\n/g) ?? []).length
      buf += lit
      // Identifiers keep their text; string literals become '' so they never match rules.
      norm += q === '"' ? lit : "''"
      i = j + 1
      continue
    }
    if (ch === "$") {
      const tag = input.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (tag) {
        mark()
        const end = input.indexOf(tag[0], i + tag[0].length)
        const body = input.slice(i, end === -1 ? input.length : end + tag[0].length)
        line += (body.match(/\n/g) ?? []).length
        buf += body
        norm += " $BODY$ "
        i += body.length
        continue
      }
    }
    if (ch === ";") {
      flush()
      i++
      continue
    }
    if (!/\s/.test(ch)) mark()
    buf += ch
    norm += ch
    i++
  }
  flush()
  return out
}

/** Strips quotes and schema prefix: "public"."Users" → users. */
export function ident(s: string): string {
  const parts = s.split(".")
  const last = parts[parts.length - 1]!
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase()
}

export const IDENT = String.raw`(?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?`
