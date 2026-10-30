import { describe, expect, it } from "vitest"
import { checkEnv, checkValue, looksLikeRealSecret, mask, parseDotenv } from "../src/tools/envdoctor.js"
import { cli, fixture, rules } from "./helpers.js"

describe("dotenv parsing", () => {
  it("handles export, quotes, multiline values, inline comments and annotations", () => {
    const e = parseDotenv([
      "# @type url",
      "DATABASE_URL=postgres://localhost/db # main database",
      "export NAME='single # not a comment'",
      'KEY="-----BEGIN KEY-----',
      'abc',
      '-----END KEY-----"',
      "PORT=4000 # @type port",
      "",
      "# @optional",
      "SENTRY_DSN=",
      "LEVEL=info # @type debug|info|warn",
    ].join("\n"))
    const by = Object.fromEntries(e.map((x) => [x.key, x]))
    expect(by.DATABASE_URL).toMatchObject({ value: "postgres://localhost/db", line: 2, annotations: { type: "url" } })
    expect(by.NAME!.value).toBe("single # not a comment")
    expect(by.KEY!.value.split("\n")).toHaveLength(3)
    expect(by.PORT).toMatchObject({ line: 7, annotations: { type: "port" } })
    expect(by.SENTRY_DSN!.annotations).toEqual({ optional: true })
    expect(by.LEVEL!.annotations.type).toBe("debug|info|warn")
  })

  it("validates types and never reveals values", () => {
    expect(checkValue({ type: "port" }, "99999")).toMatch(/port/)
    expect(checkValue({ type: "url" }, "not a url")).toMatch(/URL/)
    expect(checkValue({ type: "boolean" }, "yes")).toBeNull()
    expect(checkValue({ enum: ["a", "b"] }, "c")).toMatch(/one of/)
    expect(checkValue({ type: "string", min: 32 }, "short")).toMatch(/32 characters/)
    expect(mask("sk_live_abcdefghijklmnop")).toBe("sk…(24 chars)")
    expect(looksLikeRealSecret("STRIPE_KEY", "sk_live_" + "a".repeat(24))).toBe("Stripe live secret key")
    expect(looksLikeRealSecret("JWT_SECRET", "change-me")).toBeNull()
    expect(looksLikeRealSecret("JWT_SECRET", "f3a9c1e07b5d24a8c6e1f9b3d7a0c5e2")).toBe("high-entropy secret")
  })
})

describe("envdoctor check", () => {
  const project = (extra: Record<string, string | object> = {}) =>
    fixture({
      ".env.example": "# @type url\nDATABASE_URL=postgres://localhost/app\n# @type port\nPORT=3000\nJWT_SECRET=\n# @optional\nSENTRY_DSN=\nLEGACY_FLAG=1\n",
      ".env": "DATABASE_URL=not-a-url\nPORT=3000\nJWT_SECRET=\nEXTRA_THING=1\n",
      "src/config.ts": "export const cfg = { db: process.env.DATABASE_URL, port: process.env['PORT'], secret: process.env.JWT_SECRET, redis: process.env.REDIS_URL, env: process.env.NODE_ENV }\nconst { SENTRY_DSN } = process.env",
      ...extra,
    })

  it("reports missing, empty, invalid, undocumented and unused variables", async () => {
    const r = await checkEnv(project())
    const by = (rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => f.message)
    expect(by("invalid")).toEqual(["DATABASE_URL in .env: expected a URL"])
    expect(by("empty")).toEqual(["JWT_SECRET is empty in .env"])
    expect(by("missing")).toEqual(["LEGACY_FLAG is missing from .env"])
    expect(by("undocumented")).toEqual(["EXTRA_THING is set in .env but not documented in .env.example"])
    expect(by("used-undocumented")).toEqual(["REDIS_URL is read by the code but not documented"])
    expect(by("unused")).toEqual(["LEGACY_FLAG is documented but never read in the code"])
    // SENTRY_DSN is optional, NODE_ENV is a platform variable: neither is reported.
    expect(JSON.stringify(r.findings)).not.toMatch(/SENTRY_DSN|NODE_ENV/)
    // No value from .env ever appears in the report.
    expect(JSON.stringify(r)).not.toContain("not-a-url")
  })

  it("flags real secrets committed in the example, masked", async () => {
    const dir = fixture({ ".env.example": "STRIPE_SECRET=sk_live_abcdefghijklmnopqrstuvwx\n" })
    const r = await checkEnv(dir)
    expect(rules(r)).toContain("secret-in-example")
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop")
  })

  it("validates with a Zod schema without leaking values", async () => {
    const dir = project({
      "src/env.ts": `import { z } from "zod"\nexport const envSchema = z.object({ DATABASE_URL: z.string().url(), PORT: z.coerce.number().int().max(1000), JWT_SECRET: z.string().min(32), SENTRY_DSN: z.string().optional(), REDIS_URL: z.string().default("redis://localhost") })`,
      "node_modules/zod": "",
    })
    // Use this package's own zod (the fixture has no node_modules).
    const { symlinkSync, rmSync } = await import("node:fs")
    rmSync(`${dir}/node_modules/zod`)
    symlinkSync(`${process.cwd()}/node_modules/zod`, `${dir}/node_modules/zod`)
    const r = await checkEnv(dir, { schema: "src/env.ts" })
    const schema = r.findings.filter((f) => f.rule === "schema").map((f) => f.message)
    expect(schema.some((m) => m.startsWith("DATABASE_URL in .env:"))).toBe(true)
    expect(schema.some((m) => m.startsWith("PORT in .env:"))).toBe(true)
    // REDIS_URL has a default in the schema → documented and not required.
    expect(rules(r)).not.toContain("used-undocumented")
    expect(r.findings.some((f) => f.message.includes("REDIS_URL is missing"))).toBe(false)
    expect(JSON.stringify(r)).not.toContain("not-a-url")
  })

  it("checks the live environment with --process", async () => {
    const dir = fixture({ ".env.example": "# @type port\nPORT=3000\nAPI_URL=\n" })
    const r = await cli("envdoctor", ["check", "--process", "--no-code", "-f", "json"], dir, { env: { PORT: "http" } })
    expect(r.code).toBe(1)
    const msgs = r.json().findings.map((f: { message: string }) => f.message)
    expect(msgs).toContain("PORT in the environment: expected a port (1–65535)")
    expect(msgs).toContain("API_URL is missing from the environment")
  })

  it("compares docker-compose and CI with the documented variables", async () => {
    const dir = project({
      ".env": "DATABASE_URL=postgres://x/y\nPORT=1\nJWT_SECRET=x\nLEGACY_FLAG=1\nREDIS_URL=r\n",
      "docker-compose.yml": "services:\n  app:\n    build: .\n    environment:\n      DATABASE_URL: postgres://db/app\n      DEBUG_MODE: '1'\n  db:\n    image: postgres:16\n",
      ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm test\n        env:\n          REDIS_URL: ${{ secrets.REDIS_URL }}\n",
    })
    const r = await checkEnv(dir)
    const msgs = r.findings.map((f) => `${f.rule}: ${f.message}`)
    expect(msgs).toContain('compose-missing: docker-compose.yml: service "app" doesn\'t set JWT_SECRET, which has no default')
    expect(msgs).toContain('compose-undocumented: docker-compose.yml: "app" sets DEBUG_MODE, which isn\'t documented in .env.example')
    expect(msgs.some((m) => m.startsWith("ci-undocumented:") && m.includes("REDIS_URL"))).toBe(true)
    // Variables with a usable default in the example (PORT=3000) don't need to be set by compose.
    expect(msgs.some((m) => m.includes("doesn't set PORT"))).toBe(false)
  })
})
