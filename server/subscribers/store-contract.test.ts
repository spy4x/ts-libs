// The `SubscriberStore` contract, written once and run against every store: `memory.test.ts` runs it
// in the unit tier; the file and Postgres stores run it from their own tests.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeSubscriberStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { AddSubscriberInput, SubscriberStore } from "./store.ts"

/** A fresh, empty store and how to dispose of it. */
export interface SubscriberStoreFixture {
  store: SubscriberStore
  close(): Promise<void>
}

/** Opens a fresh, empty store. */
export type OpenSubscriberStore = () => Promise<SubscriberStoreFixture>

/** 2001-01-01T00:00:00Z: far from the host clock, so a store reading the host clock is caught. */
export const NOW = Date.UTC(2001, 0, 1)
const HOUR = 3600_000

/** An `add` input for `name@example.com`, issued and stored at `at`. */
function subscription(name: string, at = NOW, issuedAt = at): AddSubscriberInput {
  return {
    email: `${name}@example.com`,
    key: `${name}-key`,
    mark: `${name}-mark`,
    issuedAt,
    at: new Date(at),
  }
}

/** Unsubscribes `name@example.com` at `at`, pruning nothing unless `pruneBefore` says so. */
function removal(name: string, at: number, pruneBefore = 0) {
  return {
    email: `${name}@example.com`,
    mark: `${name}-mark`,
    at: new Date(at),
    pruneBefore: new Date(pruneBefore),
  }
}

/** Runs `body` against a fresh store and closes it, pass or fail. */
async function withStore(
  open: OpenSubscriberStore,
  body: (store: SubscriberStore) => Promise<void>,
) {
  const fixture = await open()
  try {
    await body(fixture.store)
  } finally {
    await fixture.close()
  }
}

/** Registers the contract suite for one store. */
export function describeSubscriberStoreContract(name: string, open: OpenSubscriberStore): void {
  describe(`${name} (subscriber store contract)`, () => {
    it("starts empty", () =>
      withStore(open, async (store) => {
        expect(await store.list()).toEqual([])
        expect(await store.count()).toBe(0)
        expect(await store.findByKey("ann-key")).toBeUndefined()
      }))

    it("adds a new address and finds it by key, in the list and in the count", () =>
      withStore(open, async (store) => {
        expect(await store.add(subscription("ann"))).toBe("added")
        const ann = { email: "ann@example.com", key: "ann-key", subscribedAt: new Date(NOW) }
        expect(await store.findByKey("ann-key")).toEqual(ann)
        expect(await store.list()).toEqual([ann])
        expect(await store.count()).toBe(1)
      }))

    it("lists subscribers oldest first", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann", NOW))
        await store.add(subscription("bob", NOW + HOUR))
        await store.add(subscription("cat", NOW + 2 * HOUR))
        expect((await store.list()).map((row) => row.email)).toEqual([
          "ann@example.com",
          "bob@example.com",
          "cat@example.com",
        ])
      }))

    it("answers known for an address already listed and keeps the first row", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann", NOW))
        expect(await store.add(subscription("ann", NOW + HOUR))).toBe("known")
        expect(await store.count()).toBe(1)
        expect((await store.findByKey("ann-key"))?.subscribedAt).toEqual(new Date(NOW))
      }))

    it("answers known, not replay, for a listed address whose link predates an unsubscribe mark", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann", NOW))
        // Another address's removal records ann's mark, as a re-subscribe after an unsubscribe would.
        await store.remove({ ...removal("ann", NOW + HOUR), email: "other@example.com" })
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW))).toBe("known")
      }))

    it("removes an address, records it, and answers false the second time", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann"))
        await store.add(subscription("bob"))
        expect(await store.remove(removal("ann", NOW + HOUR))).toBe(true)
        expect(await store.findByKey("ann-key")).toBeUndefined()
        expect((await store.list()).map((row) => row.email)).toEqual(["bob@example.com"])
        expect(await store.count()).toBe(1)
        expect(await store.remove(removal("ann", NOW + 2 * HOUR))).toBe(false)
      }))

    it("refuses a confirm link issued before the address unsubscribed", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann", NOW))
        await store.remove(removal("ann", NOW + HOUR))
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW))).toBe("replay")
        expect(await store.count()).toBe(0)
      }))

    it("refuses a confirm link issued in the same millisecond as the unsubscribe", () =>
      withStore(open, async (store) => {
        await store.remove(removal("ann", NOW + HOUR))
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW + HOUR))).toBe("replay")
      }))

    it("accepts a confirm link issued after the unsubscribe", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann", NOW))
        await store.remove(removal("ann", NOW + HOUR))
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW + HOUR + 1))).toBe("added")
      }))

    it("records an unsubscribe even when the address was already gone", () =>
      withStore(open, async (store) => {
        expect(await store.remove(removal("ann", NOW + HOUR))).toBe(false)
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW))).toBe("replay")
      }))

    it("keeps the latest unsubscribe of an address", () =>
      withStore(open, async (store) => {
        await store.remove(removal("ann", NOW))
        await store.remove(removal("ann", NOW + 2 * HOUR))
        expect(await store.add(subscription("ann", NOW + 3 * HOUR, NOW + HOUR))).toBe("replay")
      }))

    it("keeps another address's unsubscribe apart", () =>
      withStore(open, async (store) => {
        await store.remove(removal("bob", NOW + HOUR))
        expect(await store.add(subscription("ann", NOW + 2 * HOUR, NOW))).toBe("added")
      }))

    it("drops unsubscribes older than pruneBefore on a later removal", () =>
      withStore(open, async (store) => {
        await store.remove(removal("ann", NOW))
        await store.remove(removal("bob", NOW + 2 * HOUR, NOW + HOUR))
        expect(await store.add(subscription("ann", NOW + 3 * HOUR, NOW - HOUR))).toBe("added")
        expect(await store.add(subscription("bob", NOW + 3 * HOUR, NOW))).toBe("replay")
      }))

    it("keeps an unsubscribe exactly at pruneBefore", () =>
      withStore(open, async (store) => {
        await store.remove(removal("ann", NOW))
        await store.remove(removal("bob", NOW + 2 * HOUR, NOW))
        expect(await store.add(subscription("ann", NOW + 3 * HOUR, NOW - HOUR))).toBe("replay")
      }))

    it("hands out copies, so a caller cannot change a stored row", () =>
      withStore(open, async (store) => {
        await store.add(subscription("ann"))
        const [listed] = await store.list()
        listed.email = "eve@example.com"
        listed.subscribedAt.setTime(0)
        const found = await store.findByKey("ann-key")
        if (found === undefined) throw new Error("expected ann")
        found.key = "eve-key"
        expect(await store.findByKey("ann-key")).toEqual({
          email: "ann@example.com",
          key: "ann-key",
          subscribedAt: new Date(NOW),
        })
      }))
  })
}
