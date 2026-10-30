import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { c, setColor } from "./core/color.js"
import { loadConfig } from "./core/config.js"
import { FORMATS, render, renderSarif, shouldFail, counts, type Format } from "./core/report.js"
import { UsageError, type Command, type OptionSpec, type RunContext, type Severity, type ToolDef, type ToolResult } from "./core/types.js"
import { TOOLS, CHECK_SUITE } from "./tools/index.js"
import { VERSION } from "./version.js"

const COMMON: Record<string, OptionSpec> = {
  format: { type: "string", short: "f", description: `Output format: ${FORMATS.join(", ")}`, default: "text" },
  output: { type: "string", short: "o", description: "Write the report to a file instead of stdout" },
  "fail-on": { type: "string", description: "Exit with code 1 at this severity or above: error, warning, info, none", default: "error" },
  config: { type: "string", short: "c", description: "Path to a config file (default: devdoctor.config.*)" },
  cwd: { type: "string", description: "Run as if started in this directory" },
  "no-color": { type: "boolean", description: "Disable colors" },
  quiet: { type: "boolean", short: "q", description: "Only print the report, no progress" },
  help: { type: "boolean", short: "h", description: "Show help" },
}

export type IO = { stdout: (s: string) => void; stderr: (s: string) => void; env: NodeJS.ProcessEnv; cwd: string; fetch: typeof fetch }
const defaultIO = (): IO => ({ stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env, cwd: process.cwd(), fetch: globalThis.fetch })

function optionHelp(opts: Record<string, OptionSpec>) {
  return Object.entries(opts)
    .map(([k, o]) => {
      const flag = `${o.short ? `-${o.short}, ` : "    "}--${k}${o.type === "string" ? " <value>" : ""}`
      return `  ${flag.padEnd(30)} ${o.description}${o.default !== undefined && o.default !== false ? c.gray(` (default: ${o.default})`) : ""}`
    })
    .join("\n")
}

function toolHelp(tool: ToolDef, bin: string) {
  const cmds = Object.entries(tool.commands)
  return [
    `${c.bold(tool.name)} ${c.gray(`v${VERSION}`)}: ${tool.tagline}`,
    "",
    c.bold("Usage"),
    ...cmds.map(([name, cmd], i) => `  ${bin} ${cmds.length > 1 || name !== "run" ? (i === 0 ? `[${name}]` : name) : ""} ${cmd.usage}`.replace(/\s+/g, " ").trim()).map((l) => `  ${l}`),
    "",
    c.bold("Commands"),
    ...cmds.map(([name, cmd]) => `  ${name.padEnd(12)} ${cmd.description}`),
    "",
    ...cmds.flatMap(([name, cmd]) => (cmd.options && Object.keys(cmd.options).length ? [c.bold(`Options for ${name}`), optionHelp(cmd.options), ""] : [])),
    c.bold("Common options"),
    optionHelp(COMMON),
    "",
  ].join("\n")
}

function mainHelp() {
  return [
    `${c.bold("devdoctor")} ${c.gray(`v${VERSION}`)}: pre-production checks for JavaScript and TypeScript projects`,
    "",
    c.bold("Usage"),
    "  devdoctor <tool> [command] [args] [options]",
    "  devdoctor check [dir]          Run every static check that applies to this repository",
    "",
    c.bold("Tools") + c.gray("  (each is also installed as its own command)"),
    ...Object.values(TOOLS).map((t) => `  ${t.name.padEnd(13)} ${t.tagline}`),
    "",
    `Run ${c.cyan("devdoctor <tool> --help")} for a tool's commands and options.`,
    "",
  ].join("\n")
}

/**
 * Entry point for every binary. `fixedTool` is set by the standalone bins (e.g. `migraguard`);
 * the umbrella `devdoctor` reads the tool name from the first argument.
 */
export async function main(fixedTool?: string, argv = process.argv.slice(2), io: IO = defaultIO()): Promise<number> {
  try {
    let args = [...argv]
    let toolName = fixedTool
    if (!toolName) {
      const first = args[0]
      if (!first || first === "-h" || first === "--help" || first === "help") {
        io.stdout(mainHelp())
        return 0
      }
      if (first === "-v" || first === "--version") {
        io.stdout(`${VERSION}\n`)
        return 0
      }
      if (first === "check") return await runSuite(args.slice(1), io)
      toolName = first
      args = args.slice(1)
    }
    const tool = TOOLS[toolName]
    if (!tool) throw new UsageError(`Unknown tool "${toolName}". Available: ${Object.keys(TOOLS).join(", ")}`)
    if (args[0] === "-v" || args[0] === "--version") {
      io.stdout(`${VERSION}\n`)
      return 0
    }

    const names = Object.keys(tool.commands)
    const commandName = args[0] && names.includes(args[0]) ? args.shift()! : names[0]!
    const command = tool.commands[commandName]!
    const bin = fixedTool ?? `devdoctor ${tool.name}`

    const spec = { ...COMMON, ...(command.options ?? {}) }
    let parsed
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: Object.fromEntries(Object.entries(spec).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }])),
      })
    } catch (err) {
      throw new UsageError(`${(err as Error).message.replace(/^.*?: /, "")}\nRun "${bin} --help" for usage.`)
    }
    const values = parsed.values as Record<string, string | boolean | string[] | undefined>
    if (values.help) {
      io.stdout(toolHelp(tool, bin))
      return 0
    }
    for (const [k, o] of Object.entries(spec)) if (values[k] === undefined && o.default !== undefined) values[k] = o.default

    if (values["no-color"] || values.format !== "text" || values.output) setColor(false)
    const format = String(values.format) as Format
    if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}`)
    const failOn = String(values["fail-on"]) as Severity | "none"
    if (!["error", "warning", "info", "none"].includes(failOn)) throw new UsageError("--fail-on must be error, warning, info or none")

    const cwd = resolve(io.cwd, String(values.cwd ?? "."))
    const config = await loadConfig(cwd, values.config as string | undefined)
    const ctx: RunContext = {
      cwd,
      config: (config.data[tool.name] as Record<string, unknown>) ?? {},
      options: values,
      positionals: parsed.positionals,
      log: values.quiet || format !== "text" ? () => {} : (m) => io.stderr(c.gray(m) + "\n"),
      env: io.env,
      fetch: io.fetch,
    }
    const result = await command.run(ctx)
    applyIgnores(result, config.data[tool.name]?.ignore ?? config.data.ignore)
    emit(result.raw !== undefined && format === "text" ? result.raw + "\n" : render(result, format), values.output as string | undefined, io, cwd)
    return shouldFail(result.findings, failOn) ? 1 : 0
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${c.red("error")} ${err.message}\n`)
      return 2
    }
    io.stderr(`${c.red("error")} ${(err as Error).stack ?? err}\n`)
    return 2
  }
}

/** Drops findings whose rule (or rule:file) is listed under "ignore" in the config. */
export function applyIgnores(result: ToolResult, ignore: unknown) {
  if (!Array.isArray(ignore) || !ignore.length) return
  const list = ignore.map(String)
  result.findings = result.findings.filter((f) => !list.some((i) => i === f.rule || (f.file && (i === `${f.rule}:${f.file}` || i === f.file))))
}

function emit(text: string, output: string | undefined, io: IO, cwd: string) {
  if (output) {
    const path = resolve(cwd, output)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    io.stderr(c.gray(`Report written to ${output}\n`))
  } else io.stdout(text)
}

/** `devdoctor check`: every static tool that applies, one combined report and exit code. */
async function runSuite(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { format: { type: "string", short: "f", default: "text" }, output: { type: "string", short: "o" }, "fail-on": { type: "string", default: "error" }, config: { type: "string", short: "c" }, "no-color": { type: "boolean" }, quiet: { type: "boolean", short: "q" }, help: { type: "boolean", short: "h" } } })
  if (values.help) {
    io.stdout(`${c.bold("devdoctor check")} [dir]\n\nRuns ${CHECK_SUITE.map((s) => s.tool).join(", ")} where they apply, and exits 1 if any reports a problem at --fail-on severity.\n\n${optionHelp(Object.fromEntries(["format", "output", "fail-on", "config", "no-color", "quiet"].map((k) => [k, COMMON[k]!])))}\n`)
    return 0
  }
  const format = values.format as Format
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of: ${FORMATS.join(", ")}`)
  if (values["no-color"] || format !== "text" || values.output) setColor(false)
  const cwd = resolve(io.cwd, positionals[0] ?? ".")
  const config = await loadConfig(cwd, values.config)
  const log = values.quiet || format !== "text" ? () => {} : (m: string) => io.stderr(c.gray(m) + "\n")
  const results: ToolResult[] = []
  for (const s of CHECK_SUITE) {
    if (!(await s.applies(cwd))) {
      log(`skip ${s.tool}: ${s.reason}`)
      continue
    }
    log(`running ${s.tool}…`)
    const tool = TOOLS[s.tool]!
    const command: Command = tool.commands[s.command]!
    const r = await command.run({ cwd, config: config.data[s.tool] ?? {}, options: { ...(s.options ?? {}) }, positionals: s.positionals ?? [], log: () => {}, env: io.env, fetch: io.fetch })
    applyIgnores(r, config.data[s.tool]?.ignore ?? config.data.ignore)
    results.push(r)
  }
  let text: string
  if (format === "sarif") text = renderSarif(results)
  else if (format === "json") text = JSON.stringify({ results: results.map((r) => ({ ...r, counts: counts(r.findings) })) }, null, 2) + "\n"
  else text = results.map((r) => render(r, format)).join(format === "markdown" ? "\n" : "\n" + c.gray("─".repeat(60)) + "\n\n")
  emit(text, values.output, io, cwd)
  return results.some((r) => shouldFail(r.findings, values["fail-on"] as Severity | "none")) ? 1 : 0
}
