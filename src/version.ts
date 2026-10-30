import { readFileSync } from "node:fs"

/** Read from package.json so the CLI and the published package can't disagree. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
  } catch {
    return "0.0.0"
  }
})()
