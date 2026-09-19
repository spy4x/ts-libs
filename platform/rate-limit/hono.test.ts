import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"

import {
  createRateLimitMiddleware,
  decisionHeaders,
  type RejectionStatus,
  userThenIp,
} from "./hono.ts"
import { createMemoryRateLimiter, type RateLimitDecision } from "./memory.ts"

/** Fixed start instant. Nothing here reads `Date.now()` or waits. */
const T0 = 1_700_000_000_000

/** Manual clock, so the window moves only when a test moves it. */
function fakeClock(start = T0): { clock: () => number; advance: (ms: number) => void } {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/**
 * The `gb` middleware test, un-skipped.
 *
 * `gb/apps/api/services/rateLimiter.test.ts` was `describe.skip`ped. It is un-skipped here against an
 * injected clock instead of `setTimeout` + a live Redis, which is why the three cases now assert
 * exact behaviour instead of hoping one second has elapsed. PORTED FROM `gb`.
 */
describe("rate limiting (ported from gb, skip removed)", () => {
  const windowMs = 2 * 1000
  const limit = 2

  /** App under test: the middleware, a route, and an injected clock. */
  function buildApp() {
    const { clock, advance } = fakeClock()
    const limiter = createMemoryRateLimiter({ windowMs, limit, clock })
    const app = new Hono().basePath("/api")
    app.use(createRateLimitMiddleware(limiter, { keyResolver: userThenIp(() => undefined) }))
    app.get("/test", (c) => c.text("Allowed"))
    return { app, advance }
  }

  /** One request with a fixed client IP. */
  function makeRequest(app: Hono): Promise<Response> {
    return Promise.resolve(
      app.request(
        new Request("http://localhost/api/test", { headers: { "x-real-ip": "203.0.113.9" } }),
      ),
    )
  }

  it("allows requests lower than limit", async () => {
    const { app } = buildApp()
    for (let i = 0; i < limit; i++) {
      const res = await makeRequest(app)
      assertEquals(res.status, 200)
      assertEquals(await res.text(), "Allowed")
    }
  })

  it("does not allow requests above the limit", async () => {
    const { app } = buildApp()
    for (let i = 0; i < limit; i++) {
      assertEquals((await makeRequest(app)).status, 200)
    }
    const res = await makeRequest(app)
    assertEquals(res.status, 429)
    assertEquals(await res.json(), { error: "Too many requests, please try again later." })
  })

  it("resets limit after window is ended", async () => {
    const { app, advance } = buildApp()
    for (let i = 0; i < limit; i++) {
      assertEquals((await makeRequest(app)).status, 200)
    }
    advance(windowMs)
    const res = await makeRequest(app)
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "Allowed")
  })
})

describe("createRateLimitMiddleware", () => {
  /** App with a 2-per-1000 ms limiter on the given key resolver. */
  function buildApp(keyResolver = (req: Request) => req.headers.get("x-real-ip") ?? "unknown") {
    const clock = () => T0
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 2, clock })
    const app = new Hono()
    app.use(createRateLimitMiddleware(limiter, { keyResolver }))
    app.get("/auth/sign-in", (c) => c.json({ success: true }))
    return app
  }

  /** Request from `ip`. */
  function request(ip = "203.0.113.9"): Request {
    return new Request("http://localhost/auth/sign-in", { headers: { "x-real-ip": ip } })
  }

  it("emits the draft-6 RateLimit headers on an allowed response", async () => {
    const res = await buildApp().request(request())
    assertEquals(res.status, 200)
    assertEquals(res.headers.get("RateLimit-Limit"), "2")
    assertEquals(res.headers.get("RateLimit-Remaining"), "1")
    assertEquals(res.headers.get("RateLimit-Reset"), "1")
    assertEquals(res.headers.get("Retry-After"), null)
  })

  it("emits RateLimit headers plus Retry-After on a rejection", async () => {
    const app = buildApp()
    await app.request(request())
    await app.request(request())
    const res = await app.request(request())

    assertEquals(res.status, 429)
    assertEquals(res.headers.get("RateLimit-Limit"), "2")
    assertEquals(res.headers.get("RateLimit-Remaining"), "0")
    assertEquals(res.headers.get("RateLimit-Reset"), "1")
    assertEquals(res.headers.get("Retry-After"), "1")
    assertEquals(await res.json(), { error: "Too many requests, please try again later." })
  })

  it("counts each resolved key separately", async () => {
    const app = buildApp()
    await app.request(request("203.0.113.9"))
    await app.request(request("203.0.113.9"))
    assertEquals((await app.request(request("203.0.113.9"))).status, 429)
    assertEquals((await app.request(request("198.51.100.7"))).status, 200)
  })

  it("never emits a fractional or negative header value", async () => {
    const clock = () => T0 + 1
    const limiter = createMemoryRateLimiter({ windowMs: 1500, limit: 1, clock })
    const app = new Hono()
    app.use(createRateLimitMiddleware(limiter, { keyResolver: () => "k" }))
    app.get("/", (c) => c.text("ok"))

    await app.request(new Request("http://localhost/"))
    const res = await app.request(new Request("http://localhost/"))
    assertEquals(res.status, 429)
    for (
      const name of ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"]
    ) {
      const value = res.headers.get(name) ?? ""
      assertEquals(/^\d+$/.test(value), true, `${name} was ${JSON.stringify(value)}`)
      assertEquals(Number(value) >= 0, true)
    }
  })

  it("keys on the authenticated user when the resolver finds one", async () => {
    const seen: string[] = []
    const app = new Hono()
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    app.use(
      createRateLimitMiddleware(limiter, {
        keyResolver: (req) => {
          const key = `auth:${req.headers.get("x-real-ip")}`
          seen.push(key)
          return key
        },
      }),
    )
    app.get("/", (c) => c.text("ok"))

    await app.request(request("203.0.113.9"))
    await app.request(request("198.51.100.7"))
    assertEquals(seen, ["auth:203.0.113.9", "auth:198.51.100.7"])
  })

  it("prepends the configured key prefix", async () => {
    const keys: string[] = []
    const store = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(
        {
          check: (key: string) => {
            keys.push(key)
            return store.check(key)
          },
          reset: (key: string) => store.reset(key),
        },
        { keyResolver: () => "ip:203.0.113.9", keyPrefix: "chart:" },
      ),
    )
    app.get("/", (c) => c.text("ok"))

    await app.request(new Request("http://localhost/"))
    assertEquals(keys, ["chart:ip:203.0.113.9"])
  })

  it("honours a custom status and message", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        keyResolver: () => "k",
        status: 503,
        errorMessage: "slow down",
      }),
    )
    app.get("/", (c) => c.text("ok"))

    await app.request(new Request("http://localhost/"))
    const res = await app.request(new Request("http://localhost/"))
    assertEquals(res.status, 503)
    assertEquals(await res.json(), { error: "slow down" })
  })

  it("honours custom header names", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        keyResolver: () => "k",
        headers: { limit: "X-RateLimit-Limit" },
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const res = await app.request(new Request("http://localhost/"))
    assertEquals(res.headers.get("X-RateLimit-Limit"), "1")
    assertEquals(res.headers.get("RateLimit-Limit"), null)
    assertEquals(res.headers.get("RateLimit-Remaining"), "0")
  })

  it("refuses options that would silently disable the limiter", () => {
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    let message = ""
    try {
      // A JavaScript caller, or one reading a config file, can reach past the types: a 200 here
      // would deny with a success status, which is no limiter at all.
      createRateLimitMiddleware(limiter, {
        keyResolver: () => "k",
        status: 200 as unknown as RejectionStatus,
      })
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message.startsWith("invalid rate limit middleware options:"), true, message)
  })

  it("refuses a missing key resolver", () => {
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    let message = ""
    try {
      createRateLimitMiddleware(limiter, {} as never)
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message.includes("keyResolver"), true, message)
  })
})

describe("decisionHeaders", () => {
  /** Decision with every field stated explicitly. */
  function decision(overrides: Partial<RateLimitDecision> = {}): RateLimitDecision {
    return {
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
      resetAfterMs: 1000,
      limit: 2,
      ...overrides,
    }
  }

  it("reports the configured limit, not the remaining count", () => {
    const headers = decisionHeaders(decision({ remaining: 0 }))
    assertEquals(headers["RateLimit-Limit"], "2")
    assertEquals(headers["RateLimit-Remaining"], "0")
  })

  it("rounds the reset up to whole seconds", () => {
    assertEquals(decisionHeaders(decision({ resetAfterMs: 1001 }))["RateLimit-Reset"], "2")
    assertEquals(decisionHeaders(decision({ resetAfterMs: 1 }))["RateLimit-Reset"], "1")
  })

  it("omits Retry-After when the request was allowed", () => {
    assertEquals("Retry-After" in decisionHeaders(decision()), false)
  })

  it("clamps a negative remaining count to zero", () => {
    assertEquals(decisionHeaders(decision({ remaining: -3 }))["RateLimit-Remaining"], "0")
  })

  it("never emits a zero-second Retry-After", () => {
    const headers = decisionHeaders(
      decision({ allowed: false, remaining: 0, retryAfterMs: 0, resetAfterMs: 0, limit: 1 }),
    )
    assertEquals(headers["Retry-After"], "1")
  })
})
