import { join } from "node:path"
import { exists, isDir } from "../core/fs.js"
import type { ToolDef } from "../core/types.js"
import { archwatch } from "./archwatch.js"
import { commitsmith } from "./commitsmith.js"
import { depscope } from "./depscope/index.js"
import { envdoctor } from "./envdoctor.js"
import { loglens } from "./loglens.js"
import { findMigrationDirs, migraguard } from "./migraguard/index.js"
import { pulseapi } from "./pulseapi/index.js"
import { repodoctor } from "./repodoctor.js"

export const TOOLS: Record<string, ToolDef> = { repodoctor, migraguard, pulseapi, depscope, envdoctor, commitsmith, archwatch, loglens }

/** What `devdoctor check` runs, and when each applies. */
export const CHECK_SUITE: { tool: string; command: string; reason: string; applies: (cwd: string) => Promise<boolean> | boolean; options?: Record<string, string | boolean>; positionals?: string[] }[] = [
  { tool: "repodoctor", command: "scan", reason: "", applies: () => true },
  { tool: "envdoctor", command: "check", reason: "no .env, .env.example or env schema", applies: (cwd) => [".env", ".env.example", ".env.sample", ".env.template"].some((f) => exists(join(cwd, f))) },
  { tool: "migraguard", command: "check", reason: "no migrations folder", applies: async (cwd) => (await findMigrationDirs(cwd)).length > 0 },
  { tool: "depscope", command: "analyze", reason: "no package.json", applies: (cwd) => exists(join(cwd, "package.json")), options: { offline: true } },
  { tool: "archwatch", command: "check", reason: "no archwatch rules in config", applies: (cwd) => ["devdoctor.config.json", "devdoctor.config.ts", "devdoctor.config.js", "devdoctor.config.mjs", ".devdoctorrc.json"].some((f) => exists(join(cwd, f))) || isDir(join(cwd, "src")) },
  { tool: "commitsmith", command: "scan", reason: "not a git repository", applies: (cwd) => exists(join(cwd, ".git")) },
]
