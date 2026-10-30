import { Readable } from "node:stream"
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { analyzeLogs, findBursts, normalizeMessage, parseLine, parseSince, topFrame } from "../src/tools/loglens.js"
import { cli, fixture } from "./helpers.js"

const src = (text: string, path = "app.log") => ({ path, stream: Readable.from([text]) })

describe("parsing", () => {
  it("reads JSON loggers (pino, winston, ECS)", () => {
    expect(parseLine('{"level":50,"time":1714557600000,"msg":"db down","err":{"type":"Error","message":"connect ECONNREFUSED","stack":"Error: connect ECONNREFUSED\\n    at TCP.onConnect (node:net:1)"}}')).toMatchObject({ level: "error", message: "db down", errorType: "Error", stack: ["at TCP.onConnect (node:net:1)"] })
    expect(parseLine('{"level":"warn","message":"slow query","timestamp":"2024-05-01T10:00:00Z"}')).toMatchObject({ level: "warn", message: "slow query" })
    expect(parseLine('{"@timestamp":"2024-05-01T10:00:00Z","log":{"level":"error"},"message":"boom"}')!.level).toBe("error")
  })

  it("reads common text formats", () => {
    expect(parseLine("2024-05-01T10:00:00.123Z ERROR Payment failed for order 123")).toMatchObject({ level: "error", message: "Payment failed for order 123" })
    expect(parseLine("[2024-05-01 10:00:00] WARNING: disk at 91%")!.level).toBe("warn")
    expect(parseLine("2024-05-01 10:00:00,123 - app.db - ERROR - connection lost")).toMatchObject({ level: "error", message: "connection lost" })
    expect(parseLine("2024-05-01 10:00:00.123 ERROR [main] com.acme.Service - NullPointerException: x")).toMatchObject({ level: "error", errorType: "NullPointerException" })
    expect(parseLine('10.0.0.1 - - [01/May/2024:10:00:00 +0000] "GET /api/x HTTP/1.1" 502 12')).toMatchObject({ level: "error", message: "GET /api/x → 502" })
    expect(parseLine("May  1 10:00:00 web1 nginx[123]: upstream timed out")!.message).toBe("upstream timed out")
    expect(parseLine("    at foo (/app/src/x.ts:1:2)")).toBeNull()
  })

  it("reads logfmt, NestJS and coloured dev-server output", () => {
    expect(parseLine('time="2024-05-01T10:00:00Z" level=error msg="pull failed" error="no such host" image=node')).toMatchObject({ level: "error", message: "pull failed: no such host", fields: { image: "node" } })
    expect(parseLine("\x1b[31m[Nest] 4112  - \x1b[39m10/29/2026, 10:46:21 PM \x1b[31m  ERROR\x1b[39m \x1b[38;5;3m[ExceptionsHandler] \x1b[39mconnect ECONNREFUSED\x1b[38;5;3m +3ms\x1b[39m")).toMatchObject({ level: "error", message: "connect ECONNREFUSED", fields: { context: "ExceptionsHandler" } })
    expect(parseLine("10:39:48 PM [vite] ws proxy error:")!.message).toBe("[vite] ws proxy error:")
  })

  it("joins 'something failed:' with the exception on the next line", async () => {
    const a = await analyzeLogs([src("10:00:01 PM [vite] proxy error:\nError: read ECONNRESET\n    at TCP.onStreamRead (node:internal/x:1:1)\n10:00:02 PM [vite] proxy error:\nError: read ECONNRESET\n")])
    expect(a.groups).toHaveLength(1)
    expect(a.groups[0]).toMatchObject({ count: 2, errorType: "Error", example: "[vite] proxy error: Error: read ECONNRESET" })
  })

  it("normalises variable parts so repeats group together", () => {
    expect(normalizeMessage("User 42 (ada@x.io) failed at 2024-05-01T10:00:00Z from 10.0.0.1: \"bad token\" id=7f3e9a1c-1b2d-4e5f-8a9b-0c1d2e3f4a5b"))
      .toBe("User <n> (<email>) failed at <time> from <ip>: <str> id=<uuid>")
    expect(topFrame(["at Object.<anonymous> (node_modules/x/index.js:1:1)", "at charge (/app/src/pay.ts:42:7)"])).toBe("charge (/app/src/pay.ts)")
    expect(parseSince("2h", Date.parse("2024-05-01T12:00:00Z")).toISOString()).toBe("2024-05-01T10:00:00.000Z")
  })
})

describe("analysis", () => {
  const log = [
    "2024-05-01T10:00:00Z INFO server started",
    "2024-05-01T10:01:00Z ERROR TypeError: Cannot read properties of undefined (reading 'id')",
    "    at getUser (/app/src/users.ts:10:5)",
    "    at handler (/app/src/routes.ts:3:1)",
    "2024-05-01T10:02:00Z ERROR TypeError: Cannot read properties of undefined (reading 'name')",
    "    at getUser (/app/src/users.ts:10:5)",
    "2024-05-01T10:03:00Z WARN retrying request 3 of 5",
    "2024-05-01T10:04:00Z WARN retrying request 4 of 5",
    "2024-05-01T10:05:00Z ERROR Payment failed for order 991",
    "2024-05-01T10:06:00Z DEBUG cache hit",
  ].join("\n")

  it("groups repeated errors with their stack frame, counts levels, honours filters", async () => {
    const a = await analyzeLogs([src(log)])
    expect(a.total).toBe(7)
    expect(a.byLevel).toMatchObject({ info: 1, error: 3, warn: 2, debug: 1 })
    expect(a.groups.map((g) => [g.count, g.level, g.errorType, g.frame])).toEqual([
      [2, "error", "TypeError", "getUser (/app/src/users.ts)"],
      [1, "error", null, null],
      [2, "warn", null, null],
    ])
    expect(a.groups[0]!.line).toBe(2)
    const onlyErrors = await analyzeLogs([src(log)], { minLevel: "error", since: new Date("2024-05-01T10:04:30Z") })
    expect(onlyErrors.groups.map((g) => g.example)).toEqual(["Payment failed for order 991"])
    const grep = await analyzeLogs([src(log)], { grep: /users\.ts/ })
    expect(grep.matched).toBe(2)
  })

  it("finds bursts", () => {
    const m = new Map<number, number>([[1, 1], [2, 1], [3, 2], [4, 1], [5, 30]])
    expect(findBursts(m)).toEqual([{ minute: 5, count: 30, typical: 1 }])
  })

  it("works end to end on files, folders and gzip, with CSV export", async () => {
    const dir = fixture({ "logs/app.log": log, "logs/old.log.gz": "" })
    const { writeFileSync, readFileSync } = await import("node:fs")
    writeFileSync(`${dir}/logs/old.log.gz`, gzipSync('{"level":"error","msg":"Payment failed for order 12","time":"2024-04-30T09:00:00Z"}\n'))
    const r = await cli("loglens", ["analyze", "logs", "--csv", "groups.csv", "-f", "json"], dir)
    const out = r.json()
    expect(out.summary).toMatchObject({ entries: 8, errors: 4, warnings: 2 })
    const payment = out.findings.find((f: { message: string }) => f.message.includes("Payment failed"))
    expect(payment.message).toMatch(/^2× Payment failed for order \d+, 2024-04-30 09:00:00Z → 2024-05-01 10:05:00Z$/)
    expect(payment.rule).toBe("recurring")
    expect(r.code).toBe(1)
    expect(readFileSync(`${dir}/groups.csv`, "utf8").split("\n")[0]).toBe('"level","count","error_type","message","pattern","first_seen","last_seen","top_frame","file","line"')
    expect((await cli("loglens", ["analyze", "logs", "--level", "loud"], dir)).code).toBe(2)
    expect((await cli("loglens", ["analyze", "logs", "--fail-on", "none"], dir)).code).toBe(0)
  })
})
