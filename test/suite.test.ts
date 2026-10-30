import { describe, expect, it } from "vitest"
import { cli, fixture } from "./helpers.js"

describe("devdoctor check", () => {
  const project = () =>
    fixture({
      "package.json": { name: "svc", scripts: { test: "vitest run" }, dependencies: { pg: "8" }, devDependencies: { vitest: "3" } },
      "src/db.ts": 'import pg from "pg"\nexport const url = process.env.DATABASE_URL',
      "src/db.test.ts": "",
      ".env.example": "DATABASE_URL=postgres://localhost/db\n",
      "migrations/001.sql": "CREATE TABLE a (id bigint PRIMARY KEY);\n",
      "migrations/002.sql": "ALTER TABLE a ADD COLUMN b text NOT NULL;\n",
    })

  it("runs every applicable tool and combines the exit code", async () => {
    const r = await cli(undefined, ["check", "-f", "json"], project())
    const out = r.json()
    expect(out.results.map((x: { tool: string }) => x.tool)).toEqual(["repodoctor", "envdoctor", "migraguard", "depscope", "archwatch"])
    expect(out.results.find((x: { tool: string }) => x.tool === "migraguard").findings[0].rule).toBe("not-null-without-default")
    expect(r.code).toBe(1)
  })

  it("emits one SARIF run per tool for code scanning", async () => {
    const r = await cli(undefined, ["check", "--format", "sarif", "--fail-on", "none"], project())
    const sarif = JSON.parse(r.stdout)
    expect(sarif.version).toBe("2.1.0")
    expect(sarif.runs.map((x: { tool: { driver: { name: string } } }) => x.tool.driver.name)).toContain("migraguard")
    expect(r.code).toBe(0)
  })

  it("loads the example config, including the schema reference", async () => {
    const { readFileSync } = await import("node:fs")
    const config = JSON.parse(readFileSync("examples/devdoctor.config.json", "utf8"))
    const dir = fixture({ "devdoctor.config.json": config, "src/domain/a.ts": 'import { b } from "../infra/b"', "src/infra/b.ts": "export const b = 1" })
    const r = await cli("archwatch", ["check", "-f", "json"], dir)
    expect(r.json().findings[0].message).toContain("the domain layer must not depend on anything")
  })
})
