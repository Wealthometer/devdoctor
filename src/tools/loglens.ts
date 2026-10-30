import { createReadStream, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import { exists, isDir, toPosix, walk } from "../core/fs.js"
import { UsageError, type Finding, type Severity, type ToolDef, type ToolResult } from "../core/types.js"

/**
 * LogLens: turns a pile of logs into a short list of distinct problems. Reads JSON logs (pino,
 * bunyan, winston, ECS) and common text formats, joins stack traces to their entries, groups
 * errors by a normalised fingerprint, and points out recurring exceptions and bursts.
 */

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const
export type Level = (typeof LEVELS)[number]
const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

export type Entry = { time: Date | null; level: Level; message: string; errorType: string | null; stack: string[]; file: string; line: number; fields: Record<string, unknown> }

export function normalizeLevel(v: unknown): Level | null {
  if (typeof v === "number") return v >= 60 ? "fatal" : v >= 50 ? "error" : v >= 40 ? "warn" : v >= 30 ? "info" : v >= 20 ? "debug" : "trace"
  const s = String(v ?? "").toLowerCase().trim()
  if (/^(trace|verbose|silly|finest|finer)$/.test(s)) return "trace"
  if (/^(debug|dbg|fine|config)$/.test(s)) return "debug"
  if (/^(info|information|notice|log|http|informational)$/.test(s)) return "info"
  if (/^(warn|warning|wrn)$/.test(s)) return "warn"
  if (/^(error|err|severe|eror)$/.test(s)) return "error"
  if (/^(fatal|critical|crit|panic|emerg|emergency|alert)$/.test(s)) return "fatal"
  return null
}

const TIME_KEYS = ["time", "timestamp", "@timestamp", "ts", "date", "datetime", "t"]
const LEVEL_KEYS = ["level", "severity", "levelname", "lvl", "log.level", "loglevel", "status"]
const MSG_KEYS = ["msg", "message", "event", "log", "text", "error.message"]

function parseTime(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null
  if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v)
  const s = String(v).trim()
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return new Date(Number(s))
  // "2024-01-01 12:00:00,123" (Python) → ISO
  const iso = s.replace(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:[.,](\d+))?/, (_, d, t, ms) => `${d}T${t}${ms ? `.${ms.slice(0, 3)}` : ""}`)
  const d = new Date(iso)
  if (!Number.isNaN(d.getTime())) return d
  // Apache/nginx: 10/Oct/2024:13:55:36 +0000
  const m = s.match(/^(\d\d)\/(\w{3})\/(\d{4}):(\d\d:\d\d:\d\d)(?: ([+-]\d{4}))?/)
  if (m) {
    const d2 = new Date(`${m[2]} ${m[1]} ${m[3]} ${m[4]} ${m[5] ? `GMT${m[5]}` : "UTC"}`)
    if (!Number.isNaN(d2.getTime())) return d2
  }
  return null
}

const get = (o: Record<string, any>, key: string) => (key.includes(".") ? key.split(".").reduce<any>((x, k) => x?.[k], o) ?? o[key] : o[key])

/** Parses one line. Returns null for continuation lines (stack frames) and blanks. */
export function parseLine(rawLine: string): Omit<Entry, "file" | "line"> | null {
  // Colour codes from dev-mode loggers (Nest, pino-pretty, Vite).
  const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "")
  const t = line.trim()
  if (!t) return null
  // logfmt (Go, logrus, Docker, Heroku): time="…" level=info msg="…" key=value
  if (/^(\w[\w.-]*=("([^"\\]|\\.)*"|\S*)\s*){2,}$/.test(t) && /\b(level|lvl|msg|time|ts)=/.test(t)) {
    const fields: Record<string, string> = {}
    for (const m of t.matchAll(/(\w[\w.-]*)=("((?:[^"\\]|\\.)*)"|(\S*))/g)) fields[m[1]!] = m[3] !== undefined ? m[3].replace(/\\"/g, '"') : m[4]!
    const level = normalizeLevel(fields.level ?? fields.lvl ?? fields.severity) ?? (fields.error || fields.err ? "error" : "info")
    const message = fields.msg ?? fields.message ?? ""
    const err = fields.error ?? fields.err
    return withError({ time: parseTime(fields.time ?? fields.ts ?? fields.t), level, message: err && level !== "info" && level !== "debug" ? `${message}: ${err}` : message, errorType: null, stack: [], fields })
  }
  // NestJS: [Nest] 4112  - 10/29/2026, 10:46:21 PM   ERROR [ExceptionsHandler] message
  let nest: RegExpMatchArray | null
  if ((nest = t.match(/^\[Nest\]\s+\d+\s+-\s+(.+?)\s{2,}(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]+)\]\s+)?(.*?)(?:\s+\+\d+ms)?$/))) {
    const lvl = nest[2] === "LOG" ? "info" : nest[2] === "VERBOSE" ? "trace" : normalizeLevel(nest[2])!
    return withError({ time: parseTime(nest[1]), level: lvl, message: nest[4]!, errorType: null, stack: [], fields: { context: nest[3] } })
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const o = JSON.parse(t)
      const levelRaw = LEVEL_KEYS.map((k) => get(o, k)).find((v) => v !== undefined)
      let level = normalizeLevel(levelRaw)
      if (!level && typeof o.status === "number") level = o.status >= 500 ? "error" : o.status >= 400 ? "warn" : "info"
      const err = o.err ?? o.error ?? o.exception ?? null
      const errObj = err && typeof err === "object" ? err : null
      const message = String(MSG_KEYS.map((k) => get(o, k)).find((v) => typeof v === "string" && v) ?? errObj?.message ?? (typeof err === "string" ? err : "") ?? "")
      const stackText: string = errObj?.stack ?? o.stack ?? o.stack_trace ?? get(o, "error.stack_trace") ?? ""
      const stack = String(stackText).split("\n").slice(1).map((s) => s.trim()).filter(Boolean)
      const errorType = errObj?.type ?? errObj?.name ?? get(o, "error.type") ?? (String(stackText).match(/^([A-Z]\w*(?:Error|Exception))\b/)?.[1] ?? null)
      return { time: parseTime(TIME_KEYS.map((k) => get(o, k)).find((v) => v !== undefined)), level: level ?? (errObj ? "error" : "info"), message: message || (errorType ?? ""), errorType, stack, fields: o }
    } catch {
      // Not JSON after all; fall through.
    }
  }
  // Stack frames and other continuation lines belong to the previous entry.
  if (/^\s+(at |\.\.\. \d+ more|File ")/.test(line) || /^(Caused by:|Traceback \(most recent call last\):)/.test(t) || /^\s{2,}\S/.test(line)) return null

  let m: RegExpMatchArray | null
  // Access logs: 127.0.0.1 - - [10/Oct/2024:13:55:36 +0000] "GET /x HTTP/1.1" 500 123
  if ((m = t.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\w+) ([^"\s]+)[^"]*" (\d{3}) (\d+|-)/))) {
    const status = Number(m[5])
    return { time: parseTime(m[2]), level: status >= 500 ? "error" : status >= 400 ? "warn" : "info", message: `${m[3]} ${m[4]} → ${status}`, errorType: status >= 500 ? `HTTP ${status}` : null, stack: [], fields: { ip: m[1], method: m[3], path: m[4], status } }
  }
  // Timestamp first, then level: "2024-01-01T12:00:00Z ERROR msg", "[2024-01-01 12:00:00] ERROR: msg", Python "… - name - ERROR - msg", log4j "… ERROR [main] Class - msg"
  if ((m = t.match(/^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\]?\s+(?:-\s+[\w.]+\s+-\s+)?\[?([A-Za-z]+)\]?:?\s*(?:-\s+)?(?:\[[^\]]*\]\s*)?(.*)$/))) {
    const level = normalizeLevel(m[2])
    if (level) return withError({ time: parseTime(m[1]), level, message: m[3]!.replace(/^[\w.$]+ - /, ""), errorType: null, stack: [], fields: {} })
    return withError({ time: parseTime(m[1]), level: guessLevel(`${m[2]} ${m[3]}`), message: `${m[2]} ${m[3]}`, errorType: null, stack: [], fields: {} })
  }
  // An exception line on its own ("TypeError: x is undefined", "Error: read ECONNRESET") starts an entry.
  if ((m = t.match(/^((?:[\w$]+\.)*(?:[A-Z]\w*)?(?:Error|Exception))(?::\s+(.*))?$/))) return { time: null, level: "error", message: t, errorType: m[1]!.split(".").pop()!, stack: [], fields: {} }
  // Time of day only (dev servers): "10:39:48 PM [vite] ws proxy error:"
  if ((m = t.match(/^(\d{1,2}:\d\d:\d\d(?:\.\d+)?(?:\s?[AP]M)?)\s+(.*)$/i))) return withError({ time: null, level: guessLevel(m[2]!), message: m[2]!, errorType: null, stack: [], fields: {} })
  // Level first: "ERROR 2024-01-01 … msg" or "ERROR: msg" or "[error] msg"
  if ((m = t.match(/^\[?([A-Za-z]+)\]?:?\s+(?:\[?(\d{4}-\d\d-\d\d[T ][\d:.,]+(?:Z|[+-]\d\d:?\d\d)?)\]?\s+)?(.*)$/)) && normalizeLevel(m[1])) {
    return withError({ time: parseTime(m[2]), level: normalizeLevel(m[1])!, message: m[3]!, errorType: null, stack: [], fields: {} })
  }
  // Syslog: "Oct 10 13:55:36 host app[123]: msg"
  if ((m = t.match(/^(\w{3}\s+\d{1,2} \d\d:\d\d:\d\d) \S+ ([\w./-]+)(?:\[\d+\])?: (.*)$/))) {
    const year = new Date().getFullYear()
    return withError({ time: parseTime(`${m[1]} ${year}`), level: guessLevel(m[3]!), message: m[3]!, errorType: null, stack: [], fields: { program: m[2] } })
  }
  return withError({ time: null, level: guessLevel(t), message: t, errorType: null, stack: [], fields: {} })
}

function guessLevel(s: string): Level {
  if (/\b(fatal|panic|critical)\b/i.test(s)) return "fatal"
  if (/\b(error|exception|failed|failure|uncaught|unhandled)\b/i.test(s)) return "error"
  if (/\b(warn(ing)?|deprecated|retry(ing)?)\b/i.test(s)) return "warn"
  if (/\bdebug\b/i.test(s)) return "debug"
  return "info"
}

function withError<T extends { message: string; errorType: string | null; level: Level }>(e: T): T {
  const m = e.message.match(/\b((?:[\w$]+\.)*[A-Z]\w*(?:Error|Exception))\b(?::|\s)/)
  if (m && !e.errorType) e.errorType = m[1]!.split(".").pop()!
  return e
}

/** Turns a message into a stable fingerprint by replacing the parts that vary between occurrences. */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<ip>")
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/g, "<time>")
    .replace(/\b(0x)?[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "<str>")
    .replace(/\/\d+(?=\/|\b)/g, "/<n>")
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|b)?\b/gi, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

/** The first stack frame in your own code (not node_modules or Node internals), if any. */
export function topFrame(stack: string[]): string | null {
  const frames = stack.filter((s) => /^at |File "/.test(s))
  // Only frames in application code identify where a problem comes from; runtime internals don't.
  const own = frames.find((f) => !/node_modules|node:internal|\(internal\/|<anonymous>|site-packages|\(node:/.test(f))
  return own?.replace(/^at /, "").replace(/:\d+:\d+\)?$/, (m) => (m.endsWith(")") ? ")" : "")) ?? null
}

export type Group = { key: string; level: Level; errorType: string | null; example: string; pattern: string; count: number; first: Date | null; last: Date | null; frame: string | null; file: string; line: number; files: Set<string> }

export type Filters = { minLevel?: Level; since?: Date; until?: Date; grep?: RegExp; fields?: [string, string][] }

export function parseSince(v: string, now = Date.now()): Date {
  const rel = v.match(/^(\d+)\s*(s|m|h|d|w)$/i)
  if (rel) return new Date(now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]!.toLowerCase() as "s"]!)
  const d = parseTime(v)
  if (!d) throw new UsageError(`Can't read "${v}" as a time. Use ISO (2024-05-01T10:00:00Z) or relative (30m, 6h, 2d).`)
  return d
}

export async function* readEntries(source: { path: string; stream: NodeJS.ReadableStream }): AsyncGenerator<Entry> {
  const rl = createInterface({ input: source.stream as Readable, crlfDelay: Infinity })
  let current: Entry | null = null
  let n = 0
  for await (const raw of rl) {
    n++
    const parsed = parseLine(raw)
    if (!parsed) {
      if (current && raw.trim()) current.stack.push(raw.replace(/\x1b\[[0-9;]*m/g, "").trim())
      continue
    }
    // "request failed:" followed by "Error: read ECONNRESET" on the next line is one event.
    if (current && parsed.errorType && !parsed.time && /:\s*$/.test(current.message) && !current.stack.length) {
      current.message = `${current.message.trimEnd()} ${parsed.message}`
      current.errorType ??= parsed.errorType
      if (RANK[parsed.level] > RANK[current.level]) current.level = parsed.level
      continue
    }
    if (current) yield current
    current = { ...parsed, file: source.path, line: n }
  }
  if (current) yield current
}

function openSource(path: string): NodeJS.ReadableStream {
  const s = createReadStream(path)
  return path.endsWith(".gz") ? s.pipe(createGunzip()) : s
}

export type Analysis = { total: number; matched: number; byLevel: Record<Level, number>; groups: Group[]; first: Date | null; last: Date | null; perMinute: Map<number, number>; entries?: Entry[] }

export async function analyzeLogs(sources: { path: string; stream: NodeJS.ReadableStream }[], f: Filters = {}): Promise<Analysis> {
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>
  const groups = new Map<string, Group>()
  const perMinute = new Map<number, number>()
  let total = 0
  let matched = 0
  let first: Date | null = null
  let last: Date | null = null
  const min = RANK[f.minLevel ?? "warn"]
  for (const src of sources) {
    for await (const e of readEntries(src)) {
      total++
      if (f.since && e.time && e.time < f.since) continue
      if (f.until && e.time && e.time > f.until) continue
      if (f.grep && !f.grep.test(e.message) && !f.grep.test(e.stack.join("\n"))) continue
      if (f.fields?.some(([k, v]) => String(get(e.fields as Record<string, any>, k)) !== v)) continue
      matched++
      byLevel[e.level]++
      if (e.time) {
        if (!first || e.time < first) first = e.time
        if (!last || e.time > last) last = e.time
      }
      if (RANK[e.level] < min) continue
      if (e.time && RANK[e.level] >= RANK.error) {
        const minute = Math.floor(e.time.getTime() / 60_000)
        perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1)
      }
      // Stack traces often carry the error type on their first line.
      const errorType = e.errorType ?? e.stack.map((s) => s.match(/^([A-Z]\w*(?:Error|Exception))\b/)?.[1]).find(Boolean) ?? null
      const pattern = normalizeMessage(e.message)
      const frame = topFrame(e.stack)
      const key = `${e.level === "fatal" ? "error" : e.level}|${errorType ?? ""}|${pattern}|${frame ?? ""}`
      const g = groups.get(key)
      if (g) {
        g.count++
        if (e.time && (!g.first || e.time < g.first)) g.first = e.time
        if (e.time && (!g.last || e.time > g.last)) g.last = e.time
        if (RANK[e.level] > RANK[g.level]) g.level = e.level
        g.files.add(e.file)
      } else groups.set(key, { key, level: e.level, errorType, example: e.message.slice(0, 300), pattern, count: 1, first: e.time, last: e.time, frame, file: e.file, line: e.line, files: new Set([e.file]) })
    }
  }
  return { total, matched, byLevel, groups: [...groups.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || b.count - a.count), first, last, perMinute }
}

/** Minutes where errors jump well above the usual rate. */
export function findBursts(perMinute: Map<number, number>): { minute: number; count: number; typical: number }[] {
  if (perMinute.size < 3) return []
  const counts = [...perMinute.values()].sort((a, b) => a - b)
  const median = counts[Math.floor(counts.length / 2)]!
  return [...perMinute].filter(([, c]) => c >= 5 && c >= median * 4).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([minute, count]) => ({ minute, count, typical: median }))
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z") : "–")

export async function collectSources(cwd: string, paths: string[], stdin?: NodeJS.ReadableStream) {
  if (!paths.length || (paths.length === 1 && paths[0] === "-")) {
    if (!stdin || (stdin as NodeJS.ReadStream).isTTY) throw new UsageError("Give a log file or folder, or pipe logs in: kubectl logs app | loglens analyze -")
    return [{ path: "stdin", stream: stdin }]
  }
  const out: { path: string; stream: NodeJS.ReadableStream }[] = []
  for (const p of paths) {
    const abs = resolve(cwd, p)
    if (!exists(abs)) throw new UsageError(`Not found: ${p}`)
    const files = isDir(abs) ? (await walk(abs, { respectGitignore: false })).filter((f) => /\.(log|txt|jsonl|ndjson|out|gz)$|\.log\.\d+$/.test(f)).map((f) => resolve(abs, f)) : [abs]
    for (const f of files) {
      const rel = toPosix(relative(cwd, f))
      out.push({ path: rel && !rel.startsWith("..") ? rel : f, stream: openSource(f) })
    }
  }
  if (!out.length) throw new UsageError(`No log files (*.log, *.jsonl, *.gz…) in ${paths.join(", ")}`)
  return out
}

export const loglens: ToolDef = {
  name: "loglens",
  tagline: "Group errors in JSON or text logs, surface recurring exceptions and bursts",
  commands: {
    analyze: {
      description: "Summarise a log file, folder, or stdin (-)",
      usage: "<file|dir|-> [--level warn] [--since 2h] [--grep pattern]",
      options: {
        level: { type: "string", short: "l", description: "Lowest level to group: trace, debug, info, warn, error, fatal (default: warn)" },
        since: { type: "string", description: "Only entries after this time (ISO or 30m, 6h, 2d ago)" },
        until: { type: "string", description: "Only entries before this time" },
        grep: { type: "string", short: "g", description: "Only entries whose message or stack matches this regex" },
        field: { type: "string", multiple: true, description: "JSON logs: only entries where key=value (e.g. --field service=api)" },
        top: { type: "string", description: "How many groups to list (default: 15)" },
        csv: { type: "string", description: "Also export all groups to a CSV file" },
      },
      async run(ctx): Promise<ToolResult> {
        const level = (ctx.options.level as string | undefined) ?? ((ctx.config as { level?: string }).level ?? "warn")
        if (!(LEVELS as readonly string[]).includes(level)) throw new UsageError(`--level must be one of ${LEVELS.join(", ")}`)
        let grep: RegExp | undefined
        if (ctx.options.grep) {
          try {
            grep = new RegExp(String(ctx.options.grep), "i")
          } catch {
            throw new UsageError(`--grep isn't a valid regular expression`)
          }
        }
        const fields = ((ctx.options.field as string[] | undefined) ?? []).map((kv) => {
          const i = kv.indexOf("=")
          if (i <= 0) throw new UsageError(`--field expects key=value, got "${kv}"`)
          return [kv.slice(0, i), kv.slice(i + 1)] as [string, string]
        })
        const sources = await collectSources(ctx.cwd, ctx.positionals, process.stdin)
        ctx.log(`Reading ${sources.length} source${sources.length > 1 ? "s" : ""}…`)
        const a = await analyzeLogs(sources, { minLevel: level as Level, since: ctx.options.since ? parseSince(String(ctx.options.since)) : undefined, until: ctx.options.until ? parseSince(String(ctx.options.until)) : undefined, grep, fields })
        const top = Number(ctx.options.top ?? 15)
        const bursts = findBursts(a.perMinute)
        const errors = a.byLevel.error + a.byLevel.fatal
        const findings: Finding[] = a.groups.slice(0, Math.max(top, 50)).map((g) => {
          const sev: Severity = RANK[g.level] >= RANK.error ? "error" : g.level === "warn" ? "warning" : "info"
          const span = g.count > 1 && g.first && g.last ? `, ${fmt(g.first)} → ${fmt(g.last)}` : g.first ? `, at ${fmt(g.first)}` : ""
          return { rule: g.count > 1 ? "recurring" : "single", severity: sev, message: `${g.count}× ${g.errorType && !g.example.includes(g.errorType) ? `${g.errorType}: ` : ""}${g.example}${span}`, file: g.file, line: g.line, hint: g.frame ? `at ${g.frame}` : undefined }
        })
        for (const b of bursts) findings.push({ rule: "burst", severity: "warning", message: `${b.count} errors in the minute starting ${fmt(new Date(b.minute * 60_000))} (typically ${b.typical})`, hint: "Check deploys, upstream outages or traffic spikes around this time." })
        if (ctx.options.csv) {
          const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`
          const rows = [["level", "count", "error_type", "message", "pattern", "first_seen", "last_seen", "top_frame", "file", "line"], ...a.groups.map((g) => [g.level, g.count, g.errorType, g.example, g.pattern, g.first?.toISOString(), g.last?.toISOString(), g.frame, g.file, g.line])]
          writeFileSync(resolve(ctx.cwd, String(ctx.options.csv)), rows.map((r) => r.map(q).join(",")).join("\n") + "\n")
        }
        const hours = a.first && a.last ? (a.last.getTime() - a.first.getTime()) / 36e5 : 0
        return {
          tool: "loglens",
          title: "LogLens",
          summary: {
            entries: a.total,
            ...(a.matched !== a.total ? { matched: a.matched } : {}),
            errors,
            warnings: a.byLevel.warn,
            "distinct problems": a.groups.length,
            range: a.first ? `${fmt(a.first)} → ${fmt(a.last)}` : "no timestamps",
            ...(hours >= 1 ? { "errors/hour": Math.round((errors / hours) * 10) / 10 } : {}),
          },
          sections: [
            { kind: "table", title: "Entries by level", headers: ["Level", "Count", "Share"], rows: LEVELS.filter((l) => a.byLevel[l]).map((l) => [l, a.byLevel[l], `${((a.byLevel[l] / Math.max(1, a.matched)) * 100).toFixed(1)}%`]) },
            { kind: "table", title: `Top problems (${Math.min(top, a.groups.length)} of ${a.groups.length})`, headers: ["Count", "Level", "Problem", "Last seen"], rows: a.groups.slice(0, top).map((g) => [g.count, g.level, (g.errorType && !g.example.includes(g.errorType) ? `${g.errorType}: ` : "") + (g.example.length > 90 ? g.example.slice(0, 87) + "…" : g.example), fmt(g.last)]) },
          ],
          findings,
        }
      },
    },
  },
}

