// The `IdempotencyStore` contract, written once and run against both stores:
// `memory.test.ts` runs it in the unit tier, `postgres.integration.test.ts` against a real
// Postgres.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern
// keeps it out of the published package, and it registers no tests until a caller runs
// `describeIdempotencyStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.ts"

/** A fresh, empty store and how to move its clock and dispose of it. */
export interface StoreFixture {
  store: IdempotencyStore
  /** Makes every stored row `ms` older, as if that much time had passed. */
  advance(ms: number): Promise<void>
  close(): Promise<void>
}

const SECOND = 1000
const DAY = 86_400_000

function claim(overrides: Partial<IdempotencyClaim> = {}): IdempotencyClaim {
  return { userId: 7, key: "k1", commandName: "RenameCommand", requestHash: "hash-a", ...overrides }
}

/** Claims the key and returns the claim's token; fails the test when the key was not free. */
async function claimToken(store: IdempotencyStore, c: IdempotencyClaim): Promise<string> {
  const outcome = await store.begin(c)
  if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
  return outcome.token
}

/** Registers the contract's tests; `open` makes a fresh fixture per test. */
export function describeIdempotencyStoreContract(
  name: string,
  open: () => Promise<StoreFixture>,
): void {
  async function using(body: (fixture: StoreFixture) => Promise<void>): Promise<void> {
    const fixture = await open()
    try {
      await body(fixture)
    } finally {
      await fixture.close()
    }
  }

  describe(`${name} idempotency store contract`, () => {
    it("claims a new key", async () => {
      await using(async ({ store }) => {
        expect(await store.begin(claim())).toMatchObject({ status: "claimed" })
      })
    })

    it("says in_progress to a repeat while the first run is unfinished", async () => {
      await using(async ({ store }) => {
        await store.begin(claim())
        expect(await store.begin(claim())).toEqual({ status: "in_progress" })
      })
    })

    it("replays the stored result as JSON once the run is complete", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        await store.complete(7, "k1", token, { name: "Team", tags: ["a"], at: new Date(0) })
        expect(await store.begin(claim())).toEqual({
          status: "replay",
          result: { name: "Team", tags: ["a"], at: "1970-01-01T00:00:00.000Z" },
        })
      })
    })

    it("replays a result of null when the command returned nothing", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        await store.complete(7, "k1", token, undefined)
        expect(await store.begin(claim())).toEqual({ status: "replay", result: null })
      })
    })

    it("says reused for the same key with a different command or different input", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        expect(await store.begin(claim({ requestHash: "hash-b" }))).toEqual({ status: "reused" })
        expect(await store.begin(claim({ commandName: "DeleteCommand" }))).toEqual({
          status: "reused",
        })
        await store.complete(7, "k1", token, 1)
        expect(await store.begin(claim({ requestHash: "hash-b" }))).toEqual({ status: "reused" })
      })
    })

    it("keeps two users' identical keys apart", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim({ userId: 1 }))
        await store.complete(1, "k1", token, `one`)
        expect(await store.begin(claim({ userId: 2 }))).toMatchObject({ status: "claimed" })
        expect(await store.begin(claim({ userId: 1 }))).toEqual({
          status: "replay",
          result: `one`,
        })
      })
    })

    it("lets a retry claim the key again after release", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        await store.release(7, "k1", token)
        expect(await store.begin(claim())).toMatchObject({ status: "claimed" })
      })
    })

    it("does not let release undo a finished run", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        await store.complete(7, "k1", token, `kept`)
        await store.release(7, "k1", token)
        expect(await store.begin(claim())).toEqual({ status: "replay", result: `kept` })
      })
    })

    it("ignores a second complete, so the first result stands", async () => {
      await using(async ({ store }) => {
        const token = await claimToken(store, claim())
        await store.complete(7, "k1", token, `first`)
        await store.complete(7, "k1", token, `second`)
        expect(await store.begin(claim())).toEqual({ status: "replay", result: `first` })
      })
    })

    it("keeps the claim until the lease ends, then lets a retry take it over", async () => {
      await using(async ({ store, advance }) => {
        await store.begin(claim())
        await advance((IDEMPOTENCY_LEASE_SECONDS - 5) * SECOND)
        expect(await store.begin(claim())).toEqual({ status: "in_progress" })
        await advance(10 * SECOND)
        expect(await store.begin(claim())).toMatchObject({ status: "claimed" })
        // The takeover restarts the lease.
        expect(await store.begin(claim())).toEqual({ status: "in_progress" })
      })
    })

    it("hands a new token to a takeover, and the old token no longer releases the claim", async () => {
      await using(async ({ store, advance }) => {
        const stale = await claimToken(store, claim())
        await advance((IDEMPOTENCY_LEASE_SECONDS + 5) * SECOND)
        const current = await claimToken(store, claim())
        expect(current).not.toBe(stale)

        await store.release(7, "k1", stale)

        expect(await store.begin(claim())).toEqual({ status: "in_progress" })
        await store.release(7, "k1", current)
        expect(await store.begin(claim())).toMatchObject({ status: "claimed" })
      })
    })

    it("does not let a run that lost its claim to a takeover complete it", async () => {
      await using(async ({ store, advance }) => {
        const stale = await claimToken(store, claim())
        await advance((IDEMPOTENCY_LEASE_SECONDS + 5) * SECOND)
        const current = await claimToken(store, claim())

        await store.complete(7, "k1", stale, `stale result`)

        expect(await store.begin(claim())).toEqual({ status: "in_progress" })
        await store.complete(7, "k1", current, `current result`)
        expect(await store.begin(claim())).toEqual({
          status: "replay",
          result: `current result`,
        })
      })
    })

    it("never lets a lease takeover go to two retries at once", async () => {
      await using(async ({ store, advance }) => {
        await store.begin(claim())
        await advance((IDEMPOTENCY_LEASE_SECONDS + 5) * SECOND)
        const outcomes = await Promise.all(Array.from({ length: 6 }, () => store.begin(claim())))
        expect(outcomes.filter((outcome) => outcome.status === "claimed").length).toBe(1)
        expect(outcomes.filter((outcome) => outcome.status === "in_progress").length).toBe(5)
      })
    })

    it("claims a key for only one of two concurrent first calls", async () => {
      await using(async ({ store }) => {
        const outcomes = await Promise.all([store.begin(claim()), store.begin(claim())])
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "claimed",
          "in_progress",
        ])
      })
    })

    it("forgets a finished key once it is past the retention", async () => {
      await using(async ({ store, advance }) => {
        const token = await claimToken(store, claim())
        await store.complete(7, "k1", token, `old`)
        await advance((IDEMPOTENCY_RETENTION_DAYS - 1) * DAY)
        expect(await store.begin(claim())).toEqual({ status: "replay", result: `old` })
        await advance(2 * DAY)
        expect(await store.begin(claim())).toMatchObject({ status: "claimed" })
      })
    })

    it("sweeps only the keys past the retention and counts them", async () => {
      await using(async ({ store, advance }) => {
        await store.begin(claim({ key: "old1" }))
        await store.begin(claim({ key: "old2" }))
        await advance((IDEMPOTENCY_RETENTION_DAYS + 1) * DAY)
        await store.begin(claim({ key: "fresh" }))
        expect(await store.sweep()).toBe(2)
        expect(await store.sweep()).toBe(0)
        expect(await store.begin(claim({ key: "fresh" }))).toEqual({ status: "in_progress" })
        expect(await store.begin(claim({ key: "old1" }))).toMatchObject({ status: "claimed" })
      })
    })
  })
}
