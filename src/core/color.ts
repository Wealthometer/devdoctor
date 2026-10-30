/** Minimal ANSI styling. Disabled for non-TTY output, NO_COLOR, or --no-color. */
let enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb"

export function setColor(on: boolean) {
  enabled = on
}

const wrap = (open: number, close: number) => (s: string | number) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
}

/** Visible width, ignoring ANSI codes. */
export const width = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length
