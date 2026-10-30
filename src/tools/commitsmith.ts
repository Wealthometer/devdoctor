import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { mask } from "./envdoctor.js"
import { UsageError, type Finding, type ToolDef, type ToolResult } from "../core/types.js"

/**
 * CommitSmith: helps keep history clean. Suggests Conventional Commit messages from staged
 * changes, lints messages (also as a commit-msg hook), builds changelogs from history, and stops
 * secrets and sensitive files from being committed.
 */

export const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"] as const

export function git(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message).trim().split("\n")[0] ?? ""
    throw new UsageError(/not a git repository/i.test(msg) ? "Not inside a git repository" : `git ${args[0]} failed: ${msg}`)
  }
}

// ── Staged changes → suggestion ───────────────────────────────────────────────
export type Change = { status: "A" | "M" | "D" | "R" | "C" | "T"; path: string; from?: string; added: number; removed: number }

export function stagedChanges(cwd: string): { changes: Change[]; diff: string } {
  const status = git(cwd, ["diff", "--cached", "--name-status", "-M", "-z"]).split("\0").filter(Boolean)
  const numstat = git(cwd, ["diff", "--cached", "--numstat", "-M", "-z"])
  const counts = new Map<string, { added: number; removed: number }>()
  // -z numstat: "added\tremoved\tpath\0" or for renames "added\tremoved\t\0from\0to\0"
  const parts = numstat.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i]!.match(/^(\d+|-)\t(\d+|-)\t(.*)$/)
    if (!m) continue
    let path = m[3]!
    if (!path) {
      i += 2
      path = parts[i] ?? ""
    }
    counts.set(path, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) })
  }
  const changes: Change[] = []
  for (let i = 0; i < status.length; i++) {
    const code = status[i]!
    const kind = code[0] as Change["status"]
    if (kind === "R" || kind === "C") {
      const from = status[++i]!
      const to = status[++i]!
      changes.push({ status: kind, path: to, from, ...(counts.get(to) ?? { added: 0, removed: 0 }) })
    } else {
      const path = status[++i]!
      changes.push({ status: kind, path, ...(counts.get(path) ?? { added: 0, removed: 0 }) })
    }
  }
  const diff = git(cwd, ["diff", "--cached", "-M", "--unified=0", "--no-color"])
  return { changes, diff }
}

const isDoc = (p: string) => /\.(md|mdx|rst|txt|adoc)$/i.test(p) || /(^|\/)docs?\//.test(p) || /^(LICENSE|CHANGELOG|AUTHORS|CONTRIBUTING)/i.test(p.split("/").pop()!)
const isTest = (p: string) => /(^|\/)(__tests__|tests?|spec|e2e|__mocks__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/.test(p)
const isCI = (p: string) => /^\.github\/(workflows|actions)\/|^\.gitlab-ci\.yml$|^\.circleci\/|^azure-pipelines|^\.travis\.yml$|^Jenkinsfile$/.test(p)
const isBuild = (p: string) => /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig[\w.-]*\.json|Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|\.dockerignore|Makefile|(vite|webpack|rollup|tsup|esbuild|babel|turbo|nx)\.config\.[cm]?[jt]s|turbo\.json|\.npmrc|\.nvmrc)$/.test(p)
const isStyleConfig = (p: string) => /(^|\/)(\.prettierrc[\w.]*|\.editorconfig|\.eslintrc[\w.]*|eslint\.config\.[cm]?js|biome\.jsonc?|\.stylelintrc[\w.]*)$/.test(p)

/** Scope from the common folder: packages/api/* → api; src/auth/* → auth. */
export function scopeOf(paths: string[]): string | null {
  const scopes = paths.map((p) => {
    const parts = p.split("/")
    if (["packages", "apps", "libs", "services", "modules"].includes(parts[0]!) && parts.length > 2) return parts[1]!
    const i = parts.findIndex((x) => ["src", "lib", "app", "server", "client"].includes(x))
    if (i !== -1 && parts.length > i + 2) return parts[i + 1]!
    if (parts.length > 1 && !["src", "test", "tests", "docs", ".github"].includes(parts[0]!)) return parts[0]!
    return null
  })
  const unique = [...new Set(scopes)]
  return unique.length === 1 && unique[0] ? unique[0].replace(/[^\w-]/g, "").toLowerCase() || null : null
}

export type Suggestion = { type: string; scope: string | null; breaking: boolean; subject: string; body: string[]; message: string; reason: string }

/** Guesses the commit type and writes candidate messages. Heuristic by design: it's a starting point. */
export function suggest(changes: Change[], diff: string, opts: { maxSubject?: number } = {}): Suggestion[] {
  if (!changes.length) return []
  const paths = changes.map((c) => c.path)
  const all = (fn: (p: string) => boolean) => paths.every(fn)
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1))
  const whitespaceOnly = added.length > 0 && added.map((l) => l.replace(/\s+/g, "")).sort().join("\n") === removed.map((l) => l.replace(/\s+/g, "")).sort().join("\n")
  const removedExports = removed.filter((l) => /^export\s+(default\s+)?(async\s+)?(function|class|const|interface|type|enum)\s+(\w+)/.test(l)).map((l) => l.match(/(function|class|const|interface|type|enum)\s+(\w+)/)![2]!)
  const addedExports = added.filter((l) => /^export\s+(default\s+)?(async\s+)?(function|class|const|interface|type|enum)\s+(\w+)/.test(l)).map((l) => l.match(/(function|class|const|interface|type|enum)\s+(\w+)/)![2]!)
  const goneExports = removedExports.filter((e) => !addedExports.includes(e))
  const newRoutes = added.filter((l) => /\.(get|post|put|patch|delete)\(\s*['"`]\/|@(Get|Post|Put|Patch|Delete)\(|router\.(get|post)/.test(l)).length
  const fixWords = added.filter((l) => /\b(fix|bug|null|undefined|\?\.|catch|guard|throw new|validate|sanitize|escape|off-by-one|race)\b/i.test(l)).length
  const perfWords = added.filter((l) => /\b(cache|memo|useMemo|useCallback|debounce|throttle|batch|index|lazy|concurren|pool|stream)\w*/i.test(l)).length
  const depBump = changes.some((c) => /package\.json$/.test(c.path)) && /^[+-]\s+"[@\w/.-]+":\s*"[\^~]?\d/m.test(diff)
  const scope = scopeOf(paths.filter((p) => !isTest(p) && !isDoc(p))) ?? scopeOf(paths)

  let type: string
  let reason: string
  if (all(isDoc)) [type, reason] = ["docs", "only documentation changed"]
  else if (all(isTest)) [type, reason] = ["test", "only tests changed"]
  else if (all(isCI)) [type, reason] = ["ci", "only CI configuration changed"]
  else if (all((p) => isBuild(p) || isCI(p))) [type, reason] = [depBump ? "build" : "build", depBump ? "dependency versions changed" : "build configuration changed"]
  else if (whitespaceOnly || all(isStyleConfig)) [type, reason] = ["style", "formatting only"]
  else if (changes.every((c) => c.status === "R" || c.status === "D") || (goneExports.length && !addedExports.length && !newRoutes)) [type, reason] = ["refactor", "files moved or code removed"]
  else if (changes.some((c) => c.status === "A" && !isTest(c.path) && !isDoc(c.path)) || newRoutes || addedExports.length > removedExports.length) [type, reason] = ["feat", newRoutes ? "new routes" : "new files or exports"]
  else if (perfWords > fixWords && perfWords >= 2) [type, reason] = ["perf", "caching/batching changes"]
  else if (fixWords > 0 || added.length + removed.length < 40) [type, reason] = ["fix", "small change to existing code"]
  else [type, reason] = ["refactor", "changes to existing code"]

  const breaking = goneExports.length > 0 && type !== "test" && type !== "docs"
  const name = (p: string) => {
    const base = p.split("/").pop()!
    return base.replace(/\.(test|spec)?\.?[cm]?[jt]sx?$|\.\w+$/, "") || base
  }
  const relevant = changes.filter((c) => !isTest(c.path) || type === "test")
  // Many files across folders: name the folders instead of a random handful of files.
  const tops = [...new Set(relevant.map((c) => (c.path.includes("/") ? c.path.split("/")[0]! : "root files")))]
  const nouns = relevant.length > 6 && tops.length > 1 ? tops.slice(0, 3) : [...new Set(relevant.map((c) => name(c.path)))].slice(0, 3)
  const what = nouns.join(", ") + ((relevant.length > 6 && tops.length > 3) || (relevant.length <= 6 && relevant.length > 3) ? " and more" : "")
  const verb = { feat: "add", fix: "fix", docs: "document", style: "format", refactor: "restructure", perf: "speed up", test: "cover", build: depBump ? "update dependencies in" : "update build config for", ci: "update CI for", chore: "update", revert: "revert" }[type] ?? "update"
  const subjects: string[] = []
  if (type === "feat" && changes.some((c) => c.status === "A")) subjects.push(`add ${nouns.filter((n) => changes.some((c) => c.status === "A" && name(c.path) === n)).join(", ") || what}`)
  if (type === "build" && depBump) subjects.push(`bump ${depNames(diff).slice(0, 3).join(", ") || "dependencies"}`)
  if (type === "test") subjects.push(`add tests for ${nouns.join(", ")}`)
  if (type === "docs") subjects.push(`update ${nouns.join(", ")}`)
  subjects.push(`${verb} ${what}`.trim())
  if (scope) subjects.push(`${verb} ${scope}`)

  const max = opts.maxSubject ?? 72
  const body = changes.slice(0, 12).map((c) => `- ${({ A: "add", M: "update", D: "remove", R: "move", C: "copy", T: "update" } as const)[c.status]} ${c.from ? `${c.from} → ` : ""}${c.path}`)
  if (changes.length > 12) body.push(`- …and ${changes.length - 12} more files`)
  return [...new Set(subjects)].slice(0, 3).map((s) => {
    const header = `${type}${scope ? `(${scope})` : ""}${breaking ? "!" : ""}: ${s}`
    const subject = header.length > max ? header.slice(0, max - 1).replace(/[\s,]+\S*$/, "") : header
    const footer = breaking ? ["", `BREAKING CHANGE: removed export${goneExports.length > 1 ? "s" : ""} ${goneExports.slice(0, 5).join(", ")}`] : []
    return { type, scope, breaking, subject: s, body, message: [subject, "", ...body, ...footer].join("\n"), reason }
  })
}

function depNames(diff: string) {
  return [...new Set([...diff.matchAll(/^\+\s+"([@\w/.-]+)":\s*"[\^~]?\d/gm)].map((m) => m[1]!))]
}

// ── Lint ──────────────────────────────────────────────────────────────────────
export type LintOptions = { types?: string[]; scopes?: string[]; requireScope?: boolean; maxSubject?: number; maxBodyLine?: number }

export function lintMessage(message: string, o: LintOptions = {}): Finding[] {
  const f: Finding[] = []
  const lines = message.replace(/\r/g, "").split("\n").filter((l) => !l.startsWith("#"))
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const header = lines[0] ?? ""
  if (!header.trim()) return [{ rule: "empty", severity: "error", message: "The commit message is empty" }]
  if (/^(Merge|Revert ")|^fixup! |^squash! |^amend! /.test(header)) return []
  const m = header.match(/^(\w+)(?:\(([^)]*)\))?(!)?: (.*)$/)
  const types = o.types ?? [...TYPES]
  if (!m) {
    f.push({ rule: "format", severity: "error", message: `"${header}" isn't a Conventional Commit`, hint: `Write "type(scope): subject", e.g. "fix(auth): handle expired tokens". Types: ${types.join(", ")}` })
    return f
  }
  const [, type, scope, , subject] = m
  if (!types.includes(type!)) f.push({ rule: "type", severity: "error", message: `Unknown type "${type}"`, hint: `Use one of: ${types.join(", ")}` })
  if (type !== type!.toLowerCase()) f.push({ rule: "type-case", severity: "error", message: "The type must be lowercase" })
  if (o.requireScope && !scope) f.push({ rule: "scope-required", severity: "error", message: "A scope is required, e.g. feat(api): …" })
  if (scope !== undefined && !scope.trim()) f.push({ rule: "scope-empty", severity: "error", message: "The scope is empty" })
  if (scope && o.scopes?.length && !scope.split(/[,/]/).every((s) => o.scopes!.includes(s.trim()))) f.push({ rule: "scope", severity: "error", message: `Unknown scope "${scope}"`, hint: `Use one of: ${o.scopes.join(", ")}` })
  if (!subject!.trim()) f.push({ rule: "subject-empty", severity: "error", message: "The subject is empty" })
  const max = o.maxSubject ?? 72
  if (header.length > max) f.push({ rule: "header-length", severity: "error", message: `The first line is ${header.length} characters (max ${max})` })
  if (/\.$/.test(subject!)) f.push({ rule: "subject-period", severity: "warning", message: "Don't end the subject with a period" })
  if (/^[A-Z][a-z]/.test(subject!) && !/^[A-Z]{2,}/.test(subject!)) f.push({ rule: "subject-case", severity: "warning", message: "Start the subject in lowercase" })
  if (/^(added|adds|fixed|fixes|updated|updates|changed|changes|removed|removes|implemented|creates|created)\b/i.test(subject!)) f.push({ rule: "imperative", severity: "warning", message: `Use the imperative mood ("${imperative(subject!.split(" ")[0]!)}", not "${subject!.split(" ")[0]}")` })
  if (/^(wip|stuff|misc|update|changes|fix|minor|asdf|tmp|test)$/i.test(subject!.trim())) f.push({ rule: "vague", severity: "warning", message: `"${subject}" doesn't say what changed` })
  if (lines.length > 1 && lines[1]!.trim()) f.push({ rule: "body-blank-line", severity: "error", message: "Leave a blank line between the subject and the body" })
  const maxBody = o.maxBodyLine ?? 100
  lines.slice(2).forEach((l, i) => {
    if (l.length > maxBody && !/^\s*(https?:\/\/|\S+:\s*https?:\/\/)/.test(l)) f.push({ rule: "body-line-length", severity: "warning", message: `Body line ${i + 3} is ${l.length} characters (max ${maxBody})` })
  })
  for (const l of lines.slice(1)) if (/^BREAKING[- ]CHANGES?\b/i.test(l) && !/^BREAKING[- ]CHANGE: \S/.test(l)) f.push({ rule: "breaking-footer", severity: "error", message: 'Write the footer as "BREAKING CHANGE: <description>"' })
  return f
}

const imperative = (w: string) => {
  const l = w.toLowerCase()
  const map: Record<string, string> = { added: "add", adds: "add", fixed: "fix", fixes: "fix", updated: "update", updates: "update", changed: "change", changes: "change", removed: "remove", removes: "remove", implemented: "implement", creates: "create", created: "create" }
  return map[l] ?? l
}

// ── History → changelog ───────────────────────────────────────────────────────
export type Commit = { hash: string; type: string; scope: string | null; breaking: boolean; subject: string; body: string; breakingNote: string | null }

export function readCommits(cwd: string, range: string): Commit[] {
  const SEP = "\x1e"
  const FS = "\x1f"
  const out = git(cwd, ["log", range, "--no-merges", `--format=%H${FS}%s${FS}%b${SEP}`])
  return out
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, subjectLine, body = ""] = rec.split(FS)
      const m = subjectLine!.match(/^(\w+)(?:\(([^)]*)\))?(!)?: (.*)$/)
      const breakingNote = body.match(/^BREAKING[- ]CHANGE:\s*([\s\S]*?)(?:\n\n|$)/m)?.[1]?.trim() ?? null
      return m
        ? { hash: hash!, type: m[1]!.toLowerCase(), scope: m[2] ?? null, breaking: Boolean(m[3]) || Boolean(breakingNote), subject: m[4]!, body, breakingNote }
        : { hash: hash!, type: "other", scope: null, breaking: Boolean(breakingNote), subject: subjectLine!, body, breakingNote }
    })
}

export function latestTag(cwd: string): string | null {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null
  } catch {
    return null
  }
}

export function nextVersion(current: string | null, commits: Commit[]): string {
  const v = (current ?? "0.0.0").replace(/^v/, "").split("-")[0]!.split(".").map(Number)
  let [major = 0, minor = 0, patch = 0] = v
  const breaking = commits.some((c) => c.breaking)
  // Before 1.0, breaking changes bump the minor version (semver's 0.x convention).
  if (breaking && major >= 1) [major, minor, patch] = [major + 1, 0, 0]
  else if (breaking || commits.some((c) => c.type === "feat")) [minor, patch] = [minor + 1, 0]
  else patch += 1
  return `${major}.${minor}.${patch}`
}

const SECTIONS: [string, string][] = [["feat", "Features"], ["fix", "Bug fixes"], ["perf", "Performance"], ["refactor", "Refactoring"], ["docs", "Documentation"], ["build", "Build and dependencies"], ["revert", "Reverts"]]

export function changelog(commits: Commit[], o: { version: string; date?: string; repoUrl?: string | null; includeAll?: boolean }): string {
  const link = (h: string) => (o.repoUrl ? `[${h.slice(0, 7)}](${o.repoUrl}/commit/${h})` : h.slice(0, 7))
  const line = (c: Commit) => `- ${c.scope ? `**${c.scope}:** ` : ""}${c.subject} (${link(c.hash)})`
  const out = [`## ${o.version} (${o.date ?? new Date().toISOString().slice(0, 10)})`, ""]
  const breaking = commits.filter((c) => c.breaking)
  if (breaking.length) out.push("### ⚠ Breaking changes", "", ...breaking.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ""}${c.breakingNote ?? c.subject} (${link(c.hash)})`), "")
  for (const [type, title] of SECTIONS) {
    const list = commits.filter((c) => c.type === type)
    if (list.length) out.push(`### ${title}`, "", ...list.map(line), "")
  }
  if (o.includeAll) {
    const rest = commits.filter((c) => !SECTIONS.some(([t]) => t === c.type))
    if (rest.length) out.push("### Other changes", "", ...rest.map(line), "")
  }
  if (out.length === 2) out.push("_No user-facing changes._", "")
  return out.join("\n")
}

function repoUrl(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/) ?? url.match(/gitlab\.com[:/]([\w./-]+?)(?:\.git)?$/)
    return m ? `https://${url.includes("gitlab") ? "gitlab" : "github"}.com/${m[1]}` : null
  } catch {
    return null
  }
}

// ── Sensitive files and secrets ───────────────────────────────────────────────
const SENSITIVE_FILES: [RegExp, string][] = [
  [/(^|\/)\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/, "environment file"],
  [/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, "SSH private key"],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk)$/, "private key or certificate store"],
  [/(^|\/)(credentials|service-account|serviceAccountKey|gcloud-key)[\w-]*\.json$/, "cloud credentials"],
  [/(^|\/)\.(aws\/credentials|docker\/config\.json|kube\/config|netrc|pgpass|htpasswd)$/, "credentials file"],
  [/(^|\/)kubeconfig$/, "Kubernetes credentials"],
  [/\.(sqlite3?|db)$/, "database file"],
  [/(^|\/)(terraform\.tfstate(\.backup)?|\.terraform\/)/, "Terraform state (contains secrets)"],
]

const LINE_SECRETS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b(sk|rk)_live_[0-9a-zA-Z]{16,}/, "Stripe live key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, "OpenAI API key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "SendGrid key"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/, "private key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
  [/\/\/[^/\s:@]+:[^@\s/]{6,}@(?!localhost|127\.0\.0\.1|example)[\w.-]+/, "URL with a password"],
  [/\b(password|passwd|secret|api_?key|access_?token|auth_?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, "hard-coded credential"],
]

export type SecretHit = { file: string; line: number; kind: string; preview: string }

/** Test code is full of fake credentials; it's skipped unless includeTests is set. */
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|fixtures?|__fixtures__|__mocks__|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$/

export function scanDiff(diff: string, opts: { includeTests?: boolean } = {}): SecretHit[] {
  const hits: SecretHit[] = []
  let file = ""
  let line = 0
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "")
      continue
    }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (l.startsWith("+") && !l.startsWith("+++")) {
      const text = l.slice(1)
      const skipFile = /\.(md|lock)$|lock\.(json|yaml)$/.test(file) || (!opts.includeTests && TEST_PATH.test(file))
      if (!skipFile && !/(example|placeholder|dummy|fake|xxx|changeme|your[-_])/i.test(text) && !/commitsmith-ignore|pragma: allowlist secret/.test(text)) {
        for (const [re, kind] of LINE_SECRETS) {
          const m = text.match(re)
          if (m) {
            hits.push({ file, line, kind, preview: mask(m[0]) })
            break
          }
        }
      }
      line++
    } else if (!l.startsWith("-")) line++
  }
  return hits
}

export function sensitiveFile(path: string): string | null {
  for (const [re, kind] of SENSITIVE_FILES) if (re.test(path) && !/(^|\/)(test|tests|fixtures?|__fixtures__|examples?|mocks?)\//.test(path)) return kind
  return null
}

const article = (s: string) => `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`

// ── Hooks ─────────────────────────────────────────────────────────────────────
const HOOK_MARK = "# installed by commitsmith"
function hookScript(kind: "commit-msg" | "pre-commit") {
  const cmd = kind === "commit-msg" ? 'commitsmith lint --file "$1"' : "commitsmith scan"
  return `#!/bin/sh\n${HOOK_MARK}\nif command -v commitsmith >/dev/null 2>&1; then ${cmd}\nelif [ -x ./node_modules/.bin/commitsmith ]; then ./node_modules/.bin/${cmd}\nelse npx --no-install ${cmd}\nfi\n`
}

export const commitsmith: ToolDef = {
  name: "commitsmith",
  tagline: "Suggest and lint Conventional Commits, write changelogs, and block secrets from being committed",
  commands: {
    suggest: {
      description: "Suggest commit messages for the staged changes",
      usage: "[--raw]",
      options: { raw: { type: "boolean", description: 'Print only the best message, for: git commit -m "$(commitsmith suggest --raw)"' } },
      async run(ctx): Promise<ToolResult> {
        const { changes, diff } = stagedChanges(ctx.cwd)
        if (!changes.length) throw new UsageError("Nothing is staged. Stage changes with git add first.")
        const cfg = ctx.config as LintOptions
        const list = suggest(changes, diff, { maxSubject: cfg.maxSubject })
        const secrets = scanDiff(diff)
        const sensitive = changes.filter((c) => c.status !== "D" && sensitiveFile(c.path))
        const findings: Finding[] = [
          ...sensitive.map((c) => ({ rule: "sensitive-file", severity: "error" as const, message: `${c.path} looks like ${article(sensitiveFile(c.path)!)} and is staged`, file: c.path, hint: `git restore --staged ${c.path}, then add it to .gitignore` })),
          ...secrets.map((s) => ({ rule: "secret", severity: "error" as const, message: `Possible ${s.kind} in ${s.file} (${s.preview})`, file: s.file, line: s.line })),
        ]
        const best = list[0]!
        return {
          tool: "commitsmith",
          title: "CommitSmith: suggested messages",
          summary: { files: changes.length, "+": changes.reduce((n, c) => n + c.added, 0), "-": changes.reduce((n, c) => n + c.removed, 0), type: `${best.type} (${best.reason})` },
          sections: list.map((s, i) => ({ kind: "code" as const, title: i === 0 ? "Best guess" : `Option ${i + 1}`, language: "text", body: s.message })),
          findings,
          ...(ctx.options.raw ? { raw: best.message } : {}),
        }
      },
    },
    lint: {
      description: "Check commit messages against Conventional Commits",
      usage: '["message"] [--file .git/COMMIT_EDITMSG] [--from origin/main]',
      options: {
        file: { type: "string", description: "Read the message from a file (what the commit-msg hook passes)" },
        from: { type: "string", description: "Lint every commit since this ref (e.g. in CI)" },
      },
      async run(ctx): Promise<ToolResult> {
        const cfg = ctx.config as LintOptions
        const findings: Finding[] = []
        let checked = 0
        if (ctx.options.from) {
          for (const c of readCommits(ctx.cwd, `${ctx.options.from}..HEAD`)) {
            checked++
            const msg = git(ctx.cwd, ["log", "-1", "--format=%B", c.hash])
            for (const f of lintMessage(msg, cfg)) findings.push({ ...f, message: `${c.hash.slice(0, 7)} "${msg.split("\n")[0]}": ${f.message}` })
          }
        } else {
          const msg = ctx.options.file ? readFileSync(resolve(ctx.cwd, String(ctx.options.file)), "utf8") : ctx.positionals.join(" ")
          if (!msg.trim() && !ctx.options.file) throw new UsageError('Give a message, --file or --from. Example: commitsmith lint "feat(api): add search"')
          checked = 1
          findings.push(...lintMessage(msg, cfg))
        }
        return { tool: "commitsmith", title: "CommitSmith: message lint", summary: { checked }, findings }
      },
    },
    changelog: {
      description: "Write a changelog entry from Conventional Commits since the last tag",
      usage: "[--from v1.2.0] [--version 1.3.0] [--write CHANGELOG.md]",
      options: {
        from: { type: "string", description: "Start after this ref (default: latest tag, or the first commit)" },
        to: { type: "string", description: "End at this ref (default: HEAD)" },
        version: { type: "string", description: "Version heading (default: next version from the commit types)" },
        write: { type: "string", description: "Prepend the entry to this file" },
        all: { type: "boolean", description: "Include chores, tests, CI and non-conventional commits" },
      },
      async run(ctx): Promise<ToolResult> {
        const from = (ctx.options.from as string) ?? latestTag(ctx.cwd)
        const to = (ctx.options.to as string) ?? "HEAD"
        const commits = readCommits(ctx.cwd, from ? `${from}..${to}` : to)
        const version = (ctx.options.version as string) ?? nextVersion(from, commits)
        const text = changelog(commits, { version, repoUrl: repoUrl(ctx.cwd), includeAll: Boolean(ctx.options.all) })
        if (ctx.options.write) {
          const path = resolve(ctx.cwd, String(ctx.options.write))
          const existing = existsSync(path) ? readFileSync(path, "utf8") : "# Changelog\n"
          const [head, ...rest] = existing.split(/\n(?=## )/)
          writeFileSync(path, [head!.trimEnd(), "", text.trimEnd(), ...rest.map((r) => `\n${r.trimEnd()}`)].join("\n") + "\n")
          ctx.log(`Updated ${ctx.options.write}`)
        }
        const nonConventional = commits.filter((c) => c.type === "other").length
        return {
          tool: "commitsmith",
          title: `CommitSmith: changelog for ${version}`,
          summary: { commits: commits.length, from: from ?? "first commit", "suggested version": version },
          findings: nonConventional ? [{ rule: "non-conventional", severity: "info", message: `${nonConventional} commit${nonConventional > 1 ? "s" : ""} in this range don't follow Conventional Commits and were left out`, hint: "Use --all to include them." }] : [],
          sections: [{ kind: "code", title: "Changelog entry", language: "markdown", body: text }],
          raw: text,
        }
      },
    },
    scan: {
      description: "Check staged changes (or all tracked files) for secrets and sensitive files",
      usage: "[--all]",
      options: {
        all: { type: "boolean", description: "Scan every tracked file, not just what's staged" },
        "include-tests": { type: "boolean", description: "Also scan test files and fixtures (skipped by default: they're full of fake keys)" },
      },
      async run(ctx): Promise<ToolResult> {
        const findings: Finding[] = []
        let files: string[]
        let diff: string
        if (ctx.options.all) {
          files = git(ctx.cwd, ["ls-files", "-z"]).split("\0").filter(Boolean)
          // Present tracked files as an "added" diff so one scanner handles both modes.
          diff = git(ctx.cwd, ["diff", "--no-color", "--unified=0", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD"])
        } else {
          const staged = stagedChanges(ctx.cwd)
          files = staged.changes.filter((c) => c.status !== "D").map((c) => c.path)
          diff = staged.diff
        }
        for (const f of files) {
          const kind = sensitiveFile(f)
          if (kind) findings.push({ rule: "sensitive-file", severity: "error", message: `${f} looks like ${article(kind)}`, file: f, hint: ctx.options.all ? "git rm --cached it, add it to .gitignore, and rotate anything inside." : `git restore --staged ${f}` })
        }
        for (const s of scanDiff(diff, { includeTests: Boolean(ctx.options["include-tests"]) })) findings.push({ rule: "secret", severity: "error", message: `Possible ${s.kind} (${s.preview})`, file: s.file, line: s.line, hint: "Move it to an environment variable. If it was ever pushed, rotate it." })
        return { tool: "commitsmith", title: "CommitSmith: secret scan", summary: { files: files.length, mode: ctx.options.all ? "all tracked files" : "staged changes" }, findings }
      },
    },
    hook: {
      description: "Install git hooks: commit-msg runs lint, pre-commit runs scan",
      usage: "[--uninstall]",
      options: { uninstall: { type: "boolean", description: "Remove the hooks CommitSmith installed" } },
      async run(ctx): Promise<ToolResult> {
        const top = git(ctx.cwd, ["rev-parse", "--show-toplevel"]).trim()
        const hooksPath = (() => {
          try {
            return execFileSync("git", ["config", "core.hooksPath"], { cwd: top, encoding: "utf8" }).trim()
          } catch {
            return ""
          }
        })()
        const dir = hooksPath ? resolve(top, hooksPath) : join(git(ctx.cwd, ["rev-parse", "--absolute-git-dir"]).trim(), "hooks")
        mkdirSync(dir, { recursive: true })
        const done: string[] = []
        for (const kind of ["commit-msg", "pre-commit"] as const) {
          const path = join(dir, kind)
          const existing = existsSync(path) ? readFileSync(path, "utf8") : ""
          if (ctx.options.uninstall) {
            if (existing.includes(HOOK_MARK)) {
              writeFileSync(path, "")
              done.push(`removed ${kind}`)
            }
            continue
          }
          if (existing && !existing.includes(HOOK_MARK)) {
            // Don't clobber someone else's hook (e.g. husky): append our call.
            writeFileSync(path, `${existing.trimEnd()}\n\n${HOOK_MARK}\n${hookScript(kind).split("\n").slice(2).join("\n")}`)
            done.push(`appended to existing ${kind}`)
          } else {
            writeFileSync(path, hookScript(kind))
            done.push(`installed ${kind}`)
          }
          chmodSync(path, 0o755)
        }
        return { tool: "commitsmith", title: "CommitSmith: hooks", summary: {}, findings: [], raw: done.length ? `${done.join(", ")} in ${dir}` : "Nothing to do" }
      },
    },
  },
}
