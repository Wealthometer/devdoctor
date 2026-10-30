/**
 * Glob → RegExp for POSIX relative paths. Supports `**`, `*`, `?` and `{a,b}`. Each `*` becomes a
 * capture group, so rules can compare "the same feature folder" across two paths.
 */
export function globToRegex(glob: string): RegExp {
  let re = ""
  const g = glob.replace(/^\.\//, "")
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" matches everything below.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2
        } else {
          re += ".*"
          i += 1
        }
      } else re += "([^/]*)"
    } else if (ch === "?") re += "[^/]"
    else if (ch === "{") {
      const end = g.indexOf("}", i)
      if (end === -1) re += "\\{"
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`
        i = end
      }
    } else re += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  // A directory pattern ("src/domain") also matches everything inside it.
  return new RegExp(`^${re}(?:/.*)?$`)
}

const cache = new Map<string, RegExp>()
export function globMatch(glob: string, path: string): RegExpMatchArray | null {
  let re = cache.get(glob)
  if (!re) cache.set(glob, (re = globToRegex(glob)))
  return path.match(re)
}

export const anyGlob = (globs: string | string[], path: string) => (Array.isArray(globs) ? globs : [globs]).some((g) => globMatch(g, path))
