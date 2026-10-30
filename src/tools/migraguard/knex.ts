import { lineOf } from "../../core/fs.js"
import { stripComments } from "../../core/imports.js"
import { analyzeSql, type AnalyzeOptions, type Issue } from "./rules.js"

/**
 * Knex migrations are code, so this is a static, pattern-based reading of the schema builder:
 * it understands the common calls (createTable/alterTable/dropTable, column chains, raw SQL)
 * and analyses raw SQL with the same rules as .sql files.
 */
export function analyzeKnex(source: string, opts: AnalyzeOptions = {}): { issues: Issue[]; created: Set<string> } {
  const code = stripComments(source, { keepStrings: true })
  const issues: Issue[] = []
  const created = new Set<string>()
  const noTransaction = /config\s*=\s*\{[^}]*transaction\s*:\s*false/.test(code)
  const up = upBody(code)
  if (!up) return { issues, created }
  const { start, body } = up
  const isNew = (t: string) => created.has(t) || opts.newTables?.has(t) === true
  const add = (rule: string, severity: Issue["severity"], message: string, hint: string, offset: number, table?: string) => {
    const line = lineOf(source, start + offset)
    const srcLine = source.split("\n")[line - 1] ?? ""
    const prevLine = source.split("\n")[line - 2] ?? ""
    if (/migraguard[- ]ignore/i.test(srcLine + prevLine) && (new RegExp(`\\b${rule}\\b`).test(srcLine + prevLine) || !/migraguard[- ]ignore[: ]\s*[\w-]/i.test(srcLine + prevLine))) return
    issues.push({ rule, severity, message, hint, line, statement: srcLine.trim(), table })
  }

  for (const m of body.matchAll(/\.createTable(?:IfNotExists)?\(\s*['"`]([\w.]+)['"`]/g)) created.add(m[1]!.split(".").pop()!.toLowerCase())

  for (const m of body.matchAll(/\.dropTable(?:IfExists)?\(\s*['"`]([\w.]+)['"`]/g)) add("drop-table", "error", `Drops table ${m[1]} and all its data`, "Deploy code that no longer uses it first, and back up the data.", m.index!, m[1])
  for (const m of body.matchAll(/\.renameTable\(\s*['"`]([\w.]+)['"`]\s*,\s*['"`]([\w.]+)['"`]/g)) add("rename-table", "warning", `Renames table ${m[1]} to ${m[2]}`, "The running app version breaks until it's replaced. Rename across two releases.", m.index!, m[1])

  // alterTable('x', (t) => { ... }) and table('x', ...)
  for (const m of body.matchAll(/\.(alterTable|table)\(\s*['"`]([\w.]+)['"`]\s*,/g)) {
    const table = m[2]!.split(".").pop()!.toLowerCase()
    const blockStart = m.index! + m[0].length
    const block = balanced(body, blockStart)
    const fresh = isNew(table)
    for (const chain of chains(block)) {
      const at = blockStart + chain.offset
      const c = chain.text
      const col = c.match(/^\s*\w+\.\w+\(\s*['"`](\w+)['"`]/)?.[1] ?? "column"
      if (/\.dropColumns?\(/.test(c)) add("drop-column", "error", `Drops ${table}.${c.match(/dropColumns?\(\s*['"`](\w+)/)?.[1] ?? "columns"}`, "Deploy code that no longer reads or writes it first; drop it in a later migration.", at, table)
      else if (/\.renameColumn\(/.test(c)) add("rename-column", "warning", `Renames a column on ${table}`, "Add the new column, dual-write, backfill, switch reads, then drop the old one.", at, table)
      else if (/\.alter\(\s*(\{[^}]*\})?\s*\)/.test(c)) {
        if (!fresh) add("change-column-type", "warning", `Alters ${table}.${col}, which may rewrite the table under an exclusive lock`, "Changing type or nullability on a big table blocks it; prefer add-backfill-swap.", at, table)
        if (/\.notNullable\(\)/.test(c) && !fresh) add("set-not-null", "warning", `Sets ${table}.${col} NOT NULL, scanning the table under an exclusive lock`, "Add a CHECK ... NOT VALID constraint and validate it first.", at, table)
      } else if (/\.notNullable\(\)/.test(c) && !/\.defaultTo\(/.test(c) && /^\s*\w+\.(string|text|integer|bigInteger|boolean|uuid|date|datetime|timestamp|decimal|float|double|json|jsonb|enum|enu|specificType|smallint|tinyint|binary)\(/.test(c) && !fresh) {
        add("not-null-without-default", "error", `Adds NOT NULL column ${table}.${col} without a default`, "Fails on a non-empty table. Add .defaultTo(...), or add it nullable, backfill, then make it not null.", at, table)
      }
      if (!fresh && /\.defaultTo\(\s*knex\.(fn\.now\(\)|raw\(\s*['"`](now\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\)))/.test(c) && !/\.alter\(/.test(c)) add("volatile-default", "warning", `Adds ${table}.${col} with a volatile default, rewriting the table under an exclusive lock`, "Add the column without a default, then backfill.", at, table)
      if (!fresh && /^\s*\w+\.(index)\(/.test(c)) add("index-without-concurrently", "warning", `Creating an index on ${table} blocks writes until it finishes`, "Use knex.raw('CREATE INDEX CONCURRENTLY ...') in a migration with config = { transaction: false }.", at, table)
      if (!fresh && (/^\s*\w+\.(unique|primary)\(/.test(c) || /\.(unique|primary)\(\)/.test(c))) add("add-unique-constraint", "warning", `Adding a unique/primary constraint on ${table} builds an index under an exclusive lock`, "Create the unique index CONCURRENTLY first.", at, table)
      if (!fresh && (/^\s*\w+\.foreign\(/.test(c) || /\.references\(/.test(c))) add("foreign-key-validation", "warning", `Adding a foreign key on ${table} validates every row while locking both tables`, "Add it with knex.raw(... NOT VALID) and VALIDATE separately on big tables.", at, table)
      if (/^\s*\w+\.dropIndex\(/.test(c)) add("drop-index-without-concurrently", "warning", `Dropping an index on ${table} takes an exclusive lock`, "Use DROP INDEX CONCURRENTLY via knex.raw.", at, table)
    }
  }

  // Query builder data changes: knex('t').del() / .update(...)
  for (const st of statementsOf(body)) {
    const t = st.text.match(/\bknex\(\s*['"`]([\w.]+)['"`]\s*\)/)?.[1]
    if (!t) continue
    const hasWhere = /\.where\w*\(/.test(st.text)
    if (/\.(del|delete)\(\s*\)/.test(st.text) && !hasWhere) add("delete-without-where", "error", `Deletes every row from ${t}`, "Add a where clause.", st.offset, t)
    else if (/\.truncate\(\s*\)/.test(st.text)) add("truncate", "error", `Truncates ${t}`, "Keep data resets out of production migrations.", st.offset, t)
    else if (/\.update\(/.test(st.text) && !hasWhere && !isNew(t.toLowerCase())) add("update-without-where", "warning", `Rewrites every row of ${t} in one transaction`, "Backfill in batches outside the migration.", st.offset, t)
  }

  // Raw SQL goes through the SQL rules.
  for (const m of body.matchAll(/\.raw\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
    if (m[1] === "`" && m[2]!.includes("${")) continue
    const sqlStart = m.index! + m[0].indexOf(m[1]!) + 1
    const res = analyzeSql(m[2]!, { ...opts, newTables: new Set([...created, ...(opts.newTables ?? [])]), wrappedInTransaction: !noTransaction })
    for (const i of res.issues) if (i.rule !== "missing-lock-timeout") issues.push({ ...i, line: lineOf(source, start + sqlStart) + i.line - 1 })
    for (const t of res.created) created.add(t)
  }
  return { issues, created }
}

function upBody(code: string): { start: number; body: string } | null {
  const m = code.match(/(?:exports\.up\s*=|export\s+(?:async\s+)?function\s+up\b|export\s+const\s+up\s*=|\bup\s*:\s*(?:async\s*)?(?:function\b|\())/)
  if (!m) return null
  const start = m.index! + m[0].length
  const rest = code.slice(start)
  const down = rest.search(/(?:exports\.down\s*=|export\s+(?:async\s+)?function\s+down\b|export\s+const\s+down\s*=|\bdown\s*:\s*(?:async\s*)?(?:function\b|\())/)
  return { start, body: down === -1 ? rest : rest.slice(0, down) }
}

/** Text up to the parenthesis that closes the call we're inside. */
function balanced(s: string, from: number) {
  let depth = 1
  let quote: string | null = null
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if (ch === "(" || ch === "{" || ch === "[") depth++
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--
      if (depth === 0) return s.slice(from, i)
    }
  }
  return s.slice(from)
}

/** Column-builder chains inside an alterTable callback: `t.string('x').notNullable()`. */
function chains(block: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = []
  const inner = block.indexOf("{")
  const body = inner === -1 ? block : block.slice(inner + 1)
  const base = inner === -1 ? 0 : inner + 1
  for (const st of statementsOf(body)) out.push({ text: st.text.trim(), offset: base + st.offset + (st.text.length - st.text.trimStart().length) })
  return out
}

function statementsOf(s: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch
    else if ("([{".includes(ch)) depth++
    else if (")]}".includes(ch)) depth--
    else if ((ch === ";" || ch === "\n") && depth <= 0) {
      // A newline ends a statement only when the next line doesn't continue the chain.
      if (ch === "\n" && /^\s*\./.test(s.slice(i + 1, i + 40))) continue
      if (s.slice(start, i).trim()) out.push({ text: s.slice(start, i), offset: start })
      start = i + 1
    }
  }
  if (s.slice(start).trim()) out.push({ text: s.slice(start), offset: start })
  return out
}
