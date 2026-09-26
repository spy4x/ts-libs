/**
 * The key-value flow store against a real Redis (#150): the `OAuthFlowStore` contract, and a
 * callback completed on a second `createOAuthSignIn` that shares the store with the first.
 *
 * The client is a small adapter over `RedisClient` that sends `SET … EX` and `GETDEL`, the same
 * commands `RedisKvStore` sends for `set` and `take`. Isolation: every test writes under its own
 * `uniqueKeyPrefix` and deletes each key it wrote in a `finally`. Never `FLUSHDB`: the container is
 * shared with every other worktree's run.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { RedisClient } from "@iuioiua/redis"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { SessionManager } from "../sign-in/mod.ts"
import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"
import { createOAuthSignIn } from "./oauth.ts"
import { createKvOAuthFlowStore, type OAuthFlowKv } from "./oauth-flows.ts"
import { describeOAuthFlowStoreContract } from "./oauth-flows-contract.test.ts"
import {
  createFakeProvider,
  fakeOptions,
  fixedClock,
  type OAuthFixture,
  PEPPER,
} from "./oauth-scenarios.test.ts"

interface RedisKv extends OAuthFlowKv {
  /** Deletes every key this client wrote and closes its connection. */
  close(): Promise<void>
}

/** A connection to the test Redis, with `set` and `take` as `RedisKvStore` sends them. */
async function connectKv(): Promise<RedisKv> {
  const settings = redisSettings()
  await requireReachable(settings.address)
  const connection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
  const client = new RedisClient(connection)
  const written = new Set<string>()
  return {
    async set(key, value, ttlSec) {
      written.add(key)
      await client.sendCommand(["SET", key, value, "EX", ttlSec])
    },
    async take(key) {
      return await client.sendCommand<string | null>(["GETDEL", key])
    },
    async close() {
      try {
        if (written.size > 0) await client.sendCommand(["DEL", ...written])
      } finally {
        connection.close()
      }
    },
  }
}

describeOAuthFlowStoreContract("key-value over Redis", async () => {
  const kv = await connectKv()
  const clock = fixedClock()
  const store = createKvOAuthFlowStore(kv, { clock, keyPrefix: `${uniqueKeyPrefix("it_oauth")}:` })
  return { store, advance: clock.advance, now: clock.now, close: () => kv.close() }
})

describe("createOAuthSignIn with a flow store on Redis", () => {
  it("completes a callback on a second instance that shares the store, once", async () => {
    const kv = await connectKv()
    try {
      const clock = fixedClock()
      const flows = createKvOAuthFlowStore(kv, {
        clock,
        keyPrefix: `${uniqueKeyPrefix("it_oauth")}:`,
      })
      const fixture: OAuthFixture = {
        store: new MemoryAuthStore(),
        sessions: new SessionManager<AuthSessionRecord>({
          store: createFakeStore<AuthSessionRecord>().store,
          pepper: PEPPER,
          durationMinutes: 60,
        }),
        close: () => Promise.resolve(),
      }
      const provider = createFakeProvider()
      const first = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, flows })
      const second = createOAuthSignIn({ ...fakeOptions(fixture, provider), clock, flows })

      const started = await first.authorizationUrl()
      const query = await provider.approve(started.url, { sub: "sub-ann" })
      const result = await second.handleCallback({ query, browserState: started.state })
      expect(result.key.subject).toBe("sub-ann")

      const replay = await first.handleCallback({ query, browserState: started.state }).then(
        () => null,
        (caught: unknown) => caught,
      )
      expect((replay as { reason?: string } | null)?.reason).toBe("invalid-state")
    } finally {
      await kv.close()
    }
  })
})
