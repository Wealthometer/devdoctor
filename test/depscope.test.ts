import { describe, expect, it } from "vitest"
import { analyze, graphOf, latestVersions } from "../src/tools/depscope/index.js"
import { duplicates, parseNpmLock, parsePnpmLock, parseYarnLock } from "../src/tools/depscope/lockfile.js"
import { behind, compareVersions } from "../src/core/semver.js"
import { cli, fixture, rules } from "./helpers.js"

const npmLock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/express": { version: "4.19.0", dependencies: { debug: "2.6.9", "ms": "2.0.0" } },
    "node_modules/debug": { version: "4.3.4", dependencies: { ms: "2.1.2" } },
    "node_modules/express/node_modules/debug": { version: "2.6.9", dependencies: { ms: "2.0.0" } },
    "node_modules/ms": { version: "2.1.2" },
    "node_modules/express/node_modules/ms": { version: "2.0.0" },
    "node_modules/left-pad": { version: "1.3.0" },
    "node_modules/vitest": { version: "1.0.0", dev: true },
    "node_modules/typescript": { version: "5.0.0", dev: true },
    "node_modules/eslint-plugin-react": { version: "7.0.0", dev: true },
    "node_modules/zod": { version: "3.0.0" },
  },
}

/** A small project with node_modules on disk so sizes and bins can be read. */
function project() {
  return fixture({
    "package.json": { name: "app", scripts: { test: "vitest run", build: "tsc -p ." }, dependencies: { express: "^4.19.0", debug: "^4.3.4", "left-pad": "^1.3.0" }, devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0", "eslint-plugin-react": "^7.0.0", zod: "^3" } },
    "package-lock.json": npmLock,
    "tsconfig.json": "{}",
    ".eslintrc.json": '{ "plugins": ["react"] }',
    "src/server.ts": 'import express from "express"\nimport debug from "debug"\nimport { z } from "zod"\nimport chalk from "chalk"\nimport { a } from "./a"',
    "src/a.ts": 'import { b } from "./b"\nexport const a = 1',
    "src/b.ts": 'import { a } from "./a"\nexport const b = 2',
    "node_modules/express/package.json": { name: "express", version: "4.19.0" },
    "node_modules/express/index.js": "x".repeat(2048),
    "node_modules/express/node_modules/debug/package.json": { name: "debug", version: "2.6.9" },
    "node_modules/debug/package.json": { name: "debug", version: "4.3.4" },
    "node_modules/ms/package.json": { name: "ms", version: "2.1.2" },
    "node_modules/express/node_modules/ms/package.json": { name: "ms", version: "2.0.0" },
    "node_modules/vitest/package.json": { name: "vitest", version: "1.0.0", bin: { vitest: "vitest.mjs" } },
  })
}

describe("lockfiles", () => {
  it("parses npm, pnpm and yarn lockfiles and finds duplicates", () => {
    const npm = parseNpmLock(npmLock)
    expect(npm.find((p) => p.path === "node_modules/express/node_modules/debug")).toMatchObject({ name: "debug", version: "2.6.9" })
    expect([...duplicates({ kind: "npm", packages: npm }).keys()].sort()).toEqual(["debug", "ms"])
    const pnpm = parsePnpmLock("lockfileVersion: '9.0'\npackages:\n  lodash@4.17.21:\n    resolution: {integrity: x}\n  '@babel/core@7.24.0':\n    resolution: {integrity: y}\nsnapshots:\n  '@babel/core@7.24.0':\n    dependencies:\n      lodash: 4.17.21\n")
    expect(pnpm.map((p) => `${p.name}@${p.version}`)).toEqual(["lodash@4.17.21", "@babel/core@7.24.0"])
    expect(pnpm[1]!.dependencies).toEqual({ lodash: "4.17.21" })
    const yarn = parseYarnLock('# yarn lockfile v1\n\n"lodash@^4.17.0", lodash@^4.17.21:\n  version "4.17.21"\n  resolved "x"\n\n"@types/node@^20":\n  version "20.1.0"\n  dependencies:\n    undici-types "~5.26.4"\n')
    expect(yarn.map((p) => `${p.name}@${p.version}`)).toEqual(["lodash@4.17.21", "@types/node@20.1.0"])
    expect(yarn[1]!.dependencies).toEqual({ "undici-types": "~5.26.4" })
  })

  it("compares versions", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0-beta.2", "2.0.0")).toBeLessThan(0)
    expect(behind("4.19.0", "5.0.1")).toBe("major")
    expect(behind("4.19.0", "4.21.0")).toBe("minor")
    expect(behind("4.19.0", "4.19.2")).toBe("patch")
    expect(behind("5.0.0", "4.0.0")).toBeNull()
  })
})

describe("depscope analyze", () => {
  it("finds unused, undeclared and misplaced dependencies, duplicates and cycles", async () => {
    const r = await analyze(project(), { offline: true })
    const msgs = r.findings.map((f) => `${f.rule}: ${f.message}`)
    expect(msgs).toContain("unused-dependency: left-pad is in dependencies of package.json but nothing uses it")
    expect(msgs).toContain("undeclared-dependency: chalk is imported but not declared in package.json")
    expect(msgs).toContain("dev-dependency-at-runtime: zod is a devDependency but runtime code imports it")
    expect(msgs.some((m) => m.startsWith("circular-import: Import cycle: src/a.ts → src/b.ts → src/a.ts"))).toBe(true)
    expect(msgs.some((m) => m.startsWith("duplicate-versions: 2 versions of debug"))).toBe(true)
    // Used through a script (vitest), implicitly (typescript) or via config (eslint plugin).
    expect(msgs.join("\n")).not.toMatch(/(vitest|typescript|eslint-plugin-react) is in/)
    const heavy = r.sections!.find((s) => s.title.startsWith("Heaviest"))!
    expect(heavy.kind === "table" && heavy.rows[0]![0]).toBe("express")
    expect(r.summary).toMatchObject({ direct: 7, lockfile: "npm", duplicated: 2, cycles: 1 })
  })

  it("checks the registry for outdated and deprecated versions", async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(url)
      const name = decodeURIComponent(url.split("/").pop()!)
      const body: Record<string, unknown> = {
        express: { "dist-tags": { latest: "5.1.0" }, versions: { "4.19.0": {} } },
        debug: { "dist-tags": { latest: "4.3.5" }, versions: {} },
        "left-pad": { "dist-tags": { latest: "1.3.0" }, versions: { "1.3.0": { deprecated: "use String.prototype.padStart()" } } },
      }
      if (!body[name]) return new Response("not found", { status: 404 })
      return new Response(JSON.stringify(body[name]), { status: 200 })
    }) as typeof fetch
    const r = await analyze(project(), { fetch: fakeFetch, registry: "https://registry.test" })
    const outdated = r.sections!.find((s) => s.title.startsWith("Outdated"))!
    expect(outdated.kind === "table" && outdated.rows.map((x) => x.join(" "))).toEqual(["express 4.19.0 5.1.0 major", "debug 4.3.4 4.3.5 patch"])
    expect(rules(r)).toContain("deprecated")
    expect(rules(r)).toContain("registry-unreachable")
    expect(calls.every((u) => u.startsWith("https://registry.test/"))).toBe(true)
  })

  it("times out slow registries instead of hanging", async () => {
    const never = (() => new Promise(() => {})) as unknown as typeof fetch
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch
    void never
    const res = await latestVersions(["a", "b"], { fetch: hang, timeoutMs: 50 })
    expect(res.get("a")).toEqual({ error: "timed out" })
  })

  it("prints package and module graphs", async () => {
    const dir = project()
    const pkgGraph = await graphOf(dir, { depth: 2 })
    expect(pkgGraph).toContain('"app"] --> ')
    expect(pkgGraph).toContain("express@4.19.0")
    expect(pkgGraph).toContain("debug@2.6.9")
    const dot = await graphOf(dir, { modules: true, format: "dot" })
    expect(dot).toContain('"src/a.ts" -> "src/b.ts"')
    expect(dot).toContain('"src/a.ts" [color=red, penwidth=2]')
    const out = await cli("depscope", ["graph", "--modules"], dir)
    expect(out.stdout.startsWith("graph LR")).toBe(true)
  })

  it("handles workspaces: each package declares its own imports", async () => {
    const dir = fixture({
      "package.json": { name: "mono", private: true, workspaces: ["packages/*"], devDependencies: { typescript: "5" } },
      "packages/api/package.json": { name: "@mono/api", dependencies: { "@mono/shared": "*" } },
      "packages/api/src/index.ts": 'import { x } from "@mono/shared"\nimport pg from "pg"',
      "packages/shared/package.json": { name: "@mono/shared", dependencies: { lodash: "4" } },
      "packages/shared/src/index.ts": "export const x = 1",
    })
    const r = await cli("depscope", ["analyze", "--offline", "-f", "json"], dir)
    const msgs = r.json().findings.map((f: { message: string }) => f.message)
    expect(msgs).toContain("pg is imported but not declared in packages/api/package.json")
    expect(msgs).toContain("lodash is in dependencies of packages/shared/package.json but nothing uses it")
    expect(msgs.join()).not.toContain("@mono/shared is imported")
    expect(r.code).toBe(1)
  })
})
