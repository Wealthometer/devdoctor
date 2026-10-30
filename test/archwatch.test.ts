import { describe, expect, it } from "vitest"
import { globToRegex } from "../src/core/glob.js"
import { cli, fixture } from "./helpers.js"

const app = (config: object) =>
  fixture({
    "devdoctor.config.json": { archwatch: config },
    "tsconfig.json": "{}",
    "src/domain/order.ts": 'import { db } from "../infra/db"\nimport type { Row } from "../infra/types"\nexport const order = 1',
    "src/infra/db.ts": 'import pg from "pg"\nexport const db = 1',
    "src/infra/types.ts": "export type Row = {}",
    "src/app/checkout.ts": 'import { order } from "../domain/order"\nimport { db } from "../infra/db"\nimport { helper } from "../features/cart/internal/helper"',
    "src/ui/page.tsx": 'import { db } from "../infra/db"\nimport fs from "node:fs"\nimport _ from "lodash"',
    "src/features/cart/index.ts": 'export * from "./internal/helper"\nimport { p } from "../payments"',
    "src/features/cart/internal/helper.ts": "export const helper = 1",
    "src/features/payments/index.ts": 'import { helper } from "../cart"\nexport const p = 1',
  })

describe("globs", () => {
  it("matches directories, ** and captures", () => {
    expect(globToRegex("src/domain").test("src/domain/x/y.ts")).toBe(true)
    expect(globToRegex("src/**/*.test.ts").test("src/a/b/c.test.ts")).toBe(true)
    expect(globToRegex("src/**/*.test.ts").test("src/c.test.ts")).toBe(true)
    expect("src/features/cart/a.ts".match(globToRegex("src/features/*"))![1]).toBe("cart")
    expect(globToRegex("src/{ui,app}/**").test("src/app/x.ts")).toBe(true)
  })
})

describe("archwatch check", () => {
  const config = {
    layers: { domain: "src/domain/**", infra: "src/infra/**", app: "src/app/**", ui: "src/ui/**" },
    rules: [
      { from: "domain", allow: [], message: "the domain must stay framework-free" },
      { from: "ui", disallow: ["infra"] },
      { from: "src/features/*", disallow: ["src/features/*"], allowSameMatch: true },
    ],
    forbidden: [
      { from: "src/ui/**", import: ["node:*", "fs"], message: "browser code can't use Node APIs" },
      { import: "lodash", message: "use lodash-es" },
    ],
    modules: [{ module: "src/features/*" }],
  }

  it("reports layer, forbidden, module and cycle violations with locations", async () => {
    const r = await cli("archwatch", ["check", "-f", "json"], app(config))
    expect(r.code).toBe(1)
    const msgs = r.json().findings.map((f: { rule: string; message: string; line?: number }) => `${f.rule}@${f.line}: ${f.message}`)
    expect(msgs).toContain("boundary@1: src/domain/order.ts imports src/infra/db.ts: the domain must stay framework-free")
    expect(msgs).toContain('boundary@1: src/ui/page.tsx imports src/infra/db.ts: layer "ui" must not import layer "infra"')
    expect(msgs).toContain("boundary@2: src/features/cart/index.ts imports src/features/payments/index.ts: src/features/* must not import src/features/*")
    expect(msgs).toContain("forbidden-import@2: src/ui/page.tsx imports fs: browser code can't use Node APIs")
    expect(msgs).toContain("forbidden-import@3: src/ui/page.tsx imports lodash: use lodash-es")
    expect(msgs).toContain("module-internals@3: src/app/checkout.ts reaches into src/features/cart internals (internal/helper.ts)")
    expect(msgs.some((m: string) => m.startsWith("circular-import@2: Import cycle: src/features/cart/index.ts → src/features/payments/index.ts"))).toBe(true)
    // Type-only imports are ignored by default; app may use infra (no rule).
    expect(msgs.join("\n")).not.toContain("src/infra/types.ts")
    expect(msgs.join("\n")).not.toMatch(/checkout\.ts imports src\/(infra|domain)/)
    // A feature importing its own internals is fine.
    expect(msgs.join("\n")).not.toContain("src/features/cart/index.ts reaches into")
  })

  it("--type-only checks type imports too, and the layer table counts violations", async () => {
    const r = await cli("archwatch", ["check", "--type-only", "-f", "json"], app(config))
    const out = r.json()
    expect(out.findings.some((f: { message: string }) => f.message.includes("src/infra/types.ts"))).toBe(true)
    const table = out.sections[0]
    expect(table.rows).toContainEqual(["domain", "infra", 2, 2])
  })

  it("rejects invalid config with a clear message", async () => {
    const r = await cli("archwatch", ["check"], app({ layers: { a: "src/a/**" }, rules: [{ from: "b" }] }))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('rules[0].from: "b" is not a layer')
    expect(r.stderr).toContain('rules[0] needs "allow" or "disallow"')
  })

  it("without rules checks cycles and suggests init; init and graph print usable output", async () => {
    const dir = app({})
    const r = await cli("archwatch", ["check", "-f", "json"], dir)
    expect(r.json().findings.map((f: { rule: string }) => f.rule).sort()).toEqual(["circular-import", "no-rules"])
    const init = await cli("archwatch", ["init"], dir)
    const json = JSON.parse(init.stdout.split("\n").slice(1).join("\n"))
    expect(Object.keys(json.archwatch.layers).sort()).toEqual(["app", "domain", "features", "infra", "ui"])
    const graph = await cli("archwatch", ["graph"], app(config))
    expect(graph.stdout).toContain('["domain"] --> ')
    expect(graph.stdout).toContain("stroke:#d33")
  })
})
