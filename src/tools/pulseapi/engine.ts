import { randomInt, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"
import { parse as parseYaml } from "yaml"

const require = createRequire(import.meta.url)

export type Assertion = string | number | boolean | null | { [op: string]: unknown }
export type Expect = {
  status?: number | number[] | string
  maxDuration?: number
  headers?: Record<string, Assertion>
  json?: Record<string, Assertion>
  body?: string
  schema?: string | object
}
export type RequestSpec = {
  name?: string
  method?: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean>
  json?: unknown
  form?: Record<string, string>
  body?: string
  timeout?: number
  retries?: number
  skip?: boolean | string
  expect?: Expect
  capture?: Record<string, string>
}
export type Suite = { name?: string; baseUrl?: string; variables?: Record<string, unknown>; headers?: Record<string, string>; requests: RequestSpec[] }

export type Check = { label: string; ok: boolean; detail?: string }
export type RequestResult = {
  suite: string
  file: string
  name: string
  method: string
  url: string
  status?: number
  durationMs: number
  ok: boolean
  skipped?: boolean
  checks: Check[]
  error?: string
  line?: number
}

export function loadSuite(path: string): { suite: Suite; lines: number[] } {
  const text = readFileSync(path, "utf8")
  const data = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text)
  if (!data || typeof data !== "object") throw new Error(`${path} is empty`)
  const suite: Suite = Array.isArray(data) ? { requests: data } : data
  if (!Array.isArray(suite.requests)) throw new Error(`${path} needs a "requests" list`)
  suite.requests.forEach((r, i) => {
    if (!r || typeof r !== "object" || typeof r.url !== "string") throw new Error(`${path}: request ${i + 1} needs a "url"`)
  })
  // Approximate line numbers of each request for reports ("- name:" or "- url:" entries).
  const lines: number[] = []
  text.split("\n").forEach((l, i) => {
    if (/^\s*-\s+(name|url|method)\s*:/.test(l) || /^\s*\{\s*"(name|url)"/.test(l)) lines.push(i + 1)
  })
  return { suite, lines }
}

// ── Variables ─────────────────────────────────────────────────────────────────
const DYNAMIC: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1_000_000)),
  $randomEmail: () => `user${randomInt(0, 1e9)}@example.com`,
  $randomName: () => ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara"][randomInt(0, 6)]!,
}

/** Replaces {{name}}, {{$uuid}}, {{$env.NAME}}. A value that is exactly one placeholder keeps its type. */
export function interpolate<T>(value: T, vars: Record<string, unknown>, env: NodeJS.ProcessEnv): T {
  const lookup = (name: string): unknown => {
    const n = name.trim()
    if (n.startsWith("$env.")) {
      const v = env[n.slice(5)]
      if (v === undefined) throw new Error(`Environment variable ${n.slice(5)} is not set`)
      return v
    }
    if (DYNAMIC[n]) return DYNAMIC[n]!()
    if (n in vars) return vars[n]
    const path = getPath(vars, `$.${n}`)
    if (path.found) return path.value
    throw new Error(`Unknown variable {{${n}}}`)
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = v.match(/^\{\{([^{}]+)\}\}$/)
      if (whole) return lookup(whole[1]!)
      return v.replace(/\{\{([^{}]+)\}\}/g, (_, n: string) => {
        const r = lookup(n)
        return typeof r === "object" ? JSON.stringify(r) : String(r)
      })
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** Minimal JSONPath: $.a.b[0]["c d"].length, $[*] is not supported (use length or an index). */
export function getPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "$") return { found: true, value: obj }
  const tokens: (string | number)[] = []
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[(['"])(.*?)\3\]/g
  const body = path.replace(/^\$/, "")
  let last = 0
  for (let m; (m = re.exec(body)); ) {
    if (m.index !== last) return { found: false, value: undefined }
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[4]!))
    last = re.lastIndex
  }
  if (last !== body.length) return { found: false, value: undefined }
  let cur: any = obj
  for (const t of tokens) {
    if (t === "length" && (Array.isArray(cur) || typeof cur === "string")) {
      cur = cur.length
      continue
    }
    if (cur === null || typeof cur !== "object" || !(t in cur)) return { found: false, value: undefined }
    cur = cur[t]
  }
  return { found: true, value: cur }
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)
const show = (v: unknown) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v)
  return s.length > 80 ? s.slice(0, 77) + "…" : s
}
const isRegex = (s: unknown): s is string => typeof s === "string" && /^\/.*\/[gimsuy]*$/.test(s) && s.length > 2
const toRegex = (s: string) => {
  const m = s.match(/^\/(.*)\/([gimsuy]*)$/)!
  return new RegExp(m[1]!, m[2])
}

/** Evaluates one assertion. Returns null when it passes, or why it failed. */
export function assert(actual: unknown, expected: Assertion, found = true): string | null {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    if (isRegex(expected)) return found && toRegex(expected).test(typeof actual === "string" ? actual : JSON.stringify(actual)) ? null : `expected to match ${expected}, got ${found ? show(actual) : "nothing"}`
    if (!found) return `expected ${show(expected)}, but it's missing`
    return JSON.stringify(actual) === JSON.stringify(expected) ? null : `expected ${show(expected)}, got ${show(actual)}`
  }
  for (const [op, want] of Object.entries(expected)) {
    const n = Number(actual)
    let err: string | null = null
    switch (op) {
      case "exists":
        if (Boolean(want) !== found) err = want ? "expected it to exist" : `expected it not to exist, got ${show(actual)}`
        break
      case "eq":
      case "equals":
        err = assert(actual, want as Assertion, found)
        break
      case "ne":
        if (found && JSON.stringify(actual) === JSON.stringify(want)) err = `expected anything but ${show(want)}`
        break
      case "gt":
        if (!(found && n > Number(want))) err = `expected > ${want}, got ${show(actual)}`
        break
      case "gte":
        if (!(found && n >= Number(want))) err = `expected ≥ ${want}, got ${show(actual)}`
        break
      case "lt":
        if (!(found && n < Number(want))) err = `expected < ${want}, got ${show(actual)}`
        break
      case "lte":
        if (!(found && n <= Number(want))) err = `expected ≤ ${want}, got ${show(actual)}`
        break
      case "contains":
        if (!found || !(typeof actual === "string" ? actual.includes(String(want)) : Array.isArray(actual) ? actual.some((x) => JSON.stringify(x) === JSON.stringify(want)) : false)) err = `expected to contain ${show(want)}`
        break
      case "matches":
        if (!found || !new RegExp(String(want).replace(/^\/|\/[gimsuy]*$/g, "")).test(String(actual))) err = `expected to match ${want}, got ${show(actual)}`
        break
      case "type":
        if (!found || typeOf(actual) !== want) err = `expected type ${want}, got ${found ? typeOf(actual) : "nothing"}`
        break
      case "length": {
        const len = found && (Array.isArray(actual) || typeof actual === "string") ? actual.length : undefined
        err = len === undefined ? "expected something with a length" : assert(len, want as Assertion)
        if (err && len !== undefined) err = `length: ${err}`
        break
      }
      case "oneOf":
        if (!found || !(want as unknown[]).some((w) => JSON.stringify(w) === JSON.stringify(actual))) err = `expected one of ${show(want)}, got ${show(actual)}`
        break
      default:
        err = `unknown assertion "${op}"`
    }
    if (err) return err
  }
  return null
}

let ajvInstance: any = null
function validator(schema: object): (data: unknown) => string | null {
  if (!ajvInstance) {
    const Ajv = require("ajv").default
    const addFormats = require("ajv-formats").default
    ajvInstance = new Ajv({ allErrors: true, strict: false })
    addFormats(ajvInstance)
  }
  let validate: any
  const draft2020 = typeof (schema as any).$schema === "string" && /2020-12|2019-09/.test((schema as any).$schema)
  if (draft2020) {
    const Ajv2020 = require("ajv/dist/2020").default
    const addFormats = require("ajv-formats").default
    const a = new Ajv2020({ allErrors: true, strict: false })
    addFormats(a)
    validate = a.compile(schema)
  } else validate = ajvInstance.compile(schema)
  return (data) => (validate(data) ? null : (validate.errors ?? []).slice(0, 5).map((e: any) => `${e.instancePath || "(root)"} ${e.message}`).join("; "))
}

export type RunOptions = {
  env: NodeJS.ProcessEnv
  variables: Record<string, unknown>
  fetch: typeof fetch
  bail?: boolean
  filter?: string
  timeoutMs?: number
  onResult?: (r: RequestResult) => void
}

/** Runs one suite file in order, carrying captured values to later requests. */
export async function runSuite(path: string, opts: RunOptions): Promise<RequestResult[]> {
  const { suite, lines } = loadSuite(path)
  const vars: Record<string, unknown> = { ...opts.variables, ...(suite.variables ?? {}) }
  const results: RequestResult[] = []
  const suiteName = suite.name ?? path.split("/").pop()!
  for (const [i, raw] of suite.requests.entries()) {
    const label = raw.name ?? `${raw.method ?? "GET"} ${raw.url}`
    if (opts.filter && !label.toLowerCase().includes(opts.filter.toLowerCase()) && !suiteName.toLowerCase().includes(opts.filter.toLowerCase())) continue
    if (raw.skip) {
      const r: RequestResult = { suite: suiteName, file: path, name: label, method: raw.method ?? "GET", url: raw.url, durationMs: 0, ok: true, skipped: true, checks: [], line: lines[i] }
      results.push(r)
      opts.onResult?.(r)
      continue
    }
    let r: RequestResult
    try {
      const baseVars = { ...vars, ...(suite.baseUrl ? { baseUrl: interpolate(suite.baseUrl, vars, opts.env) } : {}) }
      const req = interpolate(raw, baseVars, opts.env)
      r = await execute(req, { ...opts, baseUrl: (baseVars.baseUrl as string | undefined) ?? (vars.baseUrl as string | undefined), suiteHeaders: interpolate(suite.headers ?? {}, baseVars, opts.env), file: path, schemaDir: dirname(path), vars, suiteName })
    } catch (err) {
      r = { suite: suiteName, file: path, name: label, method: raw.method ?? "GET", url: raw.url, durationMs: 0, ok: false, checks: [], error: (err as Error).message }
    }
    r.line = lines[i]
    results.push(r)
    opts.onResult?.(r)
    if (!r.ok && opts.bail) break
  }
  return results
}

async function execute(req: RequestSpec, o: RunOptions & { baseUrl?: string; suiteHeaders: Record<string, string>; file: string; schemaDir: string; vars: Record<string, unknown>; suiteName: string }): Promise<RequestResult> {
  const method = (req.method ?? "GET").toUpperCase()
  let url: URL
  try {
    url = new URL(req.url, o.baseUrl)
  } catch {
    throw new Error(`Invalid URL "${req.url}"${o.baseUrl ? "" : " (set baseUrl, or use an absolute URL)"}`)
  }
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v))
  const headers: Record<string, string> = { "user-agent": "pulseapi", ...lower(o.suiteHeaders), ...lower(req.headers ?? {}) }
  let body: string | undefined
  if (req.json !== undefined) {
    body = JSON.stringify(req.json)
    headers["content-type"] ??= "application/json"
  } else if (req.form) {
    body = new URLSearchParams(req.form).toString()
    headers["content-type"] ??= "application/x-www-form-urlencoded"
  } else if (req.body !== undefined) body = req.body

  const attempts = 1 + Math.max(0, req.retries ?? 0)
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController()
    const timeout = req.timeout ?? o.timeoutMs ?? 10_000
    const timer = setTimeout(() => ctrl.abort(), timeout)
    const started = performance.now()
    try {
      const res = await o.fetch(url, { method, headers, body, signal: ctrl.signal, redirect: "manual" })
      const text = await res.text()
      const durationMs = Math.round(performance.now() - started)
      clearTimeout(timer)
      const result = check(req, res, text, durationMs, o)
      const r: RequestResult = { suite: o.suiteName, file: o.file, name: req.name ?? `${method} ${req.url}`, method, url: url.toString(), status: res.status, durationMs, ok: result.ok, checks: result.checks }
      if (!r.ok && attempt < attempts) {
        lastErr = new Error(result.checks.find((c) => !c.ok)?.detail ?? "failed")
        await new Promise((s) => setTimeout(s, 200 * attempt))
        continue
      }
      return r
    } catch (err) {
      clearTimeout(timer)
      lastErr = (err as Error).name === "AbortError" ? new Error(`Timed out after ${timeout} ms`) : new Error(((err as Error).cause as Error)?.message ?? (err as Error).message)
      if (attempt < attempts) await new Promise((s) => setTimeout(s, 200 * attempt))
    }
  }
  return { suite: o.suiteName, file: o.file, name: req.name ?? `${method} ${req.url}`, method, url: url.toString(), durationMs: 0, ok: false, checks: [], error: lastErr?.message }
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))

function check(req: RequestSpec, res: Response, text: string, durationMs: number, o: { schemaDir: string; vars: Record<string, unknown> }) {
  const checks: Check[] = []
  const e = req.expect ?? {}
  let json: unknown = undefined
  let isJson = false
  if (/json/i.test(res.headers.get("content-type") ?? "") || /^\s*[[{]/.test(text)) {
    try {
      json = JSON.parse(text)
      isJson = true
    } catch {}
  }
  // Status: exact, list, or "2xx" pattern. Default: any 2xx.
  const statusSpec = e.status ?? "2xx"
  const statusOk = Array.isArray(statusSpec) ? statusSpec.includes(res.status) : typeof statusSpec === "string" ? new RegExp(`^${statusSpec.replace(/x/gi, "\\d")}$`).test(String(res.status)) : res.status === statusSpec
  checks.push({ label: `status ${Array.isArray(statusSpec) ? statusSpec.join("|") : statusSpec}`, ok: statusOk, detail: statusOk ? undefined : `got ${res.status}${text ? `: ${text.slice(0, 160).replace(/\s+/g, " ")}` : ""}` })
  if (e.maxDuration !== undefined) checks.push({ label: `under ${e.maxDuration} ms`, ok: durationMs <= e.maxDuration, detail: durationMs <= e.maxDuration ? undefined : `took ${durationMs} ms` })
  for (const [h, want] of Object.entries(e.headers ?? {})) {
    const v = res.headers.get(h)
    const err = assert(v ?? undefined, want, v !== null)
    checks.push({ label: `header ${h}`, ok: !err, detail: err ?? undefined })
  }
  if (e.body !== undefined) {
    const err = assert(text, isRegex(e.body) ? e.body : { contains: e.body })
    checks.push({ label: "body", ok: !err, detail: err ?? undefined })
  }
  for (const [path, want] of Object.entries(e.json ?? {})) {
    if (!isJson) {
      checks.push({ label: path, ok: false, detail: "response isn't JSON" })
      continue
    }
    const got = getPath(json, path.startsWith("$") ? path : `$.${path}`)
    const err = assert(got.value, want, got.found)
    checks.push({ label: path, ok: !err, detail: err ?? undefined })
  }
  if (e.schema !== undefined) {
    let schema: object
    try {
      schema = typeof e.schema === "string" ? JSON.parse(readFileSync(resolve(o.schemaDir, e.schema), "utf8")) : e.schema
      const err = isJson ? validator(schema)(json) : "response isn't JSON"
      checks.push({ label: `schema${typeof e.schema === "string" ? ` ${e.schema}` : ""}`, ok: !err, detail: err ?? undefined })
    } catch (err) {
      checks.push({ label: "schema", ok: false, detail: `couldn't load schema: ${(err as Error).message}` })
    }
  }
  const ok = checks.every((c) => c.ok)
  // Captures feed later requests, but only from responses that passed.
  if (ok) {
    for (const [name, from] of Object.entries(req.capture ?? {})) {
      if (from.startsWith("header.")) o.vars[name] = res.headers.get(from.slice(7)) ?? undefined
      else if (from === "status") o.vars[name] = res.status
      else {
        const got = getPath(json, from.startsWith("$") ? from : `$.${from}`)
        if (!got.found) checks.push({ label: `capture ${name}`, ok: false, detail: `${from} not found in the response` })
        else o.vars[name] = got.value
      }
    }
  }
  return { ok: checks.every((c) => c.ok), checks }
}

/** JUnit XML for CI systems that render test reports. */
export function toJUnit(results: RequestResult[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const suites = new Map<string, RequestResult[]>()
  for (const r of results) suites.set(r.suite, [...(suites.get(r.suite) ?? []), r])
  const body = [...suites].map(([name, rs]) => {
    const failures = rs.filter((r) => !r.ok && !r.skipped).length
    const time = rs.reduce((n, r) => n + r.durationMs, 0) / 1000
    return `  <testsuite name="${esc(name)}" tests="${rs.length}" failures="${failures}" skipped="${rs.filter((r) => r.skipped).length}" time="${time.toFixed(3)}">\n${rs
      .map((r) => {
        const inner = r.skipped ? "<skipped/>" : r.ok ? "" : `<failure message="${esc(r.error ?? r.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("; "))}"/>`
        return `    <testcase classname="${esc(name)}" name="${esc(r.name)}" time="${(r.durationMs / 1000).toFixed(3)}">${inner}</testcase>`
      })
      .join("\n")}\n  </testsuite>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${results.length}" failures="${results.filter((r) => !r.ok && !r.skipped).length}">\n${body.join("\n")}\n</testsuites>\n`
}
