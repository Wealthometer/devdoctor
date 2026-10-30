import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { exists, readJson, readLines, readText, walk } from "../core/fs.js"
import { allDeps, lockfiles, readPkg, workspaceDirs, type PackageJson } from "../core/project.js"
import type { Finding, Severity, ToolDef, ToolResult } from "../core/types.js"
import { findUsages, NODE_INTERNAL } from "./envdoctor.js"

/**
 * RepoDoctor: scans a repository for engineering gaps that tend to become production problems,
 * and grades it. Each check belongs to a category; categories that don't apply (no TypeScript,
 * no Docker) are left out of the score instead of counting against it.
 */

export type Category = "tests" | "docs" | "typescript" | "scripts" | "ci" | "docker" | "hygiene"
type Check = Finding & { category: Category }

export const CATEGORY_LABEL: Record<Category, string> = { tests: "Tests", docs: "Documentation", typescript: "TypeScript", scripts: "npm scripts", ci: "CI (GitHub Actions)", docker: "Docker", hygiene: "Repository hygiene" }
const WEIGHT: Record<Category, number> = { tests: 20, docs: 10, typescript: 15, scripts: 15, ci: 15, docker: 10, hygiene: 15 }
const PENALTY: Record<Severity, number> = { error: 35, warning: 15, info: 4 }

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/
const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.[jt]s$/
const DEFAULT_TEST_SCRIPT = /no test specified/

/** Binaries that come with Node or common package managers, not from node_modules. */
export const BUILTIN_BINS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "corepack", "echo", "cd", "rm", "cp", "mv", "mkdir", "cat", "test", "true", "false", "exit", "sh", "bash", "env", "export", "set", "sleep", "chmod", "ln", "touch", "find", "grep", "sed", "git", "docker", "make", "curl", "tar", "zip", "unzip", "open", "xargs", "if", "then", "else", "fi", "for", "do", "done", "while", "[", "kill", "printf", "tee", "wait", "ls", "pwd", "which", "node-gyp", "python", "python3", "go", "cargo", "deno"])

/** Bin names that differ from their package name. */
export const BIN_PACKAGES: Record<string, string[]> = {
  tsc: ["typescript"], tsserver: ["typescript"], "ts-node": ["ts-node"], tsx: ["tsx"], vite: ["vite"], vitest: ["vitest"], jest: ["jest"], eslint: ["eslint"], prettier: ["prettier"],
  next: ["next"], nuxt: ["nuxt", "nuxi"], nuxi: ["nuxi", "nuxt"], "react-scripts": ["react-scripts"], webpack: ["webpack-cli", "webpack"], "webpack-dev-server": ["webpack-dev-server"], rollup: ["rollup"],
  esbuild: ["esbuild"], tsup: ["tsup"], nodemon: ["nodemon"], concurrently: ["concurrently"], "cross-env": ["cross-env"], playwright: ["@playwright/test", "playwright"], cypress: ["cypress"],
  mocha: ["mocha"], ava: ["ava"], c8: ["c8"], nyc: ["nyc"], prisma: ["prisma"], "drizzle-kit": ["drizzle-kit"], knex: ["knex"], nest: ["@nestjs/cli"], ng: ["@angular/cli"], vue: ["@vue/cli"],
  "vue-tsc": ["vue-tsc"], svelte: ["svelte"], "svelte-kit": ["@sveltejs/kit"], "svelte-check": ["svelte-check"], astro: ["astro"], remix: ["@remix-run/dev"], turbo: ["turbo"], nx: ["nx"], lerna: ["lerna"],
  changeset: ["@changesets/cli"], husky: ["husky"], "lint-staged": ["lint-staged"], stylelint: ["stylelint"], tailwindcss: ["tailwindcss"], postcss: ["postcss-cli"], sass: ["sass"], biome: ["@biomejs/biome"],
  oxlint: ["oxlint"], "npm-run-all": ["npm-run-all", "npm-run-all2"], "run-s": ["npm-run-all", "npm-run-all2"], "run-p": ["npm-run-all", "npm-run-all2"], "ts-jest": ["ts-jest"], swc: ["@swc/cli"],
  babel: ["@babel/cli"], "wait-on": ["wait-on"], serve: ["serve"], "http-server": ["http-server"], typedoc: ["typedoc"], "api-extractor": ["@microsoft/api-extractor"], wrangler: ["wrangler"], vercel: ["vercel"],
  "electron-builder": ["electron-builder"], electron: ["electron"], expo: ["expo"], "react-native": ["react-native"], storybook: ["storybook", "@storybook/cli"], "sb": ["storybook"], "start-storybook": ["@storybook/react"], knip: ["knip"],
  devdoctor: ["devdoctor"], repodoctor: ["devdoctor"], migraguard: ["devdoctor"], envdoctor: ["devdoctor"], depscope: ["devdoctor"], archwatch: ["devdoctor"], commitsmith: ["devdoctor"], pulseapi: ["devdoctor"], loglens: ["devdoctor"],
}

type Ctx = { root: string; files: string[]; pkg: PackageJson | null; checks: Check[] }

function add(ctx: Ctx, category: Category, severity: Severity, rule: string, message: string, extra: Partial<Finding> = {}) {
  ctx.checks.push({ category, severity, rule: `${category}/${rule}`, message, ...extra })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
function checkTests(ctx: Ctx) {
  const tests = ctx.files.filter((f) => TEST_RE.test(f) && SOURCE_RE.test(f))
  const sources = ctx.files.filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && !/(\.config|\.d)\.[cm]?[jt]s$|(^|\/)(scripts?|bin|migrations?|seeds?|public|docs?|examples?)\//.test(f))
  const script = ctx.pkg?.scripts?.test
  if (!tests.length && sources.length) add(ctx, "tests", "error", "no-tests", `No test files found for ${sources.length} source files`, { hint: "Add tests next to the code (*.test.ts) or in a test/ folder." })
  else if (sources.length >= 20 && tests.length / sources.length < 0.1) add(ctx, "tests", "warning", "low-test-ratio", `Only ${tests.length} test files for ${sources.length} source files`, { hint: "Cover the most critical modules first: auth, payments, data writes." })
  if (ctx.pkg) {
    if (!script) add(ctx, "tests", tests.length ? "warning" : "error", "no-test-script", 'package.json has no "test" script', { file: "package.json", hint: 'Add "test": "vitest run" (or your runner) so CI and contributors run the same thing.' })
    else if (DEFAULT_TEST_SCRIPT.test(script)) add(ctx, "tests", "error", "placeholder-test-script", 'The "test" script is still npm\'s placeholder', { file: "package.json", hint: "Replace it with your test runner." })
    else if (/--passWithNoTests|--pass-with-no-tests|\|\|\s*true|;\s*exit 0/.test(script)) add(ctx, "tests", "warning", "test-script-cannot-fail", `The "test" script can pass without running tests: ${script}`, { file: "package.json" })
  }
  const coverage = ctx.files.some((f) => /(^|\/)(vitest|jest)\.config\.[cm]?[jt]s$/.test(f)) && Object.values(ctx.pkg?.scripts ?? {}).some((s) => /coverage/.test(s))
  if (tests.length && !coverage) add(ctx, "tests", "info", "no-coverage", "No coverage script found", { hint: 'Add "test:coverage" so you can see untested areas.' })
  return { tests: tests.length, sources: sources.length }
}

// ── Docs ──────────────────────────────────────────────────────────────────────
async function checkDocs(ctx: Ctx) {
  const readme = ctx.files.find((f) => /^readme(\.md|\.markdown|\.rst|\.txt)?$/i.test(f))
  if (!readme) add(ctx, "docs", "error", "no-readme", "No README at the repository root", { hint: "Explain what this is, how to run it and how to test it." })
  else {
    const text = await readText(join(ctx.root, readme))
    const words = text.split(/\s+/).filter(Boolean).length
    if (words < 60) add(ctx, "docs", "warning", "thin-readme", `README is very short (${words} words)`, { file: readme })
    const has = (re: RegExp) => re.test(text)
    if (!has(/^#+\s*(install|setup|getting started|quick ?start|run|usage|development)/im) && !has(/```(bash|sh|shell|console)?\s*\n\s*(npm|pnpm|yarn|bun|npx|docker)\b/m)) add(ctx, "docs", "warning", "readme-no-setup", "README doesn't explain how to install or run the project", { file: readme })
    if (ctx.pkg?.scripts?.test && !has(/\b(npm|pnpm|yarn|bun) (run )?test\b|^#+\s*test/im)) add(ctx, "docs", "info", "readme-no-tests", "README doesn't say how to run the tests", { file: readme })
  }
  if (!ctx.files.some((f) => /^(licen[cs]e|copying)(\.md|\.txt)?$/i.test(f)) && !ctx.pkg?.private) add(ctx, "docs", ctx.pkg?.license ? "info" : "warning", "no-license", "No LICENSE file", { hint: "Without one, others can't legally reuse the code." })
  if (ctx.pkg && !ctx.pkg.private) {
    if (!ctx.pkg.description) add(ctx, "docs", "info", "no-description", 'package.json has no "description"', { file: "package.json" })
    if (!ctx.pkg.repository && ctx.pkg.version && ctx.pkg.name) add(ctx, "docs", "info", "no-repository", 'package.json has no "repository" (npm and tools link back with it)', { file: "package.json" })
  }
  const envExampleNeeded = ctx.files.some((f) => /(^|\/)\.env$/.test(f)) || (await readsAppEnv(ctx))
  if (envExampleNeeded && !ctx.files.some((f) => /(^|\/)\.env\.(example|sample|template|dist)$/.test(f))) add(ctx, "docs", "warning", "no-env-example", "The code reads environment variables but there's no .env.example", { hint: "Document every variable with a safe example value (run: envdoctor check)." })
}

/** True when source code reads environment variables other than platform/runtime ones. */
async function readsAppEnv(ctx: Ctx) {
  for (const f of ctx.files.filter((x) => SOURCE_RE.test(x) && !TEST_RE.test(x)).slice(0, 600)) {
    try {
      if (findUsages(await readText(join(ctx.root, f)), f).some((u) => !NODE_INTERNAL.has(u.key))) return true
    } catch {}
  }
  return false
}

// ── TypeScript ────────────────────────────────────────────────────────────────
async function checkTypeScript(ctx: Ctx, dirs: string[]): Promise<boolean> {
  const tsFiles = ctx.files.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"))
  if (!tsFiles.length) return false
  for (const dir of dirs) {
    const prefix = dir === "." ? "" : `${dir}/`
    const own = tsFiles.filter((f) => f.startsWith(prefix) && (dir !== "." || !dirs.some((d) => d !== "." && f.startsWith(`${d}/`))))
    if (!own.length) continue
    const cfgPath = `${prefix}tsconfig.json`
    if (!exists(join(ctx.root, cfgPath))) {
      add(ctx, "typescript", "error", "no-tsconfig", `${own.length} TypeScript files${dir === "." ? "" : ` in ${dir}`} but no tsconfig.json`, { hint: "Without it, editors and tsc fall back to loose defaults." })
      continue
    }
    const opts = resolvedCompilerOptions(join(ctx.root, cfgPath))
    if (opts === null) {
      add(ctx, "typescript", "error", "invalid-tsconfig", `${cfgPath} can't be parsed`, { file: cfgPath })
      continue
    }
    if (opts.strict !== true) {
      const partial = ["noImplicitAny", "strictNullChecks"].filter((k) => opts[k] === true)
      add(ctx, "typescript", "error", "not-strict", `${cfgPath}: strict mode is off${partial.length ? ` (only ${partial.join(", ")})` : ""}`, { file: cfgPath, hint: 'Set "strict": true. It catches null and undefined bugs at compile time.' })
    } else {
      for (const k of ["noImplicitAny", "strictNullChecks", "strictFunctionTypes"]) if (opts[k] === false) add(ctx, "typescript", "warning", "strict-weakened", `${cfgPath}: strict is on but "${k}" is turned off`, { file: cfgPath })
    }
    if (opts.noUncheckedIndexedAccess !== true) add(ctx, "typescript", "info", "unchecked-index", `${cfgPath}: "noUncheckedIndexedAccess" is off, so arr[i] and obj[key] are never undefined to the compiler`, { file: cfgPath })
    if (opts.allowJs && !opts.checkJs) add(ctx, "typescript", "info", "unchecked-js", `${cfgPath}: JavaScript files are allowed but not type-checked`, { file: cfgPath })
  }
  const scripts = Object.values(ctx.pkg?.scripts ?? {}).join(" ")
  if (!/\btsc\b|vue-tsc|svelte-check|\btypecheck\b|tsc -b|tsc --build/.test(scripts) && !dirs.some((d) => d !== "." && /\btsc\b|vue-tsc|svelte-check/.test(Object.values(readPkg(join(ctx.root, d))?.scripts ?? {}).join(" ")))) {
    add(ctx, "typescript", "warning", "no-typecheck-script", "No script runs the type checker", { file: "package.json", hint: 'Add "typecheck": "tsc --noEmit" and run it in CI. Bundlers like Vite and esbuild don\'t check types.' })
  }
  // Escape hatches, counted across the codebase.
  let anys = 0
  let ignores = 0
  const worst: Record<string, number> = {}
  for (const f of tsFiles.filter((x) => !TEST_RE.test(x)).slice(0, 2000)) {
    let src: string
    try {
      src = await readText(join(ctx.root, f))
    } catch {
      continue
    }
    const a = (src.match(/:\s*any\b|\bas any\b|<any>/g) ?? []).length
    const i = (src.match(/@ts-(ignore|nocheck)/g) ?? []).length
    anys += a
    ignores += i
    if (a + i) worst[f] = a + i
  }
  const top = Object.entries(worst).sort((a, b) => b[1] - a[1])[0]
  if (ignores >= 5) add(ctx, "typescript", "warning", "ts-ignore", `${ignores} @ts-ignore/@ts-nocheck comments hide type errors`, { hint: "Prefer @ts-expect-error with a reason; it fails once the error is fixed." })
  if (anys >= Math.max(20, tsFiles.length * 1.5)) add(ctx, "typescript", "warning", "many-any", `${anys} uses of "any"${top ? ` (most in ${top[0]})` : ""}`, { hint: "Use unknown and narrow, or a real type." })
  return true
}

/** compilerOptions with "extends" applied (relative paths and installed packages). */
export function resolvedCompilerOptions(path: string, depth = 0): Record<string, any> | null {
  const json = readJson(path)
  if (!json) return null
  let base: Record<string, any> = {}
  const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : []
  for (const ext of parents) {
    if (depth > 5 || typeof ext !== "string") continue
    const dir = resolve(path, "..")
    let target = ext.startsWith(".") ? resolve(dir, ext) : resolve(dir, "node_modules", ext)
    if (!target.endsWith(".json")) target = exists(`${target}.json`) ? `${target}.json` : join(target, "tsconfig.json")
    const parent = resolvedCompilerOptions(target, depth + 1)
    if (parent) base = { ...base, ...parent }
  }
  return { ...base, ...(json.compilerOptions ?? {}) }
}

// ── npm scripts ───────────────────────────────────────────────────────────────
function checkScripts(ctx: Ctx, dirs: string[]) {
  if (!ctx.pkg) {
    if (ctx.files.some((f) => SOURCE_RE.test(f))) add(ctx, "scripts", "error", "no-package-json", "JavaScript/TypeScript files but no package.json")
    return
  }
  const rootDeps = allDeps(ctx.pkg)
  for (const dir of dirs) {
    const pkgFile = dir === "." ? "package.json" : `${dir}/package.json`
    const pkg: PackageJson | null = dir === "." ? ctx.pkg : readPkg(join(ctx.root, dir))
    if (!pkg) continue
    const scripts: Record<string, string> = pkg.scripts ?? {}
    const deps = { ...rootDeps, ...allDeps(pkg) }
    const hasTs = ctx.files.some((f) => f.startsWith(dir === "." ? "" : `${dir}/`) && /\.tsx?$/.test(f))
    for (const [name, cmd] of Object.entries(scripts)) {
      // npm run <x> / pnpm <x> / yarn <x> pointing at scripts that don't exist.
      for (const m of cmd.matchAll(/\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/g)) {
        const target = m[1]!
        const isPmCommand = ["install", "i", "ci", "add", "exec", "dlx", "x", "-w", "--workspace", "-r", "--filter", "publish", "test", "build", "start"].includes(target)
        if (!isPmCommand && !scripts[target] && !/(-w|--workspace|--filter|-r)\b/.test(cmd)) add(ctx, "scripts", "error", "missing-script", `"${name}" runs "${target}", which isn't a script in ${pkgFile}`, { file: pkgFile })
      }
      // Binaries that aren't installed.
      for (const segment of cmd.split(/&&|\|\||[;|&]/)) {
        const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w))
        let bin = words[0]
        if (!bin) continue
        if (bin === "npx" || bin === "pnpx" || bin === "bunx" || (bin === "pnpm" && words[1] === "exec") || (bin === "yarn" && words[1] && !["run", "install", "add", "workspace", "workspaces"].includes(words[1]) && !scripts[words[1]])) {
          bin = words.find((w, i) => i > 0 && !w.startsWith("-") && w !== "exec") ?? ""
          if (bin.includes("@") && !bin.startsWith("@")) bin = bin.split("@")[0]!
          if (!bin || bin === words[0]) continue
          if (bin.startsWith("@")) bin = bin.split("/")[1] ?? bin
        }
        if (BUILTIN_BINS.has(bin) || bin.startsWith(".") || bin.startsWith("/") || bin.includes("$") || bin.startsWith("-")) continue
        const candidates = BIN_PACKAGES[bin] ?? [bin]
        const installedBin = exists(join(ctx.root, "node_modules", ".bin", bin)) || exists(join(ctx.root, dir, "node_modules", ".bin", bin))
        if (!candidates.some((p) => deps[p]) && !installedBin) add(ctx, "scripts", "error", "missing-binary", `"${name}" calls "${bin}", but no dependency provides it`, { file: pkgFile, hint: `Add ${candidates[0]} to devDependencies.` })
      }
      // `node file.js` / `tsx src/x.ts` pointing at files that don't exist.
      for (const m of cmd.matchAll(/\b(?:node|tsx|ts-node|bun)\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:[cm]?[jt]s))\b/g)) {
        const file = m[1]!
        const rel = join(dir, file)
        const isBuildOutput = /(^|\/)(dist|build|out|lib)\//.test(file)
        if (!isBuildOutput && !exists(join(ctx.root, rel))) add(ctx, "scripts", "error", "missing-file", `"${name}" runs ${file}, which doesn't exist`, { file: pkgFile })
      }
    }
    if (dir === "." && workspaceDirs(ctx.root).length) continue
    if (!scripts.build && hasTs && (pkg.main || pkg.bin || pkg.exports)) add(ctx, "scripts", "warning", "no-build-script", `${pkgFile} is published as a package but has no "build" script`, { file: pkgFile })
    if (!scripts.lint && !Object.keys(deps).some((d) => /eslint|biome|oxlint|xo|standard/.test(d))) add(ctx, "scripts", "info", "no-linter", `No linter configured${dir === "." ? "" : ` for ${dir}`}`, { file: pkgFile, hint: "ESLint or Biome catch bugs the compiler can't." })
    if (!scripts.start && !scripts.dev && !pkg.main && !pkg.bin && !pkg.exports && dir === ".") add(ctx, "scripts", "info", "no-entry", 'No "start" or "dev" script and no package entry point', { file: pkgFile })
  }
  const locks = lockfiles(ctx.root)
  if (!locks.length) add(ctx, "scripts", "warning", "no-lockfile", "No lockfile is committed", { hint: "Commit package-lock.json (or yarn/pnpm lock) so every install gets the same versions." })
  if (locks.length > 1) add(ctx, "scripts", "warning", "multiple-lockfiles", `Multiple lockfiles: ${locks.join(", ")}`, { hint: "Pick one package manager and delete the other lockfiles." })
  if (!ctx.pkg.engines?.node) add(ctx, "scripts", "info", "no-engines", 'No "engines.node" in package.json', { file: "package.json", hint: "Declare the Node versions you support." })
}

// ── GitHub Actions ────────────────────────────────────────────────────────────
async function checkCI(ctx: Ctx) {
  const workflows = ctx.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  const otherCI = ctx.files.some((f) => /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|\.travis\.yml|Jenkinsfile)$/.test(f))
  if (!workflows.length) {
    if (!otherCI) add(ctx, "ci", "error", "no-ci", "No CI workflows (.github/workflows)", { hint: "Run tests, type checks and the build on every pull request." })
    return
  }
  let runsTests = false
  let runsTypecheck = false
  let onPR = false
  for (const wf of workflows) {
    const text = await readText(join(ctx.root, wf))
    let doc: any
    try {
      doc = parseYaml(text)
    } catch (err) {
      add(ctx, "ci", "error", "invalid-yaml", `${wf} is not valid YAML: ${(err as Error).message.split("\n")[0]}`, { file: wf })
      continue
    }
    if (!doc || typeof doc !== "object" || !doc.jobs) {
      add(ctx, "ci", "error", "no-jobs", `${wf} has no jobs`, { file: wf })
      continue
    }
    const on = doc.on ?? doc[true as unknown as string] // YAML 1.1 parses bare `on` as true in some parsers
    const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {})
    if (triggers.includes("pull_request") || triggers.includes("pull_request_target")) onPR = true
    if (triggers.includes("pull_request_target") && /actions\/checkout/.test(text) && /github\.event\.pull_request\.head/.test(text)) add(ctx, "ci", "error", "pr-target-checkout", `${wf} checks out pull request code under pull_request_target, which runs it with write access and secrets`, { file: wf })
    if (!doc.permissions && !Object.values<any>(doc.jobs).every((j) => j?.permissions)) add(ctx, "ci", "info", "no-permissions", `${wf} doesn't restrict GITHUB_TOKEN permissions`, { file: wf, hint: "Add `permissions: contents: read` at the top and widen per job." })
    const lines = text.split("\n")
    lines.forEach((l, i) => {
      const uses = l.match(/uses:\s*["']?([\w.-]+\/[\w./-]+)@([\w.-]+)/)
      if (uses && /^(main|master|latest|HEAD|dev|develop)$/.test(uses[2]!)) add(ctx, "ci", "warning", "unpinned-action", `${uses[1]}@${uses[2]} follows a moving branch`, { file: wf, line: i + 1, hint: "Pin to a release tag (or a commit SHA for third-party actions)." })
      if (/^\s*(run:|-)?.*\b(echo|printf|cat)\b.*\$\{\{\s*secrets\./.test(l)) add(ctx, "ci", "error", "secret-echo", "A secret is printed in a run step", { file: wf, line: i + 1 })
      if (/node-version:\s*["']?(1[0-6]|[0-9])(\.|["']?\s*$)/.test(l)) add(ctx, "ci", "warning", "old-node", `CI uses an end-of-life Node version: ${l.trim()}`, { file: wf, line: i + 1 })
    })
    if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bplaywright test\b|\bmocha\b|\bnode --test\b|turbo (run )?test/.test(text)) runsTests = true
    if (/\btypecheck\b|\btsc\b|vue-tsc|svelte-check|turbo (run )?typecheck/.test(text)) runsTypecheck = true
    for (const [name, job] of Object.entries<any>(doc.jobs)) {
      if (job && typeof job === "object" && !job["timeout-minutes"] && !job.uses) add(ctx, "ci", "info", "no-timeout", `Job "${name}" in ${wf} has no timeout-minutes (the default is 6 hours)`, { file: wf })
    }
  }
  if (!onPR) add(ctx, "ci", "warning", "no-pr-trigger", "No workflow runs on pull requests", { hint: "Add `on: pull_request` so problems are caught before merging." })
  if (!runsTests && ctx.pkg?.scripts?.test) add(ctx, "ci", "error", "ci-no-tests", "CI never runs the tests")
  if (!runsTypecheck && ctx.files.some((f) => /\.tsx?$/.test(f)) && !/\btsc\b/.test(ctx.pkg?.scripts?.build ?? "")) add(ctx, "ci", "warning", "ci-no-typecheck", "CI doesn't run the type checker")
}

// ── Docker ────────────────────────────────────────────────────────────────────
async function checkDocker(ctx: Ctx): Promise<boolean> {
  const dockerfiles = ctx.files.filter((f) => /(^|\/)(Dockerfile|[\w.-]+\.Dockerfile|Dockerfile\.[\w.-]+)$/.test(f))
  const composeFiles = ctx.files.filter((f) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f))
  if (!dockerfiles.length && !composeFiles.length) return false
  for (const df of dockerfiles) {
    const dir = df.includes("/") ? df.slice(0, df.lastIndexOf("/")) : "."
    const lines = (await readText(join(ctx.root, df))).split("\n")
    // Join continuation lines but remember where each instruction started.
    const instructions: { op: string; args: string; line: number }[] = []
    for (let i = 0; i < lines.length; i++) {
      const start = i
      let l = lines[i]!
      while (l.trimEnd().endsWith("\\") && i + 1 < lines.length) l = l.trimEnd().slice(0, -1) + " " + lines[++i]
      const m = l.trim().match(/^([A-Za-z]+)\s+(.*)$/)
      if (m && !l.trim().startsWith("#")) instructions.push({ op: m[1]!.toUpperCase(), args: m[2]!, line: start + 1 })
    }
    const froms = instructions.filter((x) => x.op === "FROM")
    const stageNames = new Set(froms.map((f) => f.args.match(/\bAS\s+(\S+)/i)?.[1]?.toLowerCase()).filter(Boolean))
    for (const f of froms) {
      const image = f.args.replace(/--platform=\S+\s+/, "").split(/\s+/)[0]!
      if (stageNames.has(image.toLowerCase()) || image === "scratch" || image.includes("$")) continue
      if (!image.includes(":") && !image.includes("@")) add(ctx, "docker", "warning", "untagged-image", `${df}: FROM ${image} has no tag, so it means "latest"`, { file: df, line: f.line, hint: "Pin a version, e.g. node:22-alpine." })
      else if (/:latest$/.test(image)) add(ctx, "docker", "warning", "latest-tag", `${df}: FROM ${image} changes under you`, { file: df, line: f.line })
    }
    const finalStage = instructions.slice(instructions.lastIndexOf(froms[froms.length - 1]!))
    const user = finalStage.filter((x) => x.op === "USER").pop()
    const finalImage = froms[froms.length - 1]?.args ?? ""
    if ((!user || /^(root|0)(:|$)/.test(user.args.trim())) && !/distroless.*nonroot|chainguard/.test(finalImage)) add(ctx, "docker", "warning", "runs-as-root", `${df}: the container runs as root`, { file: df, hint: "Add `USER node` (or another unprivileged user) in the final stage." })
    if (!finalStage.some((x) => x.op === "HEALTHCHECK") && finalStage.some((x) => x.op === "EXPOSE")) add(ctx, "docker", "info", "no-healthcheck", `${df}: no HEALTHCHECK for a service that exposes a port`, { file: df })
    for (const x of instructions) {
      if (x.op === "ADD" && /https?:\/\//.test(x.args)) add(ctx, "docker", "warning", "add-url", `${df}: ADD downloads from a URL without verification`, { file: df, line: x.line, hint: "Use curl with a checksum, or COPY." })
      if ((x.op === "ENV" || x.op === "ARG") && /\b[\w]*(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY)[\w]*\s*=\s*\S+/i.test(x.args) && !/=\s*\$\{?\w/.test(x.args)) add(ctx, "docker", "error", "secret-in-image", `${df}: a secret value is baked into the image with ${x.op}`, { file: df, line: x.line, hint: "Pass secrets at runtime (environment, secret mounts), never in the Dockerfile." })
      if (x.op === "RUN" && /apt-get install/.test(x.args) && !/rm -rf \/var\/lib\/apt\/lists/.test(x.args)) add(ctx, "docker", "info", "apt-cache", `${df}: apt-get install without cleaning the package lists`, { file: df, line: x.line })
      if (x.op === "RUN" && /\bnpm install\b/.test(x.args) && !/--(omit|only)=|--production|npm ci/.test(x.args)) add(ctx, "docker", "info", "npm-install", `${df}: "npm install" in an image; "npm ci" is reproducible from the lockfile`, { file: df, line: x.line })
    }
    const copyAllIdx = instructions.findIndex((x) => x.op === "COPY" && /^(--\S+\s+)*\.\s+\.?/.test(x.args))
    const installIdx = instructions.findIndex((x) => x.op === "RUN" && /\b(npm (ci|install)|pnpm install|yarn( install)?)\b/.test(x.args))
    if (copyAllIdx !== -1 && installIdx > copyAllIdx) add(ctx, "docker", "info", "cache-busting-copy", `${df}: everything is copied before installing dependencies, so any code change reinstalls them`, { file: df, line: instructions[copyAllIdx]!.line, hint: "COPY package*.json first, install, then COPY the rest." })
    const ignorePath = dir === "." ? ".dockerignore" : `${dir}/.dockerignore`
    const ignores = [...readLines(join(ctx.root, ignorePath)), ...readLines(join(ctx.root, ".dockerignore"))]
    if (!exists(join(ctx.root, ignorePath)) && !exists(join(ctx.root, ".dockerignore"))) add(ctx, "docker", "warning", "no-dockerignore", `No .dockerignore for ${df}, so node_modules, .git and .env end up in the build context`, { file: df })
    else if (copyAllIdx !== -1 && !ignores.some((l) => /^\/?\.env/.test(l.trim()) || l.trim() === "*")) add(ctx, "docker", "warning", "env-in-context", `.dockerignore doesn't exclude .env, and ${df} copies the whole directory`, { file: ignorePath })
  }
  for (const cf of composeFiles) {
    let doc: any
    try {
      doc = parseYaml(await readText(join(ctx.root, cf)))
    } catch (err) {
      add(ctx, "docker", "error", "invalid-compose", `${cf} is not valid YAML: ${(err as Error).message.split("\n")[0]}`, { file: cf })
      continue
    }
    for (const [name, svc] of Object.entries<any>(doc?.services ?? {})) {
      if (!svc || typeof svc !== "object") continue
      if (svc.privileged) add(ctx, "docker", "warning", "privileged", `${cf}: service "${name}" runs privileged`, { file: cf })
      if (typeof svc.image === "string" && !svc.build && (!svc.image.includes(":") || svc.image.endsWith(":latest")) && !svc.image.includes("${")) add(ctx, "docker", "info", "compose-latest", `${cf}: service "${name}" uses ${svc.image} without a fixed version`, { file: cf })
      const env = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e: string) => e.split("="))) : svc.environment ?? {}
      for (const [k, v] of Object.entries(env)) if (/SECRET|PASSWORD|TOKEN|API_KEY/i.test(k) && typeof v === "string" && v && !v.includes("${") && !/^(postgres|password|secret|changeme|example)$/i.test(v)) add(ctx, "docker", "warning", "compose-secret", `${cf}: "${name}" has ${k} written in the file`, { file: cf, hint: "Reference it from .env with ${" + k + "}." })
    }
  }
  return true
}

// ── Hygiene ───────────────────────────────────────────────────────────────────
function tracked(root: string): Set<string> | null {
  try {
    return new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean))
  } catch {
    return null
  }
}

async function checkHygiene(ctx: Ctx) {
  const gitignore = readLines(join(ctx.root, ".gitignore")).map((l) => l.trim())
  if (!exists(join(ctx.root, ".gitignore"))) add(ctx, "hygiene", "error", "no-gitignore", "No .gitignore")
  else {
    if (ctx.pkg && !gitignore.some((l) => /^\/?node_modules\/?$/.test(l) || l === "node_modules/**")) add(ctx, "hygiene", "error", "node-modules-not-ignored", ".gitignore doesn't exclude node_modules", { file: ".gitignore" })
    if (!gitignore.some((l) => /^\/?\.env(\*|\.\*|\.local)?$/.test(l) || l === "*.env")) add(ctx, "hygiene", "warning", "env-not-ignored", ".gitignore doesn't exclude .env files", { file: ".gitignore", hint: "Add .env and .env.* (with !.env.example)." })
  }
  const git = tracked(ctx.root)
  const committed = git ? [...git] : ctx.files
  for (const f of committed) {
    const name = f.split("/").pop()!
    if (/^\.env(\.(local|production|prod|development|dev|staging|test))?$/.test(name)) add(ctx, "hygiene", "error", "env-committed", `${f} is ${git ? "committed" : "present and may be committed"}`, { file: f, hint: "Remove it from git, rotate the secrets inside, and ignore it." })
    if (/^(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|p12|pfx|key|keystore|jks)$/.test(name) && !/(test|fixture|example|mock)/i.test(f)) add(ctx, "hygiene", "error", "key-committed", `${f} looks like a private key or certificate store`, { file: f })
    if (/^node_modules\//.test(f)) {
      add(ctx, "hygiene", "error", "node-modules-committed", "node_modules is committed", { hint: "git rm -r --cached node_modules" })
      break
    }
  }
  for (const f of committed.slice(0, 20_000)) {
    try {
      const size = statSync(join(ctx.root, f)).size
      if (size > 5 * 1024 * 1024 && !/\.(lock|lockb)$|lock\.(json|yaml)$/.test(f)) add(ctx, "hygiene", "warning", "large-file", `${f} is ${(size / 1024 / 1024).toFixed(1)} MB`, { file: f, hint: "Large binaries slow every clone; use Git LFS or external storage." })
    } catch {}
  }
  if (!ctx.files.some((f) => /^\.(editorconfig|prettierrc(\.\w+)?|prettier\.config\.[cm]?js)$|^biome\.jsonc?$/.test(f)) && !ctx.pkg?.prettier) add(ctx, "hygiene", "info", "no-formatter", "No shared formatter config (Prettier, Biome or .editorconfig)")
  let todos = 0
  for (const f of ctx.files.filter((x) => SOURCE_RE.test(x)).slice(0, 2000)) {
    try {
      todos += ((await readText(join(ctx.root, f))).match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length
    } catch {}
  }
  if (todos >= 25) add(ctx, "hygiene", "info", "many-todos", `${todos} TODO/FIXME comments in the code`)
}

export function scoreChecks(checks: Check[], applicable: Category[]) {
  const per: Record<string, number> = {}
  for (const cat of applicable) {
    const penalty = checks.filter((c) => c.category === cat).reduce((n, c) => n + PENALTY[c.severity], 0)
    per[cat] = Math.max(0, 100 - penalty)
  }
  const totalWeight = applicable.reduce((n, c) => n + WEIGHT[c], 0)
  const overall = totalWeight ? Math.round(applicable.reduce((n, c) => n + per[c]! * WEIGHT[c], 0) / totalWeight) : 100
  return { per, overall }
}

export async function scanRepo(root: string, opts: { skip?: Category[] } = {}): Promise<ToolResult> {
  const files = await walk(root, { respectGitignore: true })
  const ctx: Ctx = { root, files, pkg: readPkg(root), checks: [] }
  const dirs = [".", ...workspaceDirs(root)]
  const skip = new Set(opts.skip ?? [])
  const applicable: Category[] = []
  const run = async (cat: Category, fn: () => unknown) => {
    if (skip.has(cat)) return
    const applies = await fn()
    if (applies !== false) applicable.push(cat)
  }
  let testStats = { tests: 0, sources: 0 }
  await run("tests", () => {
    testStats = checkTests(ctx)
  })
  await run("docs", () => checkDocs(ctx))
  await run("typescript", () => checkTypeScript(ctx, dirs))
  await run("scripts", () => checkScripts(ctx, dirs))
  await run("ci", () => checkCI(ctx))
  await run("docker", () => checkDocker(ctx))
  await run("hygiene", () => checkHygiene(ctx))

  const { per, overall } = scoreChecks(ctx.checks, applicable)
  const all: Category[] = ["tests", "docs", "typescript", "scripts", "ci", "docker", "hygiene"]
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 65 ? "C" : overall >= 50 ? "D" : "F"
  return {
    tool: "repodoctor",
    title: `RepoDoctor: ${ctx.pkg?.name ?? basename(root)}`,
    score: overall,
    summary: { grade, files: files.length, "test files": testStats.tests, workspaces: dirs.length - 1 },
    sections: [
      {
        kind: "table",
        title: "Health by area",
        headers: ["Area", "Score", "Problems"],
        rows: all.map((cat) => [CATEGORY_LABEL[cat], applicable.includes(cat) ? `${per[cat]}` : "n/a", applicable.includes(cat) ? ctx.checks.filter((c) => c.category === cat && c.severity !== "info").length : "–"]),
      },
    ],
    findings: ctx.checks.map(({ category: _c, ...f }) => f),
  }
}

export const repodoctor: ToolDef = {
  name: "repodoctor",
  tagline: "Grade a repository's tests, docs, TypeScript, scripts, CI, Docker and hygiene",
  commands: {
    scan: {
      description: "Scan a repository and print a health score with actionable fixes",
      usage: "[dir]",
      options: {
        skip: { type: "string", multiple: true, description: "Skip an area: tests, docs, typescript, scripts, ci, docker, hygiene" },
        "min-score": { type: "string", description: "Add an error when the score is below this (for CI)" },
      },
      async run(ctx) {
        const root = resolve(ctx.cwd, ctx.positionals[0] ?? ".")
        if (!exists(root)) throw new (await import("../core/types.js")).UsageError(`Directory not found: ${ctx.positionals[0]}`)
        ctx.log(`Scanning ${root}…`)
        const skip = [...((ctx.options.skip as string[] | undefined) ?? []), ...((ctx.config.skip as string[] | undefined) ?? [])] as Category[]
        const result = await scanRepo(root, { skip })
        const min = Number(ctx.options["min-score"] ?? ctx.config.minScore ?? NaN)
        if (!Number.isNaN(min) && result.score! < min) result.findings.push({ rule: "score/below-minimum", severity: "error", message: `Health score ${result.score} is below the required ${min}` })
        return result
      },
    },
  },
}
