import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { getContext } from "hono/context-storage"
import { HTTPException } from "hono/http-exception"
import type { RequestIdVariables } from "hono/request-id"
import { applyBaseMiddleware } from "./base-middleware.ts"

interface APIContext {
  Variables: RequestIdVariables
}

function app() {
  const app = new Hono<APIContext>().basePath("/api")
  applyBaseMiddleware(app, { write: () => {} })
  app.get("/id", (c) => c.text(c.get("requestId")))
  return app
}

describe("the request id of an API call", () => {
  it("keeps an X-Request-Id of 128 characters whole", async () => {
    const id = "r".repeat(128)

    const response = await app().request("/api/id", { headers: { "X-Request-Id": id } })

    expect(await response.text()).toBe(id)
  })

  it("replaces an X-Request-Id of 129 characters, so it fits the audit column", async () => {
    const response = await app().request("/api/id", {
      headers: { "X-Request-Id": "r".repeat(129) },
    })

    const id = await response.text()
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(128)
  })
})

describe("the request id's options", () => {
  it("generates an 8-character URL-safe id when the caller sends none", async () => {
    const id = await (await app().request("/api/id")).text()

    expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/)
  })

  it("applies a request id cap the caller sets", async () => {
    const capped = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(capped, { write: () => {}, requestIdMaxLength: 10 })
    capped.get("/id", (c) => c.text(c.get("requestId")))

    const kept =
      await (await capped.request("/api/id", { headers: { "X-Request-Id": "r".repeat(10) } }))
        .text()
    const replaced = await (await capped.request("/api/id", {
      headers: { "X-Request-Id": "r".repeat(11) },
    })).text()

    expect(kept).toBe("r".repeat(10))
    expect(replaced).not.toBe("r".repeat(11))
    expect(replaced.length).toBeLessThanOrEqual(10)
  })
})

describe("the request id's limits", () => {
  it("replaces an X-Request-Id with a forbidden character by a generated id", async () => {
    const response = await app().request("/api/id", { headers: { "X-Request-Id": "a b" } })

    const id = await response.text()
    expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/)
    expect(response.headers.get("X-Request-Id")).toBe(id)
  })

  it("refuses a requestIdMaxLength that is not an integer of at least 8", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 7, 0, -1, 8.5]) {
      const target = new Hono<APIContext>()
      expect(
        () => applyBaseMiddleware(target, { write: () => {}, requestIdMaxLength: bad }),
        String(bad),
      ).toThrow(RangeError)
    }
  })

  it("accepts a requestIdMaxLength of exactly 8", () => {
    const target = new Hono<APIContext>()

    applyBaseMiddleware(target, { write: () => {}, requestIdMaxLength: 8 })
  })
})

describe("the rest of the base middleware", () => {
  it("runs parseAuth after the request id is set, before the route", async () => {
    const seen: string[] = []
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: () => {},
      parseAuth: async (c, next) => {
        seen.push(`auth:${c.get("requestId")}`)
        await next()
      },
    })
    app.get("/x", (c) => {
      seen.push("route")
      return c.text("ok")
    })

    await app.request("/api/x", { headers: { "X-Request-Id": "req-9" } })

    expect(seen).toEqual(["auth:req-9", "route"])
  })

  it("logs each request but leaves out the paths it is told to skip", async () => {
    const lines: string[] = []
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: (...data) => lines.push(String(data[0])),
      skipLogPaths: ["/api/health"],
    })
    app.get("/health", (c) => c.text("ok"))
    app.get("/x", (c) => c.text("ok"))

    await app.request("/api/health")
    await app.request("/api/x")

    expect(lines.some((l) => l.includes("/api/x"))).toBe(true)
    expect(lines.some((l) => l.includes("/api/health"))).toBe(false)
  })

  it("answers a plain 500 for an unhandled exception even with no reportError", async () => {
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, { write: () => {} })
    app.get("/boom", () => {
      throw new Error("x")
    })

    const response = await app.request("/api/boom")

    expect(response.status).toBe(500)
    expect(await response.text()).toBe("Internal Server Error")
  })
})

describe("an unhandled exception in an API route", () => {
  function failing(reported: { error: unknown; context: unknown }[], logged: unknown[][] = []) {
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: (...data) => logged.push(data),
      reportError: (error, context) => reported.push({ error, context }),
    })
    app.post("/boom", () => {
      throw new Error("db exploded")
    })
    app.get("/teapot", () => {
      throw new HTTPException(418, { message: "teapot" })
    })
    app.get("/unavailable", () => {
      throw new HTTPException(503, { message: "later" })
    })
    return app
  }

  it("answers 500 and reports it with the request id, method and path only", async () => {
    const reported: { error: unknown; context: unknown }[] = []
    const logged: unknown[][] = []

    const response = await failing(reported, logged).request("/api/boom?token=SECRET", {
      method: "POST",
      headers: { "X-Request-Id": "req-1", Cookie: "sid=COOKIE", Authorization: "Bearer BEARER" },
      body: JSON.stringify({ password: "BODYSECRET" }),
    })

    expect(response.status).toBe(500)
    const failures = logged.filter((l) => String(l[0]).startsWith("error: unhandled"))
    expect(failures).toHaveLength(1)
    expect(failures[0][0]).toBe("error: unhandled exception on POST /api/boom")
    expect((failures[0][1] as Error).message).toBe("db exploded")
    expect(reported).toHaveLength(1)
    expect((reported[0].error as Error).message).toBe("db exploded")
    expect(reported[0].context).toEqual({
      tags: { request_id: "req-1" },
      request: { method: "POST", path: "/api/boom" },
    })
    const serialised = JSON.stringify(reported[0].context)
    for (const secret of ["SECRET", "COOKIE", "BEARER", "BODYSECRET"]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it("does not report an HTTPException below 500 but answers it as before", async () => {
    const reported: { error: unknown; context: unknown }[] = []

    const response = await failing(reported).request("/api/teapot")

    expect(response.status).toBe(418)
    expect(reported).toEqual([])
  })

  it("reports an HTTPException of 500 or more and keeps its status", async () => {
    const reported: { error: unknown; context: unknown }[] = []

    const response = await failing(reported).request("/api/unavailable")

    expect(response.status).toBe(503)
    expect(reported).toHaveLength(1)
  })

  it("keeps a route's own 500 answer when reporting itself throws", async () => {
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: () => {},
      reportError: () => {
        throw new Error("tracker library broke")
      },
    })
    const notes = new Hono<APIContext>()
      .get("/", () => {
        throw new Error("x")
      })
      .onError((_error, c) => c.json({ error: { code: "INTERNAL_ERROR" } }, 500))
    app.route("/notes", notes)

    const response = await app.request("/api/notes")

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } })
  })

  it("reports and logs once an error a route's own onError answered, and keeps that answer", async () => {
    const reported: { error: unknown; context: unknown }[] = []
    const logged: unknown[][] = []
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: (...data) => logged.push(data),
      reportError: (error, context) => reported.push({ error, context }),
    })
    const notes = new Hono<APIContext>()
      .get("/", () => {
        throw new Error("db down")
      })
      .onError((_error, c) => c.json({ error: { code: "INTERNAL_ERROR" } }, 500))
    app.route("/notes", notes)

    const response = await app.request("/api/notes", { headers: { "X-Request-Id": "req-7" } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } })
    expect(reported).toHaveLength(1)
    expect((reported[0].error as Error).message).toBe("db down")
    expect(reported[0].context).toEqual({
      tags: { request_id: "req-7" },
      request: { method: "GET", path: "/api/notes" },
    })
    expect(logged.filter((l) => String(l[0]).startsWith("error: unhandled"))).toHaveLength(1)
  })
})

describe("the middleware's wiring", () => {
  it("makes the request context reachable from code a route calls", async () => {
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, { write: () => {} })
    const deepInTheCode = () => getContext<APIContext>().get("requestId")
    app.get("/x", (c) => c.text(deepInTheCode()))

    const response = await app.request("/api/x", { headers: { "X-Request-Id": "req-3" } })

    expect(await response.text()).toBe("req-3")
  })

  it("writes the response line of the request log before the unhandled-exception line", async () => {
    const lines: string[] = []
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, { write: (...data) => lines.push(String(data[0])) })
    app.get("/boom", () => {
      throw new Error("x")
    })

    await app.request("/api/boom")

    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("500")
    expect(lines[2]).toBe("error: unhandled exception on GET /api/boom")
  })

  it("answers 500 without an unhandled rejection when an async reporter rejects", async () => {
    const app = new Hono<APIContext>().basePath("/api")
    applyBaseMiddleware(app, {
      write: () => {},
      reportError: () => Promise.reject(new Error("tracker down")),
    })
    app.get("/boom", () => {
      throw new Error("x")
    })

    const response = await app.request("/api/boom")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(response.status).toBe(500)
  })
})
