import { join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { importModule } from "../core/config.js"
import { exists, lineOf, readText, walk } from "../core/fs.js"
import { SOURCE_EXTENSIONS, stripComments } from "../core/imports.js"
import { workspaceDirs } from "../core/project.js"
import { UsageError, type Finding, type ToolDef, type ToolResult } from "../core/types.js"

/**
 * EnvDoctor: catches missing, undocumented, unused and invalid environment variables before
 * the app crashes in production. Values are never printed: findings name keys and the kind of
 * problem only, and anything that has to refer to a value is masked.
 */

export type EnvEntry = { key: string; value: string; line: number; comment?: string; annotations: Record<string, string | true> }

/** dotenv-compatible parser that also keeps line numbers and `# @type` annotations. */
export function parseDotenv(text: string): EnvEntry[] {
  const out: EnvEntry[] = []
  const lines = text.split(/\r?\n/)
  let pending: Record<string, string | true> = {}
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (!trimmed) {
      pending = {}
      continue
    }
    if (trimmed.startsWith("#")) {
      for (const m of trimmed.matchAll(/@(\w+)(?:[ :]+([^@#]+?))?(?=\s+@|\s*$)/g)) pending[m[1]!] = m[2]?.trim() || true
      continue
    }
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let rest = m[2]!
    let value = ""
    let comment: string | undefined
    const startLine = i + 1
    const q = rest[0]
    if (q === '"' || q === "'" || q === "`") {
      let body = rest.slice(1)
      // Multi-line quoted values.
      while (!new RegExp(`(^|[^\\\\])${q}`).test(body) && i + 1 < lines.length) body += "\n" + lines[++i]
      const end = findClosing(body, q)
      value = end === -1 ? body : body.slice(0, end)
      const after = end === -1 ? "" : body.slice(end + 1)
      comment = after.match(/#\s*(.*)$/)?.[1]
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"')
    } else {
      const hash = rest.search(/\s#/)
      if (hash !== -1) {
        comment = rest.slice(hash).replace(/^\s*#\s*/, "")
        rest = rest.slice(0, hash)
      }
      value = rest.trim()
    }
    const annotations = { ...pending }
    if (comment) for (const a of comment.matchAll(/@(\w+)(?:[ :]+([^@]+?))?(?=\s+@|\s*$)/g)) annotations[a[1]!] = a[2]?.trim() || true
    out.push({ key, value, line: startLine, comment, annotations })
    pending = {}
  }
  return out
}

function findClosing(s: string, q: string) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++
    else if (s[i] === q) return i
  }
  return -1
}

/** Shows that a value exists without revealing it: "sk_l…(32 chars)". */
export function mask(value: string) {
  if (!value) return "(empty)"
  if (value.length <= 6) return "•".repeat(value.length)
  return `${value.slice(0, 2)}…(${value.length} chars)`
}

export const SECRET_PATTERNS: [RegExp, string][] = [
  [/^sk_live_[0-9a-zA-Z]{10,}/, "Stripe live secret key"],
  [/^rk_live_[0-9a-zA-Z]{10,}/, "Stripe restricted key"],
  [/^AKIA[0-9A-Z]{16}$/, "AWS access key"],
  [/^gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/^github_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/^xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/^sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/^sk-(proj-)?[A-Za-z0-9_-]{32,}/, "OpenAI API key"],
  [/^AIza[0-9A-Za-z_-]{35}$/, "Google API key"],
  [/^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "SendGrid key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/^[a-z]+:\/\/[^:\s/]+:[^@\s]{8,}@(?!localhost|127\.0\.0\.1|postgres|db|mysql|redis|mongo)/, "URL with embedded credentials"],
]

const PLACEHOLDER = /^(|changeme|change[-_ ]?me.*|your[-_ ].*|xxx+|<.*>|\$\{.*\}|example.*|placeholder|todo|secret|password|test|dummy|replace.*|\*+|\.\.\.)$/i

export function looksLikeRealSecret(key: string, value: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(value)) return label
  if (/SECRET|TOKEN|PRIVATE|PASSWORD|API_KEY|ACCESS_KEY/i.test(key) && !PLACEHOLDER.test(value) && value.length >= 24 && entropy(value) > 3.5) return "high-entropy secret"
  return null
}

function entropy(s: string) {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type VarSpec = { type?: string; required?: boolean; enum?: string[]; pattern?: string; min?: number; max?: number; default?: string; description?: string }

const TYPES: Record<string, (v: string) => string | null> = {
  string: () => null,
  number: (v) => (v.trim() !== "" && Number.isFinite(Number(v)) ? null : "expected a number"),
  integer: (v) => (/^-?\d+$/.test(v.trim()) ? null : "expected a whole number"),
  port: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : "expected a port (1–65535)"),
  boolean: (v) => (/^(true|false|1|0|yes|no|on|off)$/i.test(v) ? null : "expected true/false"),
  url: (v) => {
    try {
      const u = new URL(v)
      return u.protocol ? null : "expected a URL"
    } catch {
      return "expected a URL"
    }
  },
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "expected an email address"),
  json: (v) => {
    try {
      JSON.parse(v)
      return null
    } catch {
      return "expected valid JSON"
    }
  },
  duration: (v) => (/^\d+(ms|s|m|h|d)?$/.test(v) ? null : "expected a duration like 30s or 5m"),
  host: (v) => (/^[a-z0-9.-]+$/i.test(v) ? null : "expected a hostname"),
}
export const TYPE_NAMES = Object.keys(TYPES)

export function checkValue(spec: VarSpec, value: string): string | null {
  if (spec.enum && !spec.enum.includes(value)) return `expected one of: ${spec.enum.join(", ")}`
  const t = spec.type ? TYPES[spec.type] : undefined
  if (spec.type && !t) return null
  const err = t?.(value)
  if (err) return err
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) return `doesn't match ${spec.pattern}`
  if (spec.min !== undefined) {
    const n = spec.type && ["number", "integer", "port"].includes(spec.type) ? Number(value) : value.length
    if (n < spec.min) return spec.type && ["number", "integer", "port"].includes(spec.type) ? `must be at least ${spec.min}` : `must be at least ${spec.min} characters`
  }
  if (spec.max !== undefined) {
    const n = spec.type && ["number", "integer", "port"].includes(spec.type) ? Number(value) : value.length
    if (n > spec.max) return spec.type && ["number", "integer", "port"].includes(spec.type) ? `must be at most ${spec.max}` : `must be at most ${spec.max} characters`
  }
  return null
}

/** Specs from `# @type url @optional` style annotations in .env.example. */
function specFromAnnotations(e: EnvEntry): VarSpec {
  const a = e.annotations
  const spec: VarSpec = {}
  if (typeof a.type === "string") {
    if (a.type.includes("|")) spec.enum = a.type.split("|").map((s) => s.trim())
    else spec.type = a.type
  }
  if (typeof a.enum === "string") spec.enum = a.enum.split(/[|,]/).map((s) => s.trim())
  if (typeof a.pattern === "string") spec.pattern = a.pattern
  if (typeof a.min === "string") spec.min = Number(a.min)
  if (typeof a.max === "string") spec.max = Number(a.max)
  spec.required = !(a.optional || a.default !== undefined)
  return spec
}

// ── Usage in code ─────────────────────────────────────────────────────────────
export type Usage = { key: string; file: string; line: number }

export const NODE_INTERNAL = new Set(["NODE_ENV", "PATH", "HOME", "PWD", "CI", "TZ", "LANG", "TERM", "SHELL", "USER", "TMPDIR", "NODE_OPTIONS", "NODE_DEBUG", "DEBUG", "FORCE_COLOR", "NO_COLOR", "npm_package_version", "npm_lifecycle_event", "VITEST", "JEST_WORKER_ID", "COLORTERM", "LC_ALL", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "EDITOR", "VISUAL", "PAGER", "GITHUB_ACTIONS", "VERCEL", "HOSTNAME", "INIT_CWD", "MODE", "DEV", "PROD", "SSR", "BASE_URL"])

export function findUsages(source: string, file: string): Usage[] {
  // Commented-out code doesn't read anything.
  const src = stripComments(source, { keepStrings: true })
  const out: Usage[] = []
  const push = (key: string, idx: number) => out.push({ key, file, line: lineOf(src, idx) })
  for (const m of src.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) push(m[1]!, m.index!)
  for (const m of src.matchAll(/\bprocess\.env\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g)) push(m[2]!, m.index!)
  for (const m of src.matchAll(/\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) push(m[1]!, m.index!)
  for (const m of src.matchAll(/\bDeno\.env\.get\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)) push(m[2]!, m.index!)
  for (const m of src.matchAll(/\bBun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) push(m[1]!, m.index!)
  // const { A, B: b, C = "x" } = process.env
  for (const m of src.matchAll(/\{([^{}]+)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g)) {
    for (const part of m[1]!.split(",")) {
      const k = part.trim().split(/[:=\s]/)[0]
      if (k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== "...") push(k, m.index!)
    }
  }
  return out
}

/** Keys of a zod object schema (handles .extend/.merge results and ZodEffects wrappers). */
export function zodShape(schema: any): Record<string, any> | null {
  let s = schema
  for (let i = 0; i < 5 && s; i++) {
    const shape = typeof s.shape === "function" ? s.shape() : s.shape ?? s._def?.shape?.() ?? s._zod?.def?.shape
    if (shape && typeof shape === "object") return shape
    s = s._def?.schema ?? s._def?.innerType ?? s._zod?.def?.in ?? s._zod?.def?.innerType
  }
  return null
}

function zodOptional(field: any): boolean {
  try {
    return field?.safeParse?.(undefined)?.success === true
  } catch {
    return false
  }
}

// ── Docker and CI ─────────────────────────────────────────────────────────────
type Provided = { source: string; keys: Map<string, number> }

async function composeProviders(root: string, files: string[]): Promise<{ file: string; service: string; keys: Set<string>; envFiles: string[] }[]> {
  const out = []
  for (const f of files.filter((x) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(x))) {
    let doc: any
    try {
      doc = parseYaml(await readText(join(root, f)))
    } catch {
      continue
    }
    const anchors = new Set<string>()
    for (const [name, svc] of Object.entries<any>(doc?.services ?? {})) {
      if (!svc || typeof svc !== "object" || !svc.build) continue
      const env = Array.isArray(svc.environment) ? svc.environment.map((e: string) => String(e).split("=")[0]) : Object.keys(svc.environment ?? {})
      const envFiles = (Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : []).map((e: any) => (typeof e === "string" ? e : e.path))
      anchors.add(name)
      out.push({ file: f, service: name, keys: new Set<string>(env), envFiles })
    }
  }
  return out
}

async function workflowKeys(root: string, files: string[]) {
  const out: { file: string; keys: Map<string, number> }[] = []
  for (const f of files.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
    const text = await readText(join(root, f))
    const keys = new Map<string, number>()
    text.split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/\$\{\{\s*(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) if (m[1] !== "GITHUB_TOKEN") keys.set(m[1]!, i + 1)
      const env = l.match(/^\s{2,}([A-Z][A-Z0-9_]+):\s*\S/)
      if (env && !/^(NODE_VERSION|CI|FORCE_COLOR|TZ)$/.test(env[1]!)) keys.set(env[1]!, keys.get(env[1]!) ?? i + 1)
    })
    out.push({ file: f, keys })
  }
  return out
}

// ── The check ─────────────────────────────────────────────────────────────────
export type EnvCheckOptions = {
  envFiles?: string[]
  example?: string
  schema?: string
  schemaExport?: string
  vars?: Record<string, VarSpec>
  /** Validate the real process environment instead of / in addition to files (deploy-time). */
  processEnv?: NodeJS.ProcessEnv
  scanCode?: boolean
  checkInfra?: boolean
  /** Keys used in code that are provided by the platform and needn't be documented. */
  allow?: string[]
  /** Sub-folders checked separately (workspace packages with their own .env.example). */
  excludeDirs?: string[]
}

export async function checkEnv(root: string, o: EnvCheckOptions = {}): Promise<ToolResult> {
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)
  const allow = new Set([...NODE_INTERNAL, ...(o.allow ?? [])])

  const exampleName = o.example ?? [".env.example", ".env.sample", ".env.template", ".env.dist"].find((f) => exists(join(root, f))) ?? ".env.example"
  const example = exists(join(root, exampleName)) ? parseDotenv(await readText(join(root, exampleName))) : null
  const envNames = o.envFiles?.length ? o.envFiles : exists(join(root, ".env")) ? [".env"] : []

  // Build the spec: config vars < example annotations < zod schema (most specific wins).
  const specs = new Map<string, VarSpec>()
  for (const e of example ?? []) specs.set(e.key, specFromAnnotations(e))
  for (const [k, v] of Object.entries(o.vars ?? {})) specs.set(k, { required: true, ...specs.get(k), ...v })

  let zod: any = null
  if (o.schema) {
    const path = resolve(root, o.schema)
    if (!exists(path)) throw new UsageError(`Schema file not found: ${o.schema}`)
    let mod: any
    try {
      mod = await importModule(path)
    } catch (err) {
      throw new UsageError(`Couldn't load ${o.schema}: ${(err as Error).message.split("\n")[0]}`)
    }
    zod = o.schemaExport ? mod[o.schemaExport] : mod.envSchema ?? mod.schema ?? mod.env ?? mod.default
    if (!zod || typeof zod.safeParse !== "function") throw new UsageError(`${o.schema} must export a Zod schema (as "envSchema", "schema", default, or the name given with --schema-export)`)
    const shape = zodShape(zod)
    if (shape) for (const [k, field] of Object.entries(shape)) specs.set(k, { ...specs.get(k), required: !zodOptional(field) })
  }

  if (!example) add({ rule: "no-example", severity: "warning", message: `No ${exampleName} documenting the environment`, hint: "Commit one with every variable and a safe placeholder value." })
  else {
    const seen = new Map<string, number>()
    for (const e of example) {
      if (seen.has(e.key)) add({ rule: "duplicate-key", severity: "warning", message: `${e.key} is defined twice in ${exampleName}`, file: exampleName, line: e.line })
      seen.set(e.key, e.line)
      const secret = looksLikeRealSecret(e.key, e.value)
      if (secret) add({ rule: "secret-in-example", severity: "error", message: `${e.key} in ${exampleName} looks like a real ${secret} (${mask(e.value)})`, file: exampleName, line: e.line, hint: "Replace it with a placeholder and rotate the credential: example files are committed." })
      const spec = specs.get(e.key)
      if (spec && e.value && !PLACEHOLDER.test(e.value)) {
        const err = checkValue(spec, e.value)
        if (err) add({ rule: "invalid-example", severity: "warning", message: `${e.key} example value: ${err}`, file: exampleName, line: e.line })
      }
      if (typeof e.annotations.type === "string" && !e.annotations.type.includes("|") && !TYPES[e.annotations.type]) add({ rule: "unknown-type", severity: "warning", message: `Unknown @type "${e.annotations.type}" for ${e.key}`, file: exampleName, line: e.line, hint: `Use one of: ${TYPE_NAMES.join(", ")}, or a|b|c for a list.` })
    }
  }

  // Validate each env file (and/or the process environment).
  const targets: { name: string; values: Map<string, { value: string; line?: number }> }[] = []
  for (const name of envNames) {
    const path = join(root, name)
    if (!exists(path)) {
      add({ rule: "env-file-missing", severity: "error", message: `${name} doesn't exist` })
      continue
    }
    const entries = parseDotenv(await readText(path))
    const values = new Map<string, { value: string; line?: number }>()
    for (const e of entries) {
      if (values.has(e.key)) add({ rule: "duplicate-key", severity: "warning", message: `${e.key} is defined twice in ${name}; the last one wins`, file: name, line: e.line })
      values.set(e.key, { value: e.value, line: e.line })
    }
    targets.push({ name, values })
  }
  if (o.processEnv) targets.push({ name: "the environment", values: new Map(Object.entries(o.processEnv).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { value: v! }])) })

  for (const t of targets) {
    const isProcess = t.name === "the environment"
    for (const [key, spec] of specs) {
      const v = t.values.get(key)
      const file = isProcess ? undefined : t.name
      if (!v) {
        if (spec.required !== false) add({ rule: "missing", severity: "error", message: `${key} is missing from ${t.name}`, file, hint: example?.some((e) => e.key === key) ? `See ${exampleName} for an example value.` : undefined })
        continue
      }
      if (v.value === "") {
        if (spec.required !== false) add({ rule: "empty", severity: "error", message: `${key} is empty in ${t.name}`, file, line: v.line, hint: example?.some((e) => e.key === key) ? `If it's optional, mark it in ${exampleName} with a "# @optional" comment above it.` : undefined })
        continue
      }
      const err = checkValue(spec, v.value)
      if (err) add({ rule: "invalid", severity: "error", message: `${key} in ${t.name}: ${err}`, file, line: v.line })
    }
    if (zod) {
      const obj = Object.fromEntries([...t.values].map(([k, v]) => [k, v.value]))
      const res = zod.safeParse(obj)
      if (!res.success) {
        for (const issue of res.error.issues ?? []) {
          const key = String(issue.path?.[0] ?? "")
          // Missing keys are already reported above; this adds type and refinement errors.
          if (key && !t.values.has(key) && specs.get(key)?.required !== false) continue
          const line = t.values.get(key)?.line
          // Zod messages can include the received value; keep only the rule.
          const msg = String(issue.message ?? "invalid").replace(/received\s+['"]?[^'"]*['"]?/gi, "").replace(/\s{2,}/g, " ").trim()
          add({ rule: "schema", severity: "error", message: `${key || "(root)"} in ${t.name}: ${msg}`, file: isProcess ? undefined : t.name, line })
        }
      }
    }
    if (!isProcess && example) {
      const documented = new Set(example.map((e) => e.key))
      for (const [key, v] of t.values) if (!documented.has(key) && !specs.has(key)) add({ rule: "undocumented", severity: "warning", message: `${key} is set in ${t.name} but not documented in ${exampleName}`, file: t.name, line: v.line, hint: "Add it to the example so others know it exists." })
    }
  }

  // Code usage.
  const exclude = (o.excludeDirs ?? []).map((d) => `/${d}/`)
  const files = await walk(root, { extensions: SOURCE_EXTENSIONS, ignore: exclude })
  const usages: Usage[] = []
  if (o.scanCode !== false) {
    for (const f of files) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__)\//.test(f)) continue
      try {
        usages.push(...findUsages(await readText(join(root, f)), f))
      } catch {}
    }
    const used = new Map<string, Usage>()
    for (const u of usages) if (!used.has(u.key)) used.set(u.key, u)
    for (const [key, u] of used) {
      if (allow.has(key) || specs.has(key) || key.startsWith("npm_")) continue
      add({ rule: "used-undocumented", severity: example || zod ? "error" : "warning", message: `${key} is read by the code but not documented`, file: u.file, line: u.line, hint: `Add it to ${exampleName}${zod ? " and the schema" : ""}.` })
    }
    // Variables consumed by docker-compose (${VAR}) or Dockerfiles count as used.
    const infraText = (await Promise.all((await walk(root, { ignore: exclude })).filter((f) => /(^|\/)((docker-)?compose[\w.-]*\.ya?ml|Dockerfile[\w.-]*)$/.test(f)).map((f) => readText(join(root, f))))).join("\n")
    for (const m of infraText.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)) if (!used.has(m[1]!)) used.set(m[1]!, { key: m[1]!, file: "docker-compose", line: 0 })
    // Only flag unused when the code reads env directly (not through a config loader that iterates keys).
    if (usages.length) {
      const dynamic = files.length && usages.length && (await anyDynamicAccess(root, files))
      for (const [key] of specs) {
        if (used.has(key) || dynamic) continue
        const line = example?.find((e) => e.key === key)?.line
        add({ rule: "unused", severity: "info", message: `${key} is documented but never read in the code`, file: line ? exampleName : undefined, line, hint: "Remove it, or allow it in config if a tool or platform reads it." })
      }
    }
  }

  // Docker and CI.
  if (o.checkInfra !== false) {
    const allFiles = await walk(root, { ignore: exclude })
    const services = await composeProviders(root, allFiles)
    const mustProvide = [...specs].filter(([k, s]) => s.required !== false && !(example?.find((e) => e.key === k)?.value && !looksLikeRealSecret(k, example.find((e) => e.key === k)!.value) && !PLACEHOLDER.test(example.find((e) => e.key === k)!.value))).map(([k]) => k)
    for (const svc of services) {
      // env_file provides the whole set; a service with no environment at all (a static web
      // server, a proxy) doesn't run this code.
      if (svc.envFiles.length || !svc.keys.size) continue
      for (const key of mustProvide) if (!svc.keys.has(key)) add({ rule: "compose-missing", severity: "warning", message: `${svc.file}: service "${svc.service}" doesn't set ${key}, which has no default`, file: svc.file })
      for (const key of svc.keys) if (example && !specs.has(key) && !allow.has(key)) add({ rule: "compose-undocumented", severity: "info", message: `${svc.file}: "${svc.service}" sets ${key}, which isn't documented in ${exampleName}`, file: svc.file })
    }
    for (const wf of await workflowKeys(root, allFiles)) {
      for (const [key, line] of wf.keys) if (example && !specs.has(key) && usages.some((u) => u.key === key)) add({ rule: "ci-undocumented", severity: "info", message: `${wf.file} provides ${key}, which the code reads but ${exampleName} doesn't document`, file: wf.file, line })
    }
  }

  return {
    tool: "envdoctor",
    title: "EnvDoctor",
    summary: { documented: specs.size, "read in code": new Set(usages.map((u) => u.key)).size, checked: targets.map((t) => t.name).join(", ") || "example only", schema: zod ? o.schema! : "none" },
    findings,
  }
}

async function anyDynamicAccess(root: string, files: string[]) {
  for (const f of files.slice(0, 1500)) {
    try {
      const src = await readText(join(root, f))
      if (/(?:parse|safeParse|validate|cleanEnv|createEnv)\s*\(\s*(?:process\.env|import\.meta\.env)\s*[,)]/.test(src) || /Object\.(keys|entries)\(\s*process\.env\s*\)/.test(src)) return true
    } catch {}
  }
  return false
}

export const envdoctor: ToolDef = {
  name: "envdoctor",
  tagline: "Validate .env files against .env.example, a Zod schema and what the code actually reads",
  commands: {
    check: {
      description: "Compare env files, example, schema, code, Docker Compose and CI",
      usage: "[--env .env] [--example .env.example] [--schema src/env.ts]",
      options: {
        env: { type: "string", multiple: true, description: "Env file(s) to validate (default: .env if present)" },
        example: { type: "string", description: "Documented variables (default: .env.example)" },
        schema: { type: "string", description: "A TS/JS file exporting a Zod schema" },
        "schema-export": { type: "string", description: "Export name of the schema (default: envSchema, schema or default)" },
        process: { type: "boolean", description: "Also validate the current process environment (use at deploy time)" },
        "no-code": { type: "boolean", description: "Don't scan source code for process.env usage" },
        "no-infra": { type: "boolean", description: "Don't check docker-compose and GitHub workflows" },
        allow: { type: "string", multiple: true, description: "Variables provided by the platform that needn't be documented" },
      },
      async run(ctx) {
        ctx.log("Checking environment configuration…")
        const cfg = ctx.config as EnvCheckOptions & { env?: string[] }
        // Workspace packages with their own .env.example are checked on their own.
        const packages = ctx.options.example || ctx.options.env ? [] : workspaceDirs(ctx.cwd).filter((d) => [".env.example", ".env.sample", ".env.template"].some((f) => exists(join(ctx.cwd, d, f))))
        const sub: ToolResult[] = []
        for (const dir of packages) {
          const r = await checkEnv(join(ctx.cwd, dir), { scanCode: !ctx.options["no-code"], checkInfra: false, allow: [...((ctx.options.allow as string[]) ?? []), ...(cfg.allow ?? [])], processEnv: ctx.options.process ? ctx.env : undefined })
          sub.push({ ...r, findings: r.findings.map((f) => ({ ...f, file: f.file ? `${dir}/${f.file}` : undefined, message: f.file || f.message.includes(dir) ? f.message : `${dir}: ${f.message}` })) })
        }
        const rootResult = await checkEnv(ctx.cwd, {
          excludeDirs: packages,
          envFiles: (ctx.options.env as string[] | undefined) ?? cfg.envFiles ?? cfg.env,
          example: (ctx.options.example as string) ?? cfg.example,
          schema: (ctx.options.schema as string) ?? cfg.schema,
          schemaExport: (ctx.options["schema-export"] as string) ?? cfg.schemaExport,
          vars: cfg.vars,
          processEnv: ctx.options.process ? ctx.env : undefined,
          scanCode: !ctx.options["no-code"],
          checkInfra: !ctx.options["no-infra"],
          allow: [...((ctx.options.allow as string[]) ?? []), ...(cfg.allow ?? [])],
        })
        if (!sub.length) return rootResult
        // A root without its own example is fine when packages document their own variables.
        rootResult.findings = rootResult.findings.filter((f) => f.rule !== "no-example")
        return {
          ...rootResult,
          summary: { ...rootResult.summary, packages: packages.join(", ") },
          findings: [...rootResult.findings, ...sub.flatMap((r) => r.findings)],
        }
      },
    },
  },
}
