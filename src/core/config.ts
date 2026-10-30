import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { exists, readJson } from "./fs.js"
import { UsageError } from "./types.js"

export const CONFIG_FILES = ["devdoctor.config.json", "devdoctor.config.ts", "devdoctor.config.mjs", "devdoctor.config.js", ".devdoctorrc.json"]

export type LoadedConfig = { path: string | null; data: Record<string, any> }

/**
 * Finds the config: an explicit --config path, one of CONFIG_FILES, or a "devdoctor" key in
 * package.json. Each tool reads its own section, e.g. { "archwatch": { "rules": [...] } }.
 */
export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const candidates = explicit ? [explicit] : CONFIG_FILES
  for (const name of candidates) {
    const path = join(cwd, name)
    if (!exists(path)) {
      if (explicit) throw new UsageError(`Config file not found: ${explicit}`)
      continue
    }
    if (path.endsWith(".json")) {
      const data = readJson(path)
      if (!data || typeof data !== "object") throw new UsageError(`${name} isn't valid JSON`)
      return { path, data }
    }
    const mod = await importModule(path)
    const data = mod?.default ?? mod
    if (!data || typeof data !== "object") throw new UsageError(`${name} must export a config object`)
    return { path, data }
  }
  const pkg = readJson(join(cwd, "package.json"))
  if (pkg?.devdoctor && typeof pkg.devdoctor === "object") return { path: join(cwd, "package.json"), data: pkg.devdoctor }
  return { path: null, data: {} }
}

/** Loads a JS or TS module from the user's project (TS via jiti, using their own dependencies). */
export async function importModule(path: string): Promise<any> {
  if (/\.(ts|mts|cts|tsx)$/.test(path)) {
    const { createJiti } = await import("jiti")
    const jiti = createJiti(pathToFileURL(path).href, { interopDefault: false })
    return jiti.import(path)
  }
  return import(pathToFileURL(path).href)
}
