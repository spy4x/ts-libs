import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"

import {
  createRateLimitMiddleware,
  decisionHeaders,
  type KeyResolver,
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
    app.use(createRateLimitMiddleware(limiter, {
      remoteAddr: () => "203.0.113.9",
      keyResolver: userThenIp(() => undefined),
    }))
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
  function buildApp(
    keyResolver: KeyResolver = (req: Request) => req.headers.get("x-real-ip") ?? "unknown",
  ) {
    const clock = () => T0
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 2, clock })
    const app = new Hono()
    app.use(createRateLimitMiddleware(limiter, { remoteAddr: () => undefined, keyResolver }))
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
    app.use(
      createRateLimitMiddleware(limiter, { remoteAddr: () => undefined, keyResolver: () => "k" }),
    )
    app.get("/", (c) => c.text("ok"))

    await app.request(new Request("http://localhost/"))
    const res = await app.request(new Request("http://localhost/"))
    assertEquals(res.status, 429)
    for (
      const name of ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"]
    ) {
      const value = res.headers.get(name) ?? ""
      assertEquals(/^\d+$/.test(value), true, `${name} was ${JSON.stringify(value)}`)
    }
    // A 1500 ms window would render as "1.5" if the conversion ever stopped rounding.
    assertEquals(res.headers.get("RateLimit-Reset"), "2")
    assertEquals(res.headers.get("Retry-After"), "2")
  })

  it("hands the connection's peer address to the key resolver", async () => {
    // Regression guard: `keyResolver` used to receive only a `Request`, which carries no peer
    // address, so the README's "key on the peer address instead" mitigation could not be wired at
    // all. Without this test, dropping the second argument again passes the whole suite.
    const seen: (string | undefined)[] = []
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    const app = new Hono<{ Variables: never; Bindings: { remoteAddr?: string } }>()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => "192.0.2.1",
        keyResolver: userThenIp((req, context) => {
          seen.push((context as { remoteAddr?: string }).remoteAddr)
          return req.headers.get("x-user-id") ?? undefined
        }),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const res = await app.request(
      new Request("http://localhost/", { headers: { "x-user-id": "42" } }),
    )

    assertEquals(res.status, 200)
    assertEquals(seen, ["192.0.2.1"])
  })

  it("keys two unrelated clients apart when the peer address is wired", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    // Stands in for the runtime's connection info — `Deno.serve`'s `remoteAddr`, exposed through
    // Hono's env or a `c.get` an earlier middleware set.
    let peer = "192.0.2.1"
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => peer,
        keyResolver: userThenIp(() => undefined),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const send = () => app.request(new Request("http://localhost/"))

    // Same peer, second request: one bucket, so this is the denied one.
    assertEquals((await send()).status, 200)
    assertEquals((await send()).status, 429)

    // A different peer sending no forwarding header at all is a different bucket. Keying on the
    // placeholder instead would make it inherit the first client's rejection.
    peer = "192.0.2.2"
    assertEquals((await send()).status, 200)
  })

  it("cannot be defeated by rotating X-Forwarded-For with no proxy in front", async () => {
    // The attack the reviewer constructed against the previous revision: 200 requests, a fresh
    // header value each, all allowed because every value minted its own bucket.
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 3, clock: () => T0 })
    const app = new Hono<{ Variables: never; Bindings: { remoteAddr?: string } }>()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => "192.0.2.1",
        keyResolver: userThenIp(() => undefined),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const statuses: number[] = []
    for (let i = 0; i < 200; i++) {
      const headers = {
        "x-forwarded-for": `203.0.113.${i % 250}`,
        "cf-connecting-ip": `198.51.100.${i % 250}`,
      }
      statuses.push((await app.request(new Request("http://localhost/", { headers }))).status)
    }
    assertEquals(statuses.filter((status: number) => status === 200), [200, 200, 200])
    assertEquals(statuses.filter((status: number) => status === 429).length, 197)
  })

  it("honours the forwarding header only when the caller opts in", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => undefined,
        keyResolver: userThenIp(() => undefined, { trustedProxy: true }),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const from = (ip: string) =>
      app.request(new Request("http://localhost/", { headers: { "x-forwarded-for": ip } }))
    assertEquals((await from("203.0.113.9")).status, 200)
    assertEquals((await from("203.0.113.9")).status, 429)
    assertEquals((await from("198.51.100.7")).status, 200)
  })

  it("passes a single trusted header name through to clientIp, ignoring the others", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => "127.0.0.1",
        keyResolver: userThenIp(() => undefined, { trustedProxy: "x-real-ip" }),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    // Same forged CF-Connecting-IP, two different X-Real-IP values: two buckets, because
    // "x-real-ip" is the only header read.
    const send = (realIp: string) =>
      app.request(
        new Request("http://localhost/", {
          headers: { "cf-connecting-ip": "203.0.113.9", "x-real-ip": realIp },
        }),
      )
    assertEquals((await send("198.51.100.1")).status, 200)
    assertEquals((await send("198.51.100.1")).status, 429)
    assertEquals((await send("198.51.100.2")).status, 200)
  })

  it("keys IPv6 clients on their /64 and IPv4 clients on their address", async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    const app = new Hono()
    let peer = ""
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => peer,
        keyResolver: userThenIp(() => undefined),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const from = async (address: string) => {
      peer = address
      return (await app.request(new Request("http://localhost/"))).status
    }
    assertEquals(await from("2001:db8:1:2::1"), 200)
    assertEquals(await from("2001:db8:1:2::2"), 429)
    assertEquals(await from("2001:db8:1:3::1"), 200)
    assertEquals(await from("192.0.2.1"), 200)
    assertEquals(await from("192.0.2.2"), 200)
  })

  it("keys each IPv6 address separately with ipv6PerAddress", async () => {
    const seen: string[] = []
    const resolver = userThenIp(() => undefined, { ipv6PerAddress: true })
    for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::2", "192.0.2.1"]) {
      seen.push(
        await resolver(new Request("http://localhost/"), {
          req: new Request("http://localhost/"),
          remoteAddr: address,
        } as never),
      )
    }
    assertEquals(seen, ["ip:2001:db8:1:2::1", "ip:2001:db8:1:2::2", "ip:192.0.2.1"])
  })

  it("passes trustedProxies through to clientIp", async () => {
    const resolver = userThenIp(() => undefined, {
      trustedProxy: "cf-connecting-ip",
      trustedProxies: ["104.16.0.0/13"],
    })
    const key = (remoteAddr: string) => {
      const req = new Request("http://localhost/", {
        headers: { "cf-connecting-ip": "198.51.100.7" },
      })
      return resolver(req, { req, remoteAddr } as never)
    }
    assertEquals(await key("104.16.0.1"), "ip:198.51.100.7")
    assertEquals(await key("192.0.2.1"), "ip:192.0.2.1")
  })

  it("keys on the authenticated user when the resolver finds one", async () => {
    const seen: string[] = []
    const app = new Hono()
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => undefined,
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
        { remoteAddr: () => undefined, keyResolver: () => "ip:203.0.113.9", keyPrefix: "chart:" },
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
        remoteAddr: () => undefined,
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
        remoteAddr: () => undefined,
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
        remoteAddr: () => undefined,
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

  it("refuses a missing remoteAddr resolver, so a caller must decide how the client IP is read", () => {
    // Before this check, `userThenIp` with no `remoteAddr` wired and no trusted proxy header
    // silently bucketed every anonymous request on the same placeholder address — the audit's own
    // repro: `userThenIp` defaulted to `ip:0.0.0.0` for every client. Now the factory refuses to
    // build at all until the caller states, even as `() => undefined`, what it read.
    const limiter = createMemoryRateLimiter({ windowMs: 1000, limit: 1, clock: () => T0 })
    let message = ""
    try {
      createRateLimitMiddleware(limiter, { keyResolver: () => "k" } as never)
    } catch (error) {
      message = (error as Error).message
    }
    assertEquals(message.includes("remoteAddr"), true, message)
  })

  it("still collides two clients on the placeholder when remoteAddr explicitly answers undefined", async () => {
    // `() => undefined` builds successfully — this is the documented, deliberate way to state "no
    // peer address is available here" — and every anonymous client still shares one bucket, because
    // that is what "no peer address" means. The fix requires the decision to be written down; it
    // does not change what a caller who writes exactly this down gets.
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    const app = new Hono()
    app.use(
      createRateLimitMiddleware(limiter, {
        remoteAddr: () => undefined,
        keyResolver: userThenIp(() => undefined),
      }),
    )
    app.get("/", (c) => c.text("ok"))

    const from = (ip: string) =>
      app.request(new Request("http://localhost/", { headers: { "x-forwarded-for": ip } }))
    assertEquals((await from("203.0.113.9")).status, 200)
    assertEquals((await from("198.51.100.7")).status, 429)
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
