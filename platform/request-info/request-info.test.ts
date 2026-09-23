import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { Hono } from "hono"

import {
  type RequestInfo,
  requestInfoFromContext,
  type RequestInfoOptions,
} from "./request-info.ts"

/** One route that reports whatever `requestInfoFromContext` builds, as JSON. */
function buildApp(options?: RequestInfoOptions, setRequestId?: string): Hono {
  const app = new Hono()
  if (setRequestId !== undefined) {
    app.use(async (c, next) => {
      c.set("requestId" as never, setRequestId as never)
      await next()
    })
  }
  app.get("/x", (c) => c.json(requestInfoFromContext(c, options)))
  return app
}

async function call(app: Hono, headers: Record<string, string> = {}): Promise<RequestInfo> {
  const response = await app.request(new Request("http://localhost/x", { headers }))
  return await response.json()
}

describe("requestInfoFromContext — trust boundary", () => {
  it("ignores X-Forwarded-For by default (untrusted), falling back to clientIp's placeholder", async () => {
    const info = await call(buildApp(), { "x-forwarded-for": "203.0.113.9" })
    expect(info.ip).toBe("0.0.0.0")
  })

  it("ignores a forged X-Forwarded-For even when a remoteAddr is also given", async () => {
    const info = await call(buildApp({ remoteAddr: "192.0.2.1" }), {
      "x-forwarded-for": "203.0.113.9",
    })
    expect(info.ip).toBe("192.0.2.1")
  })

  it("reads X-Forwarded-For when the caller opts into trustedProxy", async () => {
    const info = await call(buildApp({ trustedProxy: true }), {
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    })
    expect(info.ip).toBe("203.0.113.9")
  })

  it("falls back to remoteAddr when trusted but no forwarding header is present", async () => {
    const info = await call(buildApp({ trustedProxy: true, remoteAddr: "192.0.2.1" }))
    expect(info.ip).toBe("192.0.2.1")
  })
})

describe("requestInfoFromContext — requestId and userAgent", () => {
  it("reads requestId from the context variable when the app set one", async () => {
    const info = await call(buildApp(undefined, "req-1"))
    expect(info.requestId).toBe("req-1")
  })

  it("leaves requestId undefined when nothing set it", async () => {
    const info = await call(buildApp())
    expect(info.requestId).toBeUndefined()
  })

  it("reads the user-agent header", async () => {
    const info = await call(buildApp(), { "user-agent": "test-agent/1.0" })
    expect(info.userAgent).toBe("test-agent/1.0")
  })

  it("leaves userAgent undefined when the header is absent", async () => {
    const info = await call(buildApp())
    expect(info.userAgent).toBeUndefined()
  })
})
