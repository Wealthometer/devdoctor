import { describe, expect, it } from "vitest"
import { scanRepo } from "../src/tools/repodoctor.js"
import { cli, fixture, git, gitInit, rules } from "./helpers.js"

const goodRepo = () =>
  fixture({
    "package.json": {
      name: "good", version: "1.0.0", description: "A tidy service", license: "MIT", repository: "github:x/good", engines: { node: ">=20" },
      scripts: { build: "tsc -p .", test: "vitest run", "test:coverage": "vitest run --coverage", typecheck: "tsc --noEmit", lint: "eslint .", dev: "tsx watch src/index.ts" },
      devDependencies: { typescript: "5.9.0", vitest: "3.0.0", eslint: "9.0.0", tsx: "4.0.0" },
    },
    "package-lock.json": "{}",
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }',
    "vitest.config.ts": "export default {}",
    "README.md": "# Good\n\nA tidy service that does useful things for people who need them done, reliably and quickly, every single day of the week without fail. It handles retries, logging and graceful shutdown for you.\n\n## Install\n\n```bash\nnpm install\nnpm run dev\n```\n\n## Tests\n\nRun `npm test`. It covers everything that matters and more besides, so please keep it green and fast for everyone.\n",
    LICENSE: "MIT",
    ".gitignore": "node_modules\ndist\n.env\n",
    ".prettierrc": "{}",
    "src/index.ts": "export const add = (a: number, b: number) => a + b\n",
    "src/index.test.ts": "import { add } from './index'\n",
    ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm ci\n      - run: npm run typecheck\n      - run: npm test\n",
  })

describe("repodoctor", () => {
  it("gives a well-kept repo a high score with no errors", async () => {
    const r = await scanRepo(goodRepo())
    expect(r.findings.filter((f) => f.severity !== "info")).toEqual([])
    expect(r.score).toBeGreaterThanOrEqual(95)
    // No Docker → the area is left out instead of counting against the score.
    expect(r.sections![0]!.kind === "table" && r.sections![0]!.rows.find((x) => x[0] === "Docker")![1]).toBe("n/a")
  })

  it("finds the classic problems in a neglected repo", async () => {
    const dir = fixture({
      "package.json": { name: "messy", scripts: { test: 'echo "Error: no test specified" && exit 1', start: "nodemon server.js", build: "npm run compile", seed: "node scripts/seed.js" }, dependencies: { express: "4" } },
      "yarn.lock": "", "package-lock.json": "{}",
      "tsconfig.json": '{ "compilerOptions": { "target": "es2020" } }',
      "src/app.ts": "const x: any = 1\n// @ts-ignore\nprocess.env.SECRET_KEY",
      "src/b.ts": "", "src/c.ts": "",
      ".env": "SECRET_KEY=abc",
      Dockerfile: "FROM node\nCOPY . .\nRUN npm install\nENV API_KEY=sk_live_12345\nEXPOSE 3000\nCMD node dist/app.js\n",
      ".github/workflows/deploy.yml": "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@master\n      - run: echo ${{ secrets.TOKEN }}\n",
    })
    const r = await scanRepo(dir)
    const ids = rules(r)
    for (const id of [
      "tests/no-tests", "tests/placeholder-test-script", "docs/no-readme", "docs/no-env-example", "typescript/not-strict", "typescript/no-typecheck-script",
      "scripts/missing-binary", "scripts/missing-script", "scripts/missing-file", "scripts/multiple-lockfiles",
      "ci/unpinned-action", "ci/secret-echo", "ci/no-pr-trigger", "ci/ci-no-tests",
      "docker/untagged-image", "docker/runs-as-root", "docker/secret-in-image", "docker/no-dockerignore", "docker/cache-busting-copy",
      "hygiene/no-gitignore", "hygiene/env-committed",
    ]) expect(ids, id).toContain(id)
    expect(r.findings.find((f) => f.rule === "scripts/missing-binary")!.message).toContain("nodemon")
    expect(r.score).toBeLessThan(40)
  })

  it("uses git to see what's actually committed", async () => {
    const dir = gitInit(fixture({ ".gitignore": "node_modules\n.env\n", ".env": "A=1", "README.md": "# x" }))
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "init")
    expect(rules(await scanRepo(dir))).not.toContain("hygiene/env-committed")
    git(dir, "add", "-f", ".env")
    expect(rules(await scanRepo(dir))).toContain("hygiene/env-committed")
  })

  it("checks workspace packages and resolves tsconfig extends", async () => {
    const dir = fixture({
      "package.json": { name: "mono", private: true, workspaces: ["packages/*"], scripts: { test: "vitest run", typecheck: "tsc -b" }, devDependencies: { vitest: "3", typescript: "5" } },
      "tsconfig.base.json": '{ "compilerOptions": { "strict": true } }',
      "packages/a/package.json": { name: "a", scripts: { build: "tsup src/index.ts" } },
      "packages/a/tsconfig.json": '{ "extends": "../../tsconfig.base.json" }',
      "packages/a/src/index.ts": "export {}",
      "packages/b/package.json": { name: "b" },
      "packages/b/src/index.ts": "export {}",
    })
    const r = await scanRepo(dir)
    const msgs = r.findings.map((f) => f.message)
    expect(msgs.some((m) => m.includes('"build" calls "tsup"'))).toBe(true)
    expect(msgs.some((m) => m.includes("in packages/b but no tsconfig.json"))).toBe(true)
    expect(msgs.some((m) => m.includes("packages/a/tsconfig.json: strict mode is off"))).toBe(false)
  })

  it("fails CI below --min-score and supports --skip", async () => {
    const dir = fixture({ "src/a.js": "" })
    const r = await cli("repodoctor", ["scan", "--min-score", "90", "-f", "json"], dir)
    expect(r.code).toBe(1)
    expect(r.json().findings.some((f: { rule: string }) => f.rule === "score/below-minimum")).toBe(true)
    const skipped = await cli("repodoctor", ["--skip", "ci", "--skip", "docs", "-f", "json"], dir)
    expect(skipped.json().findings.some((f: { rule: string }) => f.rule.startsWith("ci/") || f.rule.startsWith("docs/"))).toBe(false)
  })
})
