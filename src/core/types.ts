export type Severity = "error" | "warning" | "info"

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/** One problem a tool found. `rule` is stable so it can be ignored in config. */
export type Finding = {
  rule: string
  severity: Severity
  message: string
  file?: string
  line?: number
  column?: number
  /** What to do about it, in one sentence. */
  hint?: string
}

/** Extra report content beyond findings: tables, lists, graphs or plain text. */
export type Section =
  | { kind: "table"; title: string; headers: string[]; rows: (string | number)[][] }
  | { kind: "list"; title: string; items: string[] }
  | { kind: "text"; title: string; body: string }
  | { kind: "code"; title: string; language: string; body: string }

export type ToolResult = {
  tool: string
  title: string
  /** Headline numbers shown at the top of the report. */
  summary: Record<string, string | number>
  findings: Finding[]
  sections?: Section[]
  /** 0–100, for tools that grade (RepoDoctor). */
  score?: number
  /** Printed as-is in text mode instead of a report (graphs meant for piping into other tools). */
  raw?: string
}

export type OptionSpec = {
  type: "string" | "boolean"
  short?: string
  multiple?: boolean
  description: string
  default?: string | boolean
}

export type RunContext = {
  cwd: string
  /** The tool's section of the config file, if any. */
  config: Record<string, unknown>
  /** Values for the tool's own options. */
  options: Record<string, string | boolean | string[] | undefined>
  positionals: string[]
  /** Where progress messages go (stderr), so stdout stays clean for JSON. */
  log: (msg: string) => void
  /** Injected in tests. */
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
}

export type Command = {
  description: string
  usage: string
  options?: Record<string, OptionSpec>
  run: (ctx: RunContext) => Promise<ToolResult>
}

export type ToolDef = {
  name: string
  tagline: string
  /** Subcommands; the first one is the default when none is given. */
  commands: Record<string, Command>
}

export class UsageError extends Error {}
