import { describe, expect, it } from "vitest"
import { ignoreMatcher, stripJsonComments, walk } from "../src/core/fs.js"
import { buildGraph, extractImports, findCycles, packageName, toMermaid } from "../src/core/imports.js"
import { render, renderSarif, shouldFail } from "../src/core/report.js"
import type { ToolResult } from "../src/core/types.js"
import { cli, fixture } from "./helpers.js"

describe("ignore patterns", () => {
  it("handles anchors, directories, globs and negation", () => {
    const m = ignoreMatcher(["node_modules", "/dist", "build/", "*.log", "!keep.log", "docs/**/draft*"])
    expect(m("node_modules", true)).toBe(true)
    expect(m("pkg/node_modules/x.js", false)).toBe(true)
    expect(m("dist", true)).toBe(true)
    expect(m("src/dist", true)).toBe(false)
    expect(m("build", true)).toBe(true)
    expect(m("build", false)).toBe(false) // "build/" only matches directories
    expect(m("a/b/error.log", false)).toBe(true)
    expect(m("keep.log", false)).toBe(false)
    expect(m("docs/x/y/draft-1.md", false)).toBe(true)
  })

  it("walk skips build output and .gitignore entries", async () => {
    const dir = fixture({ ".gitignore": "secret/\n", "src/a.ts": "", "dist/a.js": "", "node_modules/x/index.js": "", "secret/k.txt": "" })
    expect(await walk(dir)).toEqual([".gitignore", "src/a.ts"])
  })
})

describe("json with comments", () => {
  it("strips comments and trailing commas but keeps strings intact", () => {
    expect(JSON.parse(stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'))).toEqual({ a: "http://x", b: [1, 2] })
  })
})

describe("import extraction", () => {
  it("finds static, dynamic, require, re-exports and side effects; ignores comments", () => {
    const src = [
      'import React, { useState } from "react"',
      "import type { Foo } from './types'",
      "import { type A, type B } from './only-types'",
      "import { type C, D } from './mixed'",
      'export * from "./reexport"',
      "export { x } from '@scope/pkg/sub'",
      "import './styles.css'",
      "const lazy = () => import('./lazy')",
      "const fs = require('node:fs')",
      "// import nope from 'commented'",
      "/* require('also-commented') */",
      "type T = typeof import('./type-pos').X",
      "const sample = `import fake from './in-template'`",
      "const lazyTpl = () => import(`${base}/x`)",
      "const fixture = 'import pg from \"pg\"'",
      "const re = /from\\s*(['\"])([^'\"]+)\\1/g; const s = \"require('in-string')\"",
    ].join("\n")
    const refs = extractImports(src)
    const by = Object.fromEntries(refs.map((r) => [r.specifier, r]))
    expect(Object.keys(by).sort()).toEqual(["./lazy", "./mixed", "./only-types", "./reexport", "./styles.css", "./type-pos", "./types", "@scope/pkg/sub", "node:fs", "react"])
    expect(by["./types"]!.typeOnly).toBe(true)
    expect(by["./only-types"]!.typeOnly).toBe(true)
    expect(by["./mixed"]!.typeOnly).toBe(false)
    expect(by["./type-pos"]!.typeOnly).toBe(true)
    expect(by["./lazy"]!.kind).toBe("dynamic")
    expect(by["react"]!.line).toBe(1)
  })

  it("maps specifiers to package names", () => {
    expect(packageName("lodash/fp")).toBe("lodash")
    expect(packageName("@nestjs/core/x")).toBe("@nestjs/core")
    expect(packageName("./x")).toBeNull()
    expect(packageName("fs")).toBeNull()
    expect(packageName("node:path")).toBeNull()
    expect(packageName("#internal")).toBeNull()
  })
})

describe("import graph", () => {
  it("resolves extensions, index files, .js→.ts and tsconfig paths, and finds cycles", async () => {
    const dir = fixture({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      "src/a.ts": 'import { b } from "./b.js"\nimport x from "lodash"',
      "src/b.ts": 'import { c } from "@/c"',
      "src/c/index.ts": 'import { a } from "../a"\nimport type { T } from "../types"',
      "src/types.ts": 'import type { A } from "./c"',
      "src/lonely.ts": 'import "./missing"',
    })
    const g = await buildGraph(dir)
    expect(g.edges.get("src/a.ts")!.map((e) => e.to)).toEqual(["src/b.ts"])
    expect(g.edges.get("src/b.ts")!.map((e) => e.to)).toEqual(["src/c/index.ts"])
    expect([...g.packages.keys()]).toEqual(["lodash"])
    expect(g.unresolved).toEqual([{ file: "src/lonely.ts", line: 1, specifier: "./missing" }])
    expect(findCycles(g)).toEqual([{ cycle: ["src/a.ts", "src/b.ts", "src/c/index.ts", "src/a.ts"], members: ["src/a.ts", "src/b.ts", "src/c/index.ts"] }])
    // Type-only edges pull types.ts into the same tangle when included.
    const withTypes = findCycles(g, { includeTypeOnly: true })
    expect(withTypes).toHaveLength(1)
    expect(withTypes[0]!.members).toContain("src/types.ts")
    expect(toMermaid([["a", "b"]])).toContain('n0["a"] --> n1["b"]')
  })
})

describe("reports", () => {
  const result: ToolResult = {
    tool: "demo",
    title: "Demo",
    summary: { files: 2 },
    findings: [
      { rule: "r1", severity: "warning", message: "Careful", file: "a.ts", line: 3 },
      { rule: "r2", severity: "error", message: "Broken | pipe", hint: "Fix it" },
    ],
    sections: [{ kind: "table", title: "T", headers: ["a", "b"], rows: [[1, 2]] }],
  }
  it("renders every format", () => {
    expect(render(result, "text")).toMatch(/Broken \| pipe[\s\S]*Careful/) // errors first
    expect(render(result, "markdown")).toContain("Broken \\| pipe")
    const json = JSON.parse(render(result, "json"))
    expect(json.counts).toEqual({ error: 1, warning: 1, info: 0 })
    const sarif = JSON.parse(renderSarif([result]))
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: "r1", level: "warning", locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 3 } } }] })
  })
  it("decides exit codes by threshold", () => {
    expect(shouldFail(result.findings, "error")).toBe(true)
    expect(shouldFail([{ rule: "x", severity: "warning", message: "" }], "error")).toBe(false)
    expect(shouldFail([{ rule: "x", severity: "warning", message: "" }], "warning")).toBe(true)
    expect(shouldFail(result.findings, "none")).toBe(false)
  })
})

describe("cli", () => {
  it("prints help, version and usage errors with the right exit codes", async () => {
    const dir = fixture({})
    expect((await cli(undefined, ["--help"], dir)).stdout).toContain("migraguard")
    expect((await cli(undefined, ["--version"], dir)).stdout).toMatch(/^\d+\.\d+\.\d+/)
    expect((await cli("repodoctor", ["--help"], dir)).stdout).toContain("--min-score")
    const bad = await cli(undefined, ["nope"], dir)
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain("Unknown tool")
    const flag = await cli("repodoctor", ["--bogus"], dir)
    expect(flag.code).toBe(2)
    expect(flag.stderr).toContain("--bogus")
    expect((await cli("repodoctor", ["--format", "xml"], dir)).code).toBe(2)
  })

  it("applies ignores from config", async () => {
    const dir = fixture({ "devdoctor.config.json": { migraguard: { ignore: ["drop-table"] } }, "migrations/001.sql": "DROP TABLE users;" })
    const r = await cli("migraguard", ["check", "-f", "json"], dir)
    expect(r.json().findings).toEqual([])
    expect(r.code).toBe(0)
  })
})
