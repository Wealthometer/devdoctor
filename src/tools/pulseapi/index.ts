import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { c } from "../../core/color.js"
import { exists, isDir, readJson, toPosix, walk } from "../../core/fs.js"
import { UsageError, type Finding, type ToolDef } from "../../core/types.js"
import { interpolate, runSuite, toJUnit, type RequestResult } from "./engine.js"

const SUITE_FILE = /\.(ya?ml|json)$/
const NOT_SUITE = /(^|\/)(schemas?|env|environments|fixtures)\/|\.schema\.json$|(^|\/)(package|tsconfig|devdoctor\.config)\.json$|\.env\.json$/

export async function findSuites(root: string, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const abs = resolve(root, p)
    if (!exists(abs)) throw new UsageError(`Not found: ${p}`)
    if (isDir(abs)) {
      for (const f of await walk(abs, { respectGitignore: false })) if (SUITE_FILE.test(f) && !NOT_SUITE.test(f)) out.push(join(abs, f))
    } else out.push(abs)
  }
  return out.sort()
}

function parseVars(list: string[] | undefined) {
  const out: Record<string, string> = {}
  for (const kv of list ?? []) {
    const i = kv.indexOf("=")
    if (i <= 0) throw new UsageError(`--var expects key=value, got "${kv}"`)
    out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

const EXAMPLE = `# PulseAPI suite: requests run top to bottom; captured values feed later requests.
name: Users API
baseUrl: "{{baseUrl}}"
requests:
  - name: Health check
    url: /health
    expect:
      status: 200
      maxDuration: 300

  - name: Create a user
    method: POST
    url: /users
    headers:
      Authorization: "Bearer {{$env.API_TOKEN}}"
    json:
      email: "{{$randomEmail}}"
      name: "{{$randomName}}"
    expect:
      status: 201
      headers:
        content-type: /json/
      json:
        $.id: { exists: true }
        $.email: { matches: "@example.com$" }
      schema: ./schemas/user.json
    capture:
      userId: $.id

  - name: Fetch the user
    url: /users/{{userId}}
    expect:
      status: 200
      json:
        $.id: "{{userId}}"
`

const EXAMPLE_SCHEMA = { type: "object", required: ["id", "email"], properties: { id: { type: ["string", "integer"] }, email: { type: "string", format: "email" }, name: { type: "string" } } }

export const pulseapi: ToolDef = {
  name: "pulseapi",
  tagline: "Run API tests from YAML: chained requests, environments, JSON Schema and timing assertions",
  commands: {
    run: {
      description: "Run every suite in a folder (default: ./api-tests)",
      usage: "[dir or file ...] [--env staging] [--var key=value]",
      options: {
        env: { type: "string", short: "e", description: "Environment from config (pulseapi.environments.<name>)" },
        "env-file": { type: "string", description: "JSON file of variables" },
        var: { type: "string", multiple: true, description: "Set a variable: --var baseUrl=http://localhost:3000" },
        bail: { type: "boolean", description: "Stop a suite at its first failure" },
        grep: { type: "string", description: "Only run requests or suites whose name contains this" },
        timeout: { type: "string", description: "Per-request timeout in ms (default: 10000)" },
        junit: { type: "string", description: "Also write a JUnit XML report to this file" },
      },
      async run(ctx) {
        const cfg = ctx.config as { dir?: string; environments?: Record<string, Record<string, unknown>>; variables?: Record<string, unknown>; timeout?: number }
        const paths = ctx.positionals.length ? ctx.positionals : [cfg.dir ?? "api-tests"]
        const files = await findSuites(ctx.cwd, paths)
        if (!files.length) throw new UsageError(`No test suites (*.yaml, *.yml, *.json) in ${paths.join(", ")}. Run "pulseapi init" for an example.`)
        const envName = ctx.options.env as string | undefined
        if (envName && !cfg.environments?.[envName]) throw new UsageError(`Unknown environment "${envName}". Defined: ${Object.keys(cfg.environments ?? {}).join(", ") || "none"} (pulseapi.environments in devdoctor.config.json)`)
        const envFile = ctx.options["env-file"] as string | undefined
        const fileVars = envFile ? readJson(resolve(ctx.cwd, envFile)) : {}
        if (envFile && !fileVars) throw new UsageError(`${envFile} isn't valid JSON`)
        const variables = { ...(cfg.variables ?? {}), ...(envName ? cfg.environments![envName] : {}), ...fileVars, ...parseVars(ctx.options.var as string[] | undefined) }

        const results: RequestResult[] = []
        for (const file of files) {
          ctx.log(c.bold(toPosix(relative(ctx.cwd, file))))
          results.push(
            ...(await runSuite(file, {
              env: ctx.env,
              variables,
              fetch: ctx.fetch,
              bail: Boolean(ctx.options.bail),
              filter: ctx.options.grep as string | undefined,
              timeoutMs: Number(ctx.options.timeout ?? cfg.timeout ?? 10_000),
              onResult: (r) => ctx.log(`  ${r.skipped ? c.gray("○") : r.ok ? c.green("✔") : c.red("✖")} ${r.name} ${c.gray(r.skipped ? "skipped" : `${r.status ?? "–"} · ${r.durationMs} ms`)}`),
            })),
          )
        }
        if (ctx.options.junit) {
          const path = resolve(ctx.cwd, String(ctx.options.junit))
          mkdirSync(resolve(path, ".."), { recursive: true })
          writeFileSync(path, toJUnit(results))
        }
        const findings: Finding[] = results
          .filter((r) => !r.ok && !r.skipped)
          .map((r) => ({
            rule: r.error ? "request-error" : "assertion-failed",
            severity: "error",
            message: `${r.suite} › ${r.name}: ${r.error ?? r.checks.filter((x) => !x.ok).map((x) => `${x.label} (${x.detail})`).join(", ")}`,
            file: toPosix(relative(ctx.cwd, r.file)),
            line: r.line,
          }))
        const passed = results.filter((r) => r.ok && !r.skipped).length
        const times = results.filter((r) => !r.skipped && r.status).map((r) => r.durationMs).sort((a, b) => a - b)
        return {
          tool: "pulseapi",
          title: "PulseAPI",
          summary: { passed, failed: results.filter((r) => !r.ok).length, skipped: results.filter((r) => r.skipped).length, suites: files.length, ...(times.length ? { "p50 ms": times[Math.floor(times.length / 2)]!, "slowest ms": times.at(-1)! } : {}), ...(envName ? { env: envName } : {}) },
          sections: [{ kind: "table", title: "Requests", headers: ["", "Suite", "Request", "Status", "Time"], rows: results.map((r) => [r.skipped ? "○" : r.ok ? "✔" : "✖", r.suite, r.name, r.status ?? "–", r.skipped ? "–" : `${r.durationMs} ms`]) }],
          findings,
        }
      },
    },
    send: {
      description: "Send one request and print the response",
      usage: "[METHOD] <url> [-H 'Name: value'] [--json '{...}'] [--data text]",
      options: {
        header: { type: "string", short: "H", multiple: true, description: "Request header" },
        json: { type: "string", description: "JSON body (sets content-type)" },
        data: { type: "string", short: "d", description: "Raw body" },
        var: { type: "string", multiple: true, description: "Variables for {{placeholders}} in the URL, headers or body" },
        timeout: { type: "string", description: "Timeout in ms (default: 10000)" },
      },
      async run(ctx) {
        const [a, b] = ctx.positionals
        const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        const method = a && methods.includes(a.toUpperCase()) ? a.toUpperCase() : "GET"
        const rawUrl = a && methods.includes(a.toUpperCase()) ? b : a
        if (!rawUrl) throw new UsageError("Give a URL: pulseapi send GET https://api.example.com/health")
        const vars = parseVars(ctx.options.var as string[] | undefined)
        const url = interpolate(rawUrl, vars, ctx.env)
        const headers: Record<string, string> = {}
        for (const h of (ctx.options.header as string[] | undefined) ?? []) {
          const i = h.indexOf(":")
          if (i <= 0) throw new UsageError(`Headers look like "Name: value", got "${h}"`)
          headers[h.slice(0, i).trim().toLowerCase()] = interpolate(h.slice(i + 1).trim(), vars, ctx.env)
        }
        let body: string | undefined
        if (ctx.options.json !== undefined) {
          try {
            body = JSON.stringify(JSON.parse(interpolate(String(ctx.options.json), vars, ctx.env)))
          } catch {
            throw new UsageError("--json isn't valid JSON")
          }
          headers["content-type"] ??= "application/json"
        } else if (ctx.options.data !== undefined) body = interpolate(String(ctx.options.data), vars, ctx.env)
        const ctrl = new AbortController()
        const timeout = Number(ctx.options.timeout ?? 10_000)
        const t = setTimeout(() => ctrl.abort(), timeout)
        const started = performance.now()
        let res: Response
        try {
          res = await ctx.fetch(url, { method, headers, body, signal: ctrl.signal })
        } catch (err) {
          throw new UsageError((err as Error).name === "AbortError" ? `Timed out after ${timeout} ms` : `Request failed: ${((err as Error).cause as Error)?.message ?? (err as Error).message}`)
        } finally {
          clearTimeout(t)
        }
        const text = await res.text()
        const ms = Math.round(performance.now() - started)
        let pretty = text
        try {
          if (/json/.test(res.headers.get("content-type") ?? "")) pretty = JSON.stringify(JSON.parse(text), null, 2)
        } catch {}
        const statusColor = res.status < 300 ? c.green : res.status < 400 ? c.yellow : c.red
        const raw = [`${statusColor(c.bold(`${res.status} ${res.statusText}`))} ${c.gray(`${method} ${url} · ${ms} ms · ${text.length} bytes`)}`, ...[...res.headers].map(([k, v]) => c.gray(`${k}: ${v}`)), "", pretty].join("\n")
        return {
          tool: "pulseapi",
          title: `${method} ${url}`,
          summary: { status: res.status, ms, bytes: text.length },
          findings: res.ok ? [] : [{ rule: "http-error", severity: "error", message: `${method} ${url} returned ${res.status}` }],
          sections: [{ kind: "code", title: "Response", language: "json", body: pretty }],
          raw,
        }
      },
    },
    init: {
      description: "Create an example suite in ./api-tests",
      usage: "[dir]",
      async run(ctx) {
        const dir = resolve(ctx.cwd, ctx.positionals[0] ?? "api-tests")
        const file = join(dir, "users.yaml")
        if (exists(file)) throw new UsageError(`${toPosix(relative(ctx.cwd, file))} already exists`)
        mkdirSync(join(dir, "schemas"), { recursive: true })
        writeFileSync(file, EXAMPLE)
        writeFileSync(join(dir, "schemas", "user.json"), JSON.stringify(EXAMPLE_SCHEMA, null, 2) + "\n")
        const rel = toPosix(relative(ctx.cwd, dir))
        return { tool: "pulseapi", title: "PulseAPI", summary: {}, findings: [], raw: `Created ${rel}/users.yaml and ${rel}/schemas/user.json\nRun it: pulseapi run ${rel} --var baseUrl=http://localhost:3000` }
      },
    },
  },
}
