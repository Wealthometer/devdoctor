import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { changelog, lintMessage, nextVersion, readCommits, scanDiff, scopeOf, sensitiveFile, suggest, stagedChanges } from "../src/tools/commitsmith.js"
import { cli, fixture, git, gitInit } from "./helpers.js"

const repo = (files: Record<string, string> = { "README.md": "# x\n" }) => {
  const dir = gitInit(fixture(files))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "chore: init")
  return dir
}
const write = (dir: string, path: string, text: string) => {
  mkdirSync(`${dir}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true })
  writeFileSync(`${dir}/${path}`, text)
}

describe("suggest", () => {
  it("picks type and scope from what's staged", () => {
    const dir = repo({ "src/auth/session.ts": "export function load() { return 1 }\n", "README.md": "# x\n" })
    write(dir, "src/auth/oauth.ts", "export function login() {}\n")
    git(dir, "add", "-A")
    const { changes, diff } = stagedChanges(dir)
    const s = suggest(changes, diff)
    expect(s[0]!.message.split("\n")[0]).toBe("feat(auth): add oauth")
    expect(s[0]!.body).toEqual(["- add src/auth/oauth.ts"])
  })

  it("recognises docs, tests, CI, dependency bumps and breaking removals", () => {
    const cases: [Record<string, string>, (d: string) => void, RegExp][] = [
      [{}, (d) => write(d, "docs/guide.md", "hi"), /^docs: /],
      [{}, (d) => write(d, "src/a.test.ts", "test()"), /^test: add tests for a/],
      [{}, (d) => write(d, ".github/workflows/ci.yml", "on: push"), /^ci: /],
      [{ "package.json": '{\n  "dependencies": {\n    "zod": "^3.0.0"\n  }\n}\n' }, (d) => write(d, "package.json", '{\n  "dependencies": {\n    "zod": "^4.0.0"\n  }\n}\n'), /^build: bump zod/],
      [{ "src/api.ts": "export function a() {}\nexport function b() {}\n" }, (d) => write(d, "src/api.ts", "export function a() {}\n"), /^refactor!: /],
    ]
    for (const [files, change, expected] of cases) {
      const dir = repo({ "README.md": "# x\n", ...files })
      change(dir)
      git(dir, "add", "-A")
      const { changes, diff } = stagedChanges(dir)
      const s = suggest(changes, diff)
      expect(s[0]!.message.split("\n")[0]).toMatch(expected)
      if (expected.source.includes("!")) expect(s[0]!.message).toContain("BREAKING CHANGE: removed export b")
    }
  })

  it("derives scopes from packages and src folders", () => {
    expect(scopeOf(["packages/api/src/a.ts", "packages/api/b.ts"])).toBe("api")
    expect(scopeOf(["src/billing/x.ts", "src/billing/y/z.ts"])).toBe("billing")
    expect(scopeOf(["src/a/x.ts", "src/b/y.ts"])).toBeNull()
  })

  it("--raw prints just the message, and refuses with nothing staged", async () => {
    const dir = repo()
    expect((await cli("commitsmith", ["suggest"], dir)).stderr).toContain("Nothing is staged")
    write(dir, "src/pay/stripe.ts", "export const charge = () => 1\n")
    git(dir, "add", "-A")
    const r = await cli("commitsmith", ["suggest", "--raw"], dir)
    expect(r.stdout.split("\n")[0]).toBe("feat(pay): add stripe")
  })
})

describe("lint", () => {
  it("accepts good messages and explains bad ones", () => {
    expect(lintMessage("feat(api): add search endpoint\n\nSupports websearch syntax.")).toEqual([])
    expect(lintMessage("fix!: drop node 18\n\nBREAKING CHANGE: requires node 20")).toEqual([])
    expect(lintMessage("Merge branch 'main' into x")).toEqual([])
    const r = (m: string, o = {}) => lintMessage(m, o).map((f) => f.rule)
    expect(r("added stuff")).toEqual(["format"])
    expect(r("feature: x")).toEqual(["type"])
    expect(r("feat(): x")).toEqual(["scope-empty"])
    expect(r("feat: Added the thing.")).toEqual(["subject-period", "subject-case", "imperative"])
    expect(r("feat: x\nno blank line")).toEqual(["body-blank-line"])
    expect(r("feat: " + "x".repeat(80))).toEqual(["header-length"])
    expect(r("feat(web): x", { scopes: ["api"] })).toEqual(["scope"])
    expect(r("feat: wip")).toEqual(["vague"])
    expect(r("feat: x\n\nBREAKING CHANGES - yes")).toEqual(["breaking-footer"])
  })

  it("lints a commit-msg file (hook mode) and a range of commits", async () => {
    const dir = repo()
    write(dir, ".git/COMMIT_EDITMSG", "fix: handle empty carts\n# comment lines are ignored\n")
    expect((await cli("commitsmith", ["lint", "--file", ".git/COMMIT_EDITMSG"], dir)).code).toBe(0)
    git(dir, "commit", "--allow-empty", "-qm", "oops fixed it")
    git(dir, "commit", "--allow-empty", "-qm", "feat: good one")
    const r = await cli("commitsmith", ["lint", "--from", "HEAD~2", "-f", "json"], dir)
    expect(r.code).toBe(1)
    expect(r.json().findings.map((f: { message: string }) => f.message)).toEqual([expect.stringContaining('"oops fixed it": "oops fixed it" isn\'t a Conventional Commit')])
  })
})

describe("changelog", () => {
  it("groups commits since the last tag and suggests the next version", async () => {
    const dir = repo()
    git(dir, "tag", "v1.2.0")
    for (const m of ["feat(api): add search", "fix: handle empty carts", "chore: tidy", "feat!: new auth flow\n\nBREAKING CHANGE: tokens from v1 are no longer accepted", "random message"]) git(dir, "commit", "--allow-empty", "-qm", m)
    const commits = readCommits(dir, "v1.2.0..HEAD")
    expect(nextVersion("v1.2.0", commits)).toBe("2.0.0")
    expect(nextVersion("0.3.1", commits)).toBe("0.4.0")
    expect(nextVersion("1.0.0", commits.filter((c) => c.type === "fix"))).toBe("1.0.1")
    const text = changelog(commits, { version: "2.0.0", date: "2026-01-01" })
    expect(text).toContain("## 2.0.0 (2026-01-01)")
    expect(text).toContain("### ⚠ Breaking changes\n\n- tokens from v1 are no longer accepted")
    expect(text).toMatch(/### Features\n\n(- .*\n)*- \*\*api:\*\* add search/)
    expect(text).toContain("### Bug fixes\n\n- handle empty carts")
    expect(text).not.toContain("tidy")
    write(dir, "CHANGELOG.md", "# Changelog\n\n## 1.2.0 (2025-12-01)\n\n- old\n")
    const r = await cli("commitsmith", ["changelog", "--write", "CHANGELOG.md", "-f", "json"], dir)
    expect(r.json().summary["suggested version"]).toBe("2.0.0")
    expect(r.json().findings[0].rule).toBe("non-conventional")
    const file = readFileSync(`${dir}/CHANGELOG.md`, "utf8")
    expect(file.indexOf("## 2.0.0")).toBeLessThan(file.indexOf("## 1.2.0"))
    expect(file.startsWith("# Changelog\n\n## 2.0.0")).toBe(true)
  })
})

describe("scan and hooks", () => {
  it("blocks sensitive files and secrets in staged changes, masked", async () => {
    expect(sensitiveFile(".env")).toBe("environment file")
    expect(sensitiveFile(".env.example")).toBeNull()
    expect(sensitiveFile("certs/server.key")).toBeTruthy()
    expect(sensitiveFile("test/fixtures/server.key")).toBeNull()
    const hits = scanDiff("+++ b/src/x.ts\n@@ -0,0 +1,3 @@\n+const a = 1\n+const key = 'AKIAABCDEFGHIJKLMNOP'\n+const example = 'AKIAEXAMPLEEXAMPLE12'\n")
    expect(hits).toEqual([{ file: "src/x.ts", line: 2, kind: "AWS access key", preview: "AK…(20 chars)" }])
    // Test fixtures and ignore comments are skipped unless asked.
    const testDiff = "+++ b/test/x.test.ts\n@@ -0,0 +1 @@\n+const key = 'AKIAABCDEFGHIJKLMNOP'\n+++ b/src/y.ts\n@@ -0,0 +1 @@\n+const k = 'AKIAABCDEFGHIJKLMNOP' // commitsmith-ignore\n"
    expect(scanDiff(testDiff)).toEqual([])
    expect(scanDiff(testDiff, { includeTests: true })).toHaveLength(1)

    const dir = repo()
    write(dir, ".env", "SECRET=1")
    write(dir, "src/pay.ts", 'const stripe = "sk_live_' + "a1".repeat(12) + '"\n')
    git(dir, "add", "-A")
    const r = await cli("commitsmith", ["scan", "-f", "json"], dir)
    expect(r.code).toBe(1)
    const msgs = r.json().findings.map((f: { message: string }) => f.message)
    expect(msgs).toContain(".env looks like an environment file")
    expect(msgs.some((m: string) => m.startsWith("Possible Stripe live key"))).toBe(true)
    expect(r.stdout).not.toContain("a1a1a1a1")
  })

  it("installs hooks that lint messages, without clobbering existing ones", async () => {
    const dir = repo()
    write(dir, ".git/hooks/pre-commit", "#!/bin/sh\necho existing\n")
    const r = await cli("commitsmith", ["hook"], dir)
    expect(r.stdout).toContain("installed commit-msg, appended to existing pre-commit")
    expect(readFileSync(`${dir}/.git/hooks/pre-commit`, "utf8")).toMatch(/echo existing[\s\S]*commitsmith scan/)
    expect(readFileSync(`${dir}/.git/hooks/commit-msg`, "utf8")).toContain('commitsmith lint --file "$1"')
    expect((await cli("commitsmith", ["hook", "--uninstall"], dir)).stdout).toContain("removed")
  })
})
