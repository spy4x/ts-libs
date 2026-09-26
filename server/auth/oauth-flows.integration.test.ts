/**
 * The key-value flow store against a real Redis (#150), with `RedisKvStore` as its client: the
 * `OAuthFlowStore` contract, and a callback completed on a second `createOAuthSignIn` that shares
 * the store with the first.
 *
 * Isolation: every test connects its own `RedisKvStore` under a `uniqueKeyPrefix` and calls its
 * `reset()` in a `finally`, which deletes that prefix's keys only. Never `FLUSHDB`: the container is
 * shared with every other worktree's run.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore } from "../kv/mod.ts"
import { SessionManager } from "../sign-in/mod.ts"
import { createFakeStore } from "../sign-in/fake-store.test.ts"
import { MemoryAuthStore } from "./memory-store.ts"
import type { AuthSessionRecord } from "./model.ts"
import { createOAuthSignIn } from "./oauth.ts"
import { createKvOAuthFlowStore } from "./oauth-flows.ts"
import { describeOAuthFlowStoreContract } from "./oauth-flows-contract.test.ts"
import {
  createFakeProvider,
  fakeOptions,
  fixedClock,
  type OAuthFixture,
  PEPPER,
} from "./oauth-scenarios.test.ts"

/** A `RedisKvStore` on the test Redis, under a prefix of its own. */
async function connectKv(): Promise<RedisKvStore> {
  const settings = redisSettings()
  await requireReachable(settings.address)
  return await RedisKvStore.connect(settings.hostname, settings.port, uniqueKeyPrefix("it_oauth"))
}

/** Deletes every key under the store's own prefix, then closes it. */
async function dispose(kv: RedisKvStore): Promise<void> {
  try {
    await kv.reset()
  } finally {
    kv.close()
  }
}

describeOAuthFlowStoreContract("key-value over Redis", async () => {
  const kv = await connectKv()
  const clock = fixedClock()
  const store = createKvOAuthFlowStore(kv, { clock })
  return { store, advance: clock.advance, now: clock.now, close: () => dispose(kv) }
})

describe("createOAuthSignIn with a flow store on Redis", () => {
  it("completes a callback on a second instance that shares the store, once", async () => {
    const kv = await connectKv()
    try {
      const clock = fixedClock()
      const flows = createKvOAuthFlowStore(kv, { clock })
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
      await dispose(kv)
    }
  })
})
