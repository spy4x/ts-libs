// The `KeyValueStore` contract, written once and run against both implementations:
// `storage.test.ts` runs it on `MemoryKeyValueStore` in the unit tier, and
// `storage.integration.test.ts` runs it on Deno's real `localStorage`. The cursor store and the
// outbox are tested through the in-memory store, so a case it gets wrong here is a case their tests
// get wrong too.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeKeyValueStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { KeyValueStore } from "./storage.ts"

/** A store and the way to dispose of what a case wrote into it. */
export interface KeyValueStoreFixture {
  store: KeyValueStore
  /** A key that belongs to this case alone: unique per run, so parallel runs never collide. */
  key(name: string): string
  /** Removes every key the case wrote. Called in a `finally`, pass or fail. */
  close(): void
}

/** Opens a fresh fixture for one case. */
export type OpenKeyValueStore = () => KeyValueStoreFixture

/** Runs `body` on a fresh fixture and closes it, whether the body passed or not. */
function withFixture(
  open: OpenKeyValueStore,
  body: (fixture: KeyValueStoreFixture) => void,
): void {
  const fixture = open()
  try {
    body(fixture)
  } finally {
    fixture.close()
  }
}

/** Registers the contract suite for one implementation. */
export function describeKeyValueStoreContract(name: string, open: OpenKeyValueStore): void {
  describe(`${name} (key/value store contract)`, () => {
    it("returns null for a key that was never set", () => {
      withFixture(open, ({ store, key }) => {
        expect(store.getItem(key("missing"))).toBeNull()
      })
    })

    it("returns what setItem stored", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), "42")
        expect(store.getItem(key("a"))).toBe("42")
      })
    })

    it("replaces the value on a second setItem for the same key", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), "1")
        store.setItem(key("a"), "2")
        expect(store.getItem(key("a"))).toBe("2")
      })
    })

    it("keeps an empty string as a value, distinct from a missing key", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), "")
        expect(store.getItem(key("a"))).toBe("")
      })
    })

    it("keeps different keys independent", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), "1")
        store.setItem(key("b"), "2")
        store.removeItem(key("a"))
        expect(store.getItem(key("a"))).toBeNull()
        expect(store.getItem(key("b"))).toBe("2")
      })
    })

    it("forgets a key after removeItem", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), "1")
        store.removeItem(key("a"))
        expect(store.getItem(key("a"))).toBeNull()
      })
    })

    it("treats removeItem of a missing key as a no-op", () => {
      withFixture(open, ({ store, key }) => {
        expect(() => store.removeItem(key("never-set"))).not.toThrow()
        expect(store.getItem(key("never-set"))).toBeNull()
      })
    })

    it("stores a non-string argument as its string form, as Web Storage does", () => {
      withFixture(open, ({ store, key }) => {
        store.setItem(key("a"), 7 as unknown as string)
        expect(store.getItem(key("a"))).toBe("7")
      })
    })
  })
}
