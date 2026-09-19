import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import * as barrel from "./mod.ts"

/** Fixed start instant. Nothing here reads `Date.now()`. */
const T0 = 1_700_000_000_000

describe("public surface", () => {
  it("exports every documented symbol", () => {
    const expected = [
      "clientIp",
      "createKvStore",
      "createMemoryRateLimiter",
      "createRateLimitMiddleware",
      "createStoreLimiter",
      "decisionHeaders",
      "DEFAULT_IDLE_MS",
      "denoKvBackend",
      "humanRetry",
      "MemoryRateLimiter",
      "RATE_LIMIT_HEADERS",
      "RateLimitKind",
      "rateLimitKey",
      "RateLimitStoreOverKv",
      "REJECTION_STATUSES",
      "StoreRateLimiter",
      "SWEEP_EVERY_CHECKS",
      "systemClock",
      "UNKNOWN_CLIENT_IP",
      "userThenIp",
    ]
    for (const name of expected) {
      assertEquals(name in barrel, true, `${name} is not exported from mod.ts`)
    }
    // Presence alone is not a contract: an extra export would slip through the loop above. The
    // public surface is exactly this list, so compare it as a set — which is what makes adding a
    // name back to `mod.ts` (as `resolveIdentityKey` was, and would be) a failing test rather than
    // a silent widening of the API.
    assertEquals(Object.keys(barrel).sort(), [...expected].sort())
  })

  it("limits through the barrel", () => {
    const limiter = barrel.createMemoryRateLimiter({ windowMs: 60_000, limit: 1, clock: () => T0 })
    assertEquals(limiter.check("ip:203.0.113.9").allowed, true)
    assertEquals(limiter.check("ip:203.0.113.9").allowed, false)
  })
})
