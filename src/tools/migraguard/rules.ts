import type { Severity } from "../../core/types.js"
import { IDENT, ident, splitStatements, type Statement } from "./sql.js"

export type Issue = { rule: string; severity: Severity; message: string; hint: string; line: number; statement: string; table?: string }

export type AnalyzeOptions = {
  /** Tables created earlier in this batch of new migrations: lock-related rules don't apply to them. */
  newTables?: Set<string>
  /** The migration runner wraps each file in a transaction (Knex, Drizzle). */
  wrappedInTransaction?: boolean
  /** PostgreSQL major version you deploy to (some rules depend on it). */
  pgVersion?: number
}

const VOLATILE_DEFAULT = /\bDEFAULT\s+(?:\(?\s*)?(now\s*\(|current_timestamp\b|clock_timestamp|statement_timestamp|transaction_timestamp|random\s*\(|gen_random_uuid|uuid_generate_v[14]|nextval|timeofday)/i

/** Rules about lock duration, where a lock_timeout limits the blast radius. */
const LOCK_RULES = new Set(["index-without-concurrently", "drop-index-without-concurrently", "set-not-null", "change-column-type", "foreign-key-validation", "check-constraint-validation", "add-unique-constraint", "volatile-default", "stored-generated-column", "explicit-lock"])

/** Weight of each severity in the per-file risk score. */
export const RISK_POINTS: Record<Severity, number> = { error: 10, warning: 4, info: 1 }

export function riskLevel(points: number): "none" | "low" | "medium" | "high" {
  return points === 0 ? "none" : points < 4 ? "low" : points < 10 ? "medium" : "high"
}

/** Analyses one migration file's SQL. */
export function analyzeSql(source: string, opts: AnalyzeOptions = {}): { issues: Issue[]; statements: Statement[]; created: Set<string> } {
  const statements = splitStatements(source)
  const issues: Issue[] = []
  const created = new Set<string>()
  const pg = opts.pgVersion ?? 15
  let explicitTx = false
  let lockTimeout = false
  let lockingStatements = 0

  const isNew = (t: string) => created.has(t) || opts.newTables?.has(t) === true

  for (const st of statements) {
    const s = st.sql
    const U = s.toUpperCase()
    const add = (rule: string, severity: Severity, message: string, hint: string, table?: string) => {
      if (st.ignores.has("*") || st.ignores.has(rule)) return
      issues.push({ rule, severity, message, hint, line: st.line, statement: st.text.length > 160 ? st.text.slice(0, 157) + "…" : st.text, table })
    }

    if (/^(BEGIN|START TRANSACTION)\b/.test(U)) explicitTx = true
    if (/^(COMMIT|END)\b/.test(U)) explicitTx = false
    if (/^SET\s+(LOCAL\s+)?LOCK_TIMEOUT\b/.test(U)) lockTimeout = true

    // CREATE TABLE
    let m = s.match(new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "i"))
    if (m) {
      const t = ident(m[1]!)
      created.add(t)
      if (!/PRIMARY\s+KEY/i.test(s) && !/\bPARTITION\s+OF\b/i.test(s) && !/^CREATE\s+TEMP/i.test(s)) add("table-without-primary-key", "info", `Table ${t} has no primary key`, "Logical replication, many ORMs and deduplication need one.", t)
      if (/\b(?:id|[\w]+_id)\s+(?:SERIAL|INTEGER|INT|INT4)\b[^,]*PRIMARY\s+KEY/i.test(s) || /\bid\s+SERIAL\b/i.test(s)) add("int-primary-key", "info", `${t} uses a 32-bit integer primary key, which runs out at about 2.1 billion rows`, "Use bigint (or bigserial / GENERATED ... AS IDENTITY on bigint).", t)
      if (/\bjson\b/i.test(s)) add("json-not-jsonb", "info", `${t} uses json rather than jsonb`, "jsonb is indexable and faster to query; json only preserves formatting.", t)
      if (/\bTIMESTAMP\b(?!\s*(?:\(\d+\)\s*)?WITH\s+TIME\s+ZONE)/i.test(s)) add("timestamp-without-tz", "info", `${t} has timestamp without time zone`, "timestamptz stores an absolute instant; plain timestamp is ambiguous across zones.", t)
      continue
    }

    // Destructive
    if ((m = s.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT}(?:\\s*,\\s*${IDENT})*)`, "i")))) {
      const tables = m[1]!.split(",").map((x) => ident(x.trim()))
      add("drop-table", "error", `Drops table ${tables.join(", ")} and all its data`, "Make sure nothing reads it (deploy code first), back up the data, and consider renaming it away for a release before dropping.", tables[0])
      continue
    }
    if (/^DROP\s+(SCHEMA|DATABASE)\b/i.test(s)) {
      add("drop-schema", "error", `${U.split(" ").slice(0, 2).join(" ")}: removes everything inside it`, "Never run this from an application migration.")
      continue
    }
    if ((m = s.match(new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${IDENT})`, "i")))) {
      add("truncate", "error", `Truncates ${ident(m[1]!)}: deletes every row`, "If this is a reset for development data, keep it out of production migrations.", ident(m[1]!))
      continue
    }
    if ((m = s.match(new RegExp(`^DELETE\\s+FROM\\s+(?:ONLY\\s+)?(${IDENT})`, "i")))) {
      if (!/\bWHERE\b/i.test(s)) add("delete-without-where", "error", `Deletes every row from ${ident(m[1]!)}`, "Add a WHERE clause, or use a separate, reviewed data migration.", ident(m[1]!))
      else if (!isNew(ident(m[1]!))) add("data-change", "info", `Deletes data from ${ident(m[1]!)} inside a schema migration`, "Large deletes hold locks and bloat WAL; batch them in a background job.", ident(m[1]!))
      continue
    }
    if ((m = s.match(new RegExp(`^UPDATE\\s+(?:ONLY\\s+)?(${IDENT})`, "i")))) {
      const t = ident(m[1]!)
      if (!isNew(t)) {
        if (!/\bWHERE\b/i.test(s)) add("update-without-where", "warning", `Rewrites every row of ${t} in one transaction`, "On a big table this locks rows for the whole run and bloats the table. Backfill in batches outside the migration.", t)
        else add("data-change", "info", `Updates data in ${t} inside a schema migration`, "Consider a batched backfill job for large tables.", t)
      }
      continue
    }

    // Indexes
    if ((m = s.match(new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${IDENT})`, "i")))) {
      const t = ident(m[3]!)
      if (m[2]) {
        if (explicitTx || opts.wrappedInTransaction) add("concurrent-index-in-transaction", "error", `CREATE INDEX CONCURRENTLY on ${t} can't run inside a transaction`, opts.wrappedInTransaction ? "Disable the transaction for this migration (e.g. Knex: export const config = { transaction: false })." : "Move it outside BEGIN/COMMIT.", t)
      } else if (!isNew(t)) {
        add("index-without-concurrently", "warning", `Creating an index on ${t} blocks writes to the table until it finishes`, `Use CREATE ${m[1] ? "UNIQUE " : ""}INDEX CONCURRENTLY (outside a transaction).`, t)
        lockingStatements++
      }
      continue
    }
    if (/^DROP\s+INDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s)) {
      add("drop-index-without-concurrently", "warning", "Dropping an index without CONCURRENTLY takes an exclusive lock on its table", "Use DROP INDEX CONCURRENTLY.")
      lockingStatements++
      continue
    }
    if (/^REINDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s)) {
      add("reindex-without-concurrently", "warning", "REINDEX without CONCURRENTLY blocks writes", "Use REINDEX ... CONCURRENTLY (PostgreSQL 12+).")
      continue
    }
    if (/^(VACUUM\s+FULL|CLUSTER)\b/i.test(s)) {
      add("table-rewrite-command", "warning", `${U.startsWith("CLUSTER") ? "CLUSTER" : "VACUUM FULL"} rewrites the table under an exclusive lock`, "Use pg_repack if you need this on a live system.")
      continue
    }
    if (/^LOCK\s+(TABLE\s+)?/i.test(s)) {
      add("explicit-lock", "warning", "Explicit LOCK TABLE in a migration", "Make sure lock_timeout is set so a queue of blocked queries can't build up.")
      lockingStatements++
      continue
    }
    if (/^ALTER\s+TYPE\b.*\bADD\s+VALUE\b/i.test(s) && pg < 12 && (explicitTx || opts.wrappedInTransaction)) {
      add("enum-add-value-in-transaction", "error", "ALTER TYPE ... ADD VALUE can't run in a transaction before PostgreSQL 12", "Run it outside a transaction.")
      continue
    }
    if ((m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${IDENT})\\s+RENAME\\s+TO\\s+(${IDENT})`, "i")))) {
      add("rename-table", "warning", `Renames table ${ident(m[1]!)} to ${ident(m[2]!)}`, "Code still running the old version will fail until it's replaced. Create a view with the old name, or rename across two releases.", ident(m[1]!))
      continue
    }

    // ALTER TABLE with one or more actions
    m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+(.*)$`, "i"))
    if (m) {
      const t = ident(m[1]!)
      const fresh = isNew(t)
      for (const action of splitActions(m[2]!)) {
        const A = action.toUpperCase()
        let a: RegExpMatchArray | null
        if ((a = action.match(new RegExp(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i"))) && !/^DROP\s+(CONSTRAINT|DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION)/i.test(action)) {
          add("drop-column", "error", `Drops column ${t}.${ident(a[1]!)} and its data`, "Deploy code that no longer reads or writes it first; then drop in a later migration.", t)
        } else if ((a = action.match(new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`, "i")))) {
          add("rename-column", "warning", `Renames ${t}.${ident(a[1]!)} to ${ident(a[2]!)}`, "The running app version breaks the moment this runs. Add the new column, dual-write, backfill, switch reads, then drop the old one.", t)
        } else if ((a = action.match(new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+(.*)$`, "i"))) && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(action)) {
          const col = ident(a[1]!)
          const def = a[2]!
          const notNull = /\bNOT\s+NULL\b/i.test(def)
          const hasDefault = /\bDEFAULT\b/i.test(def) || /\bGENERATED\b/i.test(def)
          if (notNull && !hasDefault && !fresh) add("not-null-without-default", "error", `Adds NOT NULL column ${t}.${col} without a default`, "This fails if the table has any rows. Add a DEFAULT, or add it nullable, backfill, then SET NOT NULL.", t)
          if (!fresh && VOLATILE_DEFAULT.test(def)) add("volatile-default", "warning", `Adds ${t}.${col} with a volatile default, which rewrites the whole table under an exclusive lock`, "Add the column without a default (or with a constant), then backfill in batches.", t)
          if (!fresh && /\bGENERATED\s+ALWAYS\s+AS\s*\(.*\)\s*STORED/i.test(def)) add("stored-generated-column", "warning", `Adds stored generated column ${t}.${col}, which rewrites the table`, "Expect a long exclusive lock on large tables.", t)
          if (!fresh && /\b(SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(def)) add("volatile-default", "warning", `Adds serial column ${t}.${col}, which fills every existing row under an exclusive lock`, "Add a nullable column and backfill in batches.", t)
          if (!fresh && /\bPRIMARY\s+KEY|\bUNIQUE\b/i.test(def)) add("add-unique-constraint", "warning", `Adds ${t}.${col} with a unique index built under an exclusive lock`, "Add the column, CREATE UNIQUE INDEX CONCURRENTLY, then attach it as a constraint.", t)
          if (!fresh && /\bREFERENCES\b/i.test(def) && !/\bNOT\s+VALID\b/i.test(def)) add("foreign-key-validation", "info", `Adds ${t}.${col} with a foreign key that locks the referenced table briefly`, "Usually fine; for very busy tables add the constraint NOT VALID and VALIDATE it separately.", t)
          if (/\bjson\b/i.test(def)) add("json-not-jsonb", "info", `${t}.${col} uses json rather than jsonb`, "jsonb is indexable and faster to query.", t)
        } else if ((a = action.match(new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+(.+?)(?:\\s+USING\\s+.*)?$`, "i")))) {
          if (!fresh) add("change-column-type", "warning", `Changes the type of ${t}.${ident(a[1]!)} to ${a[2]!.trim()}, which usually rewrites the table under an exclusive lock`, "Safe exceptions: widening varchar(n) or removing its limit, varchar→text. Otherwise add a new column and migrate data.", t)
        } else if ((a = action.match(new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+SET\\s+NOT\\s+NULL`, "i")))) {
          if (!fresh) add("set-not-null", "warning", `SET NOT NULL on ${t}.${ident(a[1]!)} scans the whole table while holding an exclusive lock`, "Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL (PostgreSQL 12+ skips the scan).", t)
        } else if (/^ADD\s+(CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\b/i.test(action)) {
          if (!fresh && !/\bNOT\s+VALID\b/i.test(action)) add("foreign-key-validation", "warning", `Adding a foreign key to ${t} validates every row while locking both tables`, "Add it NOT VALID, then ALTER TABLE ... VALIDATE CONSTRAINT in a separate step.", t)
        } else if (/^ADD\s+(CONSTRAINT\s+\S+\s+)?CHECK\b/i.test(action)) {
          if (!fresh && !/\bNOT\s+VALID\b/i.test(action)) add("check-constraint-validation", "warning", `Adding a CHECK constraint to ${t} scans the table under an exclusive lock`, "Add it NOT VALID, then VALIDATE CONSTRAINT separately.", t)
        } else if (/^ADD\s+(CONSTRAINT\s+\S+\s+)?(UNIQUE|PRIMARY\s+KEY)\b/i.test(action) && !/\bUSING\s+INDEX\b/i.test(action)) {
          if (!fresh) add("add-unique-constraint", "warning", `Adding a ${/PRIMARY/i.test(action) ? "primary key" : "unique constraint"} to ${t} builds an index under an exclusive lock`, "CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX.", t)
        } else if (/^(DROP\s+CONSTRAINT)\b/i.test(action)) {
          add("drop-constraint", "info", `Drops a constraint on ${t}`, "Check nothing relies on it for correctness (uniqueness, referential integrity).", t)
        } else if (/^ALTER\s+(COLUMN\s+)?\S+\s+DROP\s+DEFAULT/i.test(action) || /^ALTER\s+(COLUMN\s+)?\S+\s+DROP\s+NOT\s+NULL/i.test(action)) {
          // Safe.
        }
        if (!fresh && /^(ADD|DROP|ALTER|RENAME|SET|VALIDATE)/.test(A)) lockingStatements++
      }
      continue
    }
  }

  if (lockingStatements > 0 && !lockTimeout && issues.some((i) => LOCK_RULES.has(i.rule))) {
    issues.push({ rule: "missing-lock-timeout", severity: "info", message: "Statements here take strong locks, and no lock_timeout is set", hint: "SET lock_timeout = '5s' first, so a long-running query can't make the migration queue up all traffic behind it.", line: 1, statement: "" })
  }
  return { issues, statements, created }
}

/** Splits `ADD COLUMN a int, DROP COLUMN b` into actions, ignoring commas inside parentheses. */
export function splitActions(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of s) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      out.push(cur.trim())
      cur = ""
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
