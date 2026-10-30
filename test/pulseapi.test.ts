import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assert, getPath, interpolate } from "../src/tools/pulseapi/engine.js"
import { cli, fixture } from "./helpers.js"

let server: Server
let base: string
const users = new Map<string, { id: string; email: string; name: string }>()

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers })
        res.end(JSON.stringify(data))
      }
      if (req.url === "/health") return send(200, { ok: true })
      if (req.url === "/slow") return setTimeout(() => send(200, { ok: true }), 300)
      if (req.url === "/users" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer secret-token") return send(401, { error: "unauthorized" })
        const input = JSON.parse(body)
        const u = { id: String(users.size + 1), email: input.email, name: input.name }
        users.set(u.id, u)
        return send(201, u, { etag: `"u${u.id}"` })
      }
      const m = req.url!.match(/^\/users\/(\w+)$/)
      if (m) return users.has(m[1]!) ? send(200, users.get(m[1]!)) : send(404, { error: "not found" })
      if (req.url!.startsWith("/search")) return send(200, { q: new URL(req.url!, "http://x").searchParams.get("q"), items: [1, 2, 3] })
      send(404, { error: "nope" })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => server.close(r)))

describe("engine pieces", () => {
  it("interpolates variables, env and dynamic values, keeping types for whole placeholders", () => {
    const out = interpolate({ url: "{{base}}/users/{{id}}", n: "{{count}}", nested: { t: "Bearer {{$env.TOKEN}}" }, u: "{{$uuid}}" }, { base: "http://x", id: 7, count: 3 }, { TOKEN: "abc" })
    expect(out).toMatchObject({ url: "http://x/users/7", n: 3, nested: { t: "Bearer abc" } })
    expect(out.u).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => interpolate("{{missing}}", {}, {})).toThrow("Unknown variable {{missing}}")
    expect(() => interpolate("{{$env.NOPE}}", {}, {})).toThrow("NOPE is not set")
  })

  it("reads JSON paths and evaluates assertions", () => {
    const doc = { a: { b: [{ c: "x" }], "d e": 1 }, items: [1, 2] }
    expect(getPath(doc, "$.a.b[0].c")).toEqual({ found: true, value: "x" })
    expect(getPath(doc, '$.a["d e"]')).toEqual({ found: true, value: 1 })
    expect(getPath(doc, "$.items.length")).toEqual({ found: true, value: 2 })
    expect(getPath(doc, "$.nope").found).toBe(false)
    expect(assert(5, { gt: 3, lte: 5 })).toBeNull()
    expect(assert("abc", "/^a/")).toBeNull()
    expect(assert([1, 2], { length: 2, contains: 2 })).toBeNull()
    expect(assert("x", { type: "number" })).toBe("expected type number, got string")
    expect(assert(undefined, { exists: true }, false)).toBe("expected it to exist")
    expect(assert("b", { oneOf: ["a", "c"] })).toMatch(/one of/)
  })
})

describe("pulseapi run", () => {
  const suite = () =>
    fixture({
      "devdoctor.config.json": { pulseapi: { environments: { local: { baseUrl: base } } } },
      "api-tests/schemas/user.json": JSON.stringify({ type: "object", required: ["id", "email"], properties: { id: { type: "string" }, email: { type: "string", format: "email" } } }),
      "api-tests/users.yaml": `
name: Users
baseUrl: "{{baseUrl}}"
requests:
  - name: Health
    url: /health
    expect: { status: 200, maxDuration: 2000, json: { $.ok: true } }
  - name: Create
    method: POST
    url: /users
    headers: { Authorization: "Bearer {{$env.API_TOKEN}}" }
    json: { email: "{{$randomEmail}}", name: "Ada" }
    expect:
      status: 201
      headers: { content-type: /json/, etag: { exists: true } }
      json: { $.name: Ada, $.email: { matches: "@example.com$" } }
      schema: ./schemas/user.json
    capture: { userId: $.id, etag: header.etag }
  - name: Fetch
    url: /users/{{userId}}
    expect: { status: 200, json: { $.id: "{{userId}}" } }
  - name: Search
    url: /search
    query: { q: "{{etag}}" }
    expect: { json: { $.items.length: 3, $.q: '"u1"' } }
  - name: Skipped
    url: /nowhere
    skip: true
`,
    })

  it("runs chained requests with environments, captures, schema and header checks", async () => {
    const r = await cli("pulseapi", ["run", "--env", "local", "-f", "json"], suite(), { env: { API_TOKEN: "secret-token" } })
    const out = r.json()
    expect(out.findings).toEqual([])
    expect(out.summary).toMatchObject({ passed: 4, failed: 0, skipped: 1, suites: 1 })
    expect(r.code).toBe(0)
  })

  it("reports failing assertions with the reason and the suite line, and writes JUnit", async () => {
    const dir = fixture({
      "t/bad.yaml": `baseUrl: ${base}\nrequests:\n  - name: Wrong status\n    url: /users/999\n    expect: { status: 200 }\n  - name: Too slow\n    url: /slow\n    expect: { maxDuration: 50 }\n  - name: Bad field\n    url: /health\n    expect: { json: { $.ok: false, $.missing: { exists: true } } }\n  - name: Refused\n    url: http://127.0.0.1:59999/x\n`,
    })
    const r = await cli("pulseapi", ["run", "t", "--junit", "out/junit.xml", "-f", "json"], dir)
    expect(r.code).toBe(1)
    const msgs = r.json().findings.map((f: { message: string; line: number }) => `${f.line}: ${f.message}`)
    expect(msgs[0]).toMatch(/^3: bad\.yaml › Wrong status: status 200 \(got 404: \{"error":"not found"\}\)/)
    expect(msgs[1]).toMatch(/^6: .*Too slow: under 50 ms \(took \d+ ms\)/)
    expect(msgs[2]).toContain("$.ok (expected false, got true), $.missing (expected it to exist)")
    expect(msgs[3]).toMatch(/Refused: .*(ECONNREFUSED|fetch failed)/)
    const xml = readFileSync(`${dir}/out/junit.xml`, "utf8")
    expect(xml).toContain('<testsuite name="bad.yaml" tests="4" failures="4"')
  })

  it("--var overrides and --bail stops a suite at the first failure", async () => {
    const dir = fixture({ "t/s.yaml": `requests:\n  - url: "{{baseUrl}}/users/1"\n    expect: { status: 418 }\n  - url: "{{baseUrl}}/health"\n` })
    const r = await cli("pulseapi", ["run", "t", "--var", `baseUrl=${base}`, "--bail", "-f", "json"], dir)
    expect(r.json().summary).toMatchObject({ passed: 0, failed: 1 })
  })

  it("send prints a single response; init scaffolds an example", async () => {
    const dir = fixture({})
    const r = await cli("pulseapi", ["send", "POST", `${base}/users`, "-H", "Authorization: Bearer secret-token", "--json", '{"email":"a@b.co","name":"Z"}', "--no-color"], dir)
    expect(r.stdout).toMatch(/^201 Created POST .* · \d+ ms/)
    expect(r.stdout).toContain('"name": "Z"')
    const bad = await cli("pulseapi", ["send", `${base}/nope`], dir)
    expect(bad.code).toBe(1)
    expect((await cli("pulseapi", ["init"], dir)).stdout).toContain("Created api-tests/users.yaml")
    expect((await cli("pulseapi", ["init"], dir)).code).toBe(2)
  })
})
