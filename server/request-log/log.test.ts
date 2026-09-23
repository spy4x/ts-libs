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
  it("logs one incoming and one outgoing line for a request", async () => {
    const { app, lines } = appWithLog()

    await app.request("/users")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("--> GET /users")
    expect(lines[1].startsWith("<-- GET /users")).toBe(true)
    expect(lines[1]).toContain("200")
    expect(lines[1]).toMatch(/\dm?s$/)
  })

  it("reports the response status the handler actually returned", async () => {
    const { app, lines } = appWithLog()

    await app.request("/boom")

    expect(lines[1]).toContain("500")
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
