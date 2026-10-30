import { describe, expect, it } from "vitest"
import { analyzeKnex } from "../src/tools/migraguard/knex.js"
import { analyzeSql } from "../src/tools/migraguard/rules.js"
import { splitStatements } from "../src/tools/migraguard/sql.js"
import { checkMigrations } from "../src/tools/migraguard/index.js"
import { cli, fixture, git, gitInit } from "./helpers.js"

const ruleIds = (sql: string, opts = {}) => analyzeSql(sql, opts).issues.map((i) => i.rule)

describe("statement splitting", () => {
  it("respects strings, identifiers, dollar quotes and comments", () => {
    const st = splitStatements(`
      -- a comment; with a semicolon
      INSERT INTO t VALUES ('a;b', "we;ird");
      CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM x; END $$ LANGUAGE plpgsql;
      /* block; comment */ SELECT 1`)
    expect(st.map((s) => s.sql)).toEqual(["INSERT INTO t VALUES ('', \"we;ird\")", "CREATE FUNCTION f() RETURNS void AS $BODY$ LANGUAGE plpgsql", "SELECT 1"])
    expect(st.map((s) => s.line)).toEqual([3, 4, 5])
  })
})

describe("SQL rules", () => {
  it("flags destructive statements", () => {
    expect(ruleIds("DROP TABLE users; TRUNCATE orders; DELETE FROM sessions; ALTER TABLE users DROP COLUMN email;")).toEqual(["drop-table", "truncate", "delete-without-where", "drop-column"])
    expect(ruleIds("DELETE FROM sessions WHERE expires_at < now();")).toEqual(["data-change"])
  })

  it("flags unsafe column changes on existing tables", () => {
    expect(ruleIds('ALTER TABLE "public"."User" ADD COLUMN "role" TEXT NOT NULL;')).toEqual(["not-null-without-default"])
    expect(ruleIds("ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'member';")).toEqual([])
    expect(ruleIds("ALTER TABLE users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();")).toEqual(["volatile-default", "missing-lock-timeout"])
    expect(ruleIds("ALTER TABLE users ALTER COLUMN age TYPE bigint;")).toContain("change-column-type")
    expect(ruleIds("ALTER TABLE users ALTER COLUMN email SET NOT NULL;")).toContain("set-not-null")
    expect(ruleIds("ALTER TABLE users RENAME COLUMN name TO full_name;")).toEqual(["rename-column"])
    expect(ruleIds("ALTER TABLE users RENAME TO accounts;")).toEqual(["rename-table"])
    expect(ruleIds("ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);")).toContain("foreign-key-validation")
    expect(ruleIds("ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;")).toEqual([])
    expect(ruleIds("ALTER TABLE users ADD CONSTRAINT u UNIQUE (email);")).toContain("add-unique-constraint")
    expect(ruleIds("ALTER TABLE users ADD COLUMN a int, DROP COLUMN b, ALTER COLUMN c SET NOT NULL;")).toEqual(["drop-column", "set-not-null", "missing-lock-timeout"])
  })

  it("flags expensive index operations, but not on tables created in the same batch", () => {
    expect(ruleIds("CREATE INDEX idx ON users (email);")).toEqual(["index-without-concurrently", "missing-lock-timeout"])
    expect(ruleIds("SET lock_timeout = '5s'; CREATE INDEX idx ON users (email);")).toEqual(["index-without-concurrently"])
    expect(ruleIds("CREATE INDEX CONCURRENTLY idx ON users (email);")).toEqual([])
    expect(ruleIds("BEGIN; CREATE INDEX CONCURRENTLY idx ON users (email); COMMIT;")).toEqual(["concurrent-index-in-transaction"])
    expect(ruleIds("CREATE INDEX CONCURRENTLY idx ON users (email);", { wrappedInTransaction: true })).toEqual(["concurrent-index-in-transaction"])
    expect(ruleIds("DROP INDEX idx;")).toContain("drop-index-without-concurrently")
    expect(ruleIds("CREATE TABLE t (id bigint PRIMARY KEY, email text NOT NULL); CREATE INDEX i ON t (email); ALTER TABLE t ADD COLUMN x int NOT NULL;")).toEqual([])
    expect(ruleIds("CREATE INDEX i ON users (email);", { newTables: new Set(["users"]) })).toEqual([])
  })

  it("notes table design issues", () => {
    expect(ruleIds("CREATE TABLE logs (msg text, data json, at timestamp);")).toEqual(["table-without-primary-key", "json-not-jsonb", "timestamp-without-tz"])
    expect(ruleIds("CREATE TABLE t (id serial PRIMARY KEY, at timestamptz, d jsonb);")).toEqual(["int-primary-key"])
  })

  it("honours inline ignore comments", () => {
    expect(ruleIds("-- migraguard-ignore: drop-table\nDROP TABLE legacy;")).toEqual([])
    expect(ruleIds("-- migraguard-ignore\nDROP TABLE legacy;")).toEqual([])
    expect(ruleIds("-- migraguard-ignore: truncate\nDROP TABLE legacy;")).toEqual(["drop-table"])
  })

  it("never matches inside strings or function bodies", () => {
    expect(ruleIds("INSERT INTO notes (body) VALUES ('DROP TABLE users');")).toEqual([])
    expect(ruleIds("CREATE FUNCTION purge() RETURNS void AS $$ DELETE FROM sessions; $$ LANGUAGE sql;")).toEqual([])
  })
})

describe("Knex migrations", () => {
  it("reads schema builder calls and raw SQL", () => {
    const src = `
exports.up = async function (knex) {
  await knex.schema.createTable("teams", (t) => {
    t.bigIncrements("id")
    t.string("name").notNullable()
    t.index(["name"])
  })
  await knex.schema.alterTable("users", (t) => {
    t.string("role").notNullable()
    t.string("nickname").notNullable().defaultTo("")
    t.dropColumn("legacy")
    t.renameColumn("name", "full_name")
    t.index(["email"])
    t.bigInteger("team_id").references("teams.id")
  })
  await knex("audit").del()
  await knex.raw("CREATE INDEX CONCURRENTLY idx_users_x ON users (x)")
}
exports.down = async function (knex) {
  await knex.schema.dropTable("teams")
}`
    const { issues } = analyzeKnex(src)
    const ids = issues.map((i) => i.rule)
    expect(ids).toEqual(expect.arrayContaining(["not-null-without-default", "drop-column", "rename-column", "index-without-concurrently", "foreign-key-validation", "delete-without-where", "concurrent-index-in-transaction"]))
    // Nothing from the new table or from down().
    expect(issues.filter((i) => i.table === "teams")).toEqual([])
    expect(ids).not.toContain("drop-table")
    expect(issues.find((i) => i.rule === "drop-column")!.line).toBe(11)
  })

  it("allows CONCURRENTLY when the transaction is disabled", () => {
    const { issues } = analyzeKnex(`export const config = { transaction: false }\nexport async function up(knex) { await knex.raw("CREATE INDEX CONCURRENTLY i ON users (email)") }`)
    expect(issues).toEqual([])
  })
})

describe("migraguard check", () => {
  it("detects Prisma migration folders and reports per-file risk", async () => {
    const dir = fixture({
      "prisma/schema.prisma": "",
      "prisma/migrations/20240101000000_init/migration.sql": 'CREATE TABLE "User" ("id" TEXT NOT NULL, "email" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));\nCREATE UNIQUE INDEX "User_email_key" ON "User"("email");',
      "prisma/migrations/20240201000000_role/migration.sql": 'ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL;\nCREATE INDEX "User_role_idx" ON "User"("role");',
      "prisma/migrations/migration_lock.toml": 'provider = "postgresql"',
    })
    const { reports, result } = await checkMigrations(dir)
    expect(reports.map((r) => [r.file, r.framework, r.risk])).toEqual([
      ["prisma/migrations/20240101000000_init/migration.sql", "prisma", "none"],
      ["prisma/migrations/20240201000000_role/migration.sql", "prisma", "high"],
    ])
    expect(result.findings.map((f) => `${f.rule}@${f.line}`)).toEqual(["not-null-without-default@1", "index-without-concurrently@2", "missing-lock-timeout@1"])
  })

  it("--since only checks migrations added after a git ref", async () => {
    const dir = gitInit(fixture({ "migrations/001_init.sql": "CREATE TABLE users (id bigint PRIMARY KEY);\nDROP TABLE old_stuff;" }))
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "init")
    git(dir, "tag", "base")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${dir}/migrations/002_email.sql`, "ALTER TABLE users ADD COLUMN email text NOT NULL;")
    const r = await cli("migraguard", ["check", "--since", "base", "-f", "json"], dir)
    const out = r.json()
    expect(out.summary.checked).toBe(1)
    expect(out.findings.map((f: { rule: string }) => f.rule)).toEqual(["not-null-without-default"])
    expect(r.code).toBe(1)
  })

  it("exits 0 for safe migrations and explains how to fix risky ones", async () => {
    const safe = fixture({ "db/migrations/1.sql": "CREATE TABLE a (id bigint PRIMARY KEY);\nCREATE INDEX CONCURRENTLY i ON b (x);" })
    expect((await cli("migraguard", ["check"], safe)).code).toBe(0)
    const risky = fixture({ "db/migrations/1.sql": "ALTER TABLE users DROP COLUMN email;" })
    const r = await cli("migraguard", ["check", "--no-color"], risky)
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("Drops column users.email")
    expect(r.stdout).toContain("→ Deploy code that no longer reads or writes it first")
    expect((await cli("migraguard", ["check", "-f", "markdown"], risky)).stdout).toContain("| 🔴 |")
    expect((await cli("migraguard", ["check", "./nope"], risky)).code).toBe(2)
  })
})
