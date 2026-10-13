import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { Hono } from "hono"
import { requestLog } from "./log.ts"

function appWithLog(options: Parameters<typeof requestLog>[0] = {}) {
  const lines: string[] = []
  const app = new Hono()
  app.use(requestLog({ ...options, write: (line) => lines.push(line) }))
  app.get("/users", (c) => c.text("ok"))
  app.get("/boom", (c) => c.text("nope", 500))
  return { app, lines }
}

describe("requestLog", () => {
  it("logs incoming then outgoing, in the source's own arrow direction", async () => {
    const { app, lines } = appWithLog()

    await app.request("/users")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("<-- GET /users")
    expect(lines[1].startsWith("--> GET /users")).toBe(true)
    expect(lines[1]).toContain("200")
    expect(lines[1]).toMatch(/\dm?s$/)
  })

  it("writes a path with an encoded line break as one line each way, the break escaped", async () => {
    const lines: string[] = []
    const app = new Hono()
    app.use(requestLog({ write: (line) => lines.push(line) }))
    app.get("/api/:id", (c) => c.text("ok"))

    await app.request("/api/x%0Afake%20line")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(String.raw`<-- GET /api/x\nfake line`)
    expect(lines[1].startsWith(String.raw`--> GET /api/x\nfake line `)).toBe(true)
  })

  it("escapes every other control character of a path, the escape character included", async () => {
    const lines: string[] = []
    const app = new Hono()
    app.use(requestLog({ write: (line) => lines.push(line) }))
    app.get("/api/:id", (c) => c.text("ok"))

    await app.request("/api/a%0Db%09c%1B%5B2Jd%00e%7Ff%C2%85g%E2%80%A8h%E2%80%A9i")

    expect(lines[0]).toBe(
      String.raw`<-- GET /api/a\rb\tc\x1b[2Jd\x00e\x7ff\x85g\u2028h\u2029i`,
    )
  })

  it("reports the response status the handler actually returned", async () => {
    const { app, lines } = appWithLog()

    await app.request("/boom")

    expect(lines[1]).toContain("500")
  })

  it("logs status 0 without throwing when a handler returns Response.error()", async () => {
    const lines: string[] = []
    const app = new Hono()
    app.use(requestLog({ write: (line) => lines.push(line) }))
    app.get("/err", () => Response.error())

    await app.request("/err")

    expect(lines[1]).toContain("0")
  })

  it("logs a status outside every real HTTP class without throwing", async () => {
    const lines: string[] = []
    const app = new Hono()
    app.use(requestLog({ write: (line) => lines.push(line) }))
    // A handler that bypasses Hono's own return type and hands back an object that merely looks
    // like a Response — c.res.status is read as a plain property, so this reaches the logger too.
    app.get("/odd", () => ({ status: 700 }) as unknown as Response)

    await app.request("/odd")

    expect(lines[1]).toContain("700")
  })

  it("never logs the query string", async () => {
    const { app, lines } = appWithLog()

    await app.request("/users?token=super-secret-value")

    for (const line of lines) {
      expect(line).not.toContain("super-secret-value")
      expect(line).not.toContain("?")
    }
  })

  it("does not read or log any request header", async () => {
    const { app, lines } = appWithLog()

    await app.request("/users", { headers: { Authorization: "Bearer super-secret-token" } })

    for (const line of lines) {
      expect(line).not.toContain("super-secret-token")
    }
  })

  it("skips a configured path entirely, logging nothing", async () => {
    const { app, lines } = appWithLog({ skipPaths: ["/users"] })

    const response = await app.request("/users")

    expect(await response.text()).toBe("ok")
    expect(lines).toHaveLength(0)
  })

  it("still serves a request when no write function is given", async () => {
    const app = new Hono()
    app.use(requestLog())
    app.get("/users", (c) => c.text("ok"))

    const response = await app.request("/users")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })
})
