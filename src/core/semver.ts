/** The small piece of semver DepScope needs: parse, compare, and how far behind a version is. */
export type SemVer = { major: number; minor: number; patch: number; pre: string }

export function parseVersion(v: string): SemVer | null {
  const m = v.trim().replace(/^[v=^~]+/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\w.-]+))?(?:\+[\w.-]+)?$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? "" }
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return a.localeCompare(b)
  if (x.major !== y.major) return x.major - y.major
  if (x.minor !== y.minor) return x.minor - y.minor
  if (x.patch !== y.patch) return x.patch - y.patch
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre.localeCompare(y.pre, "en", { numeric: true })
}

export function behind(current: string, latest: string): "major" | "minor" | "patch" | "prerelease" | null {
  const c = parseVersion(current)
  const l = parseVersion(latest)
  if (!c || !l || compareVersions(current, latest) >= 0) return null
  if (l.major > c.major) return "major"
  if (l.minor > c.minor) return "minor"
  if (l.patch > c.patch) return "patch"
  return "prerelease"
}
