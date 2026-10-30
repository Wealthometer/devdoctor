import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { main } from "../src/cli.js"

/** Creates a temporary project from a map of path → contents. */
export function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "devdoctor-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2))
  }
  return dir
}

export function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" })
}

export function gitInit(dir: string) {
  git(dir, "init", "-q", "-b", "main")
  return dir
}

/** Runs a tool through the real CLI entry point and captures its output. */
export async function cli(tool: string | undefined, args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  let stdout = ""
  let stderr = ""
  const code = await main(tool, args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: opts.env ?? {}, cwd, fetch: opts.fetch ?? (globalThis.fetch as typeof fetch) })
  return { code, stdout, stderr, json: () => JSON.parse(stdout) }
}

export const rules = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule).sort()
