// The Web Storage behaviour `makeStorage` and its callers rely on, written once and run against both
// implementations: `storage.test.ts` runs it on `memoryStorage` in the unit tier, and
// `storage.integration.test.ts` runs it on Deno's real `localStorage`. A case the fake gets wrong
// here is a case every test that uses `memoryStorage` gets wrong too.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeStorageContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { StorageLike } from "./storage.ts"

/** A storage, the key prefix this case alone may use, and how to clean up afterwards. */
export interface StorageFixture {
  storage: StorageLike
  /** Prefix for every key the case writes, so a shared real store never collides. */
  prefix: string
  close(): void
}

/** Opens a fresh fixture for one case. */
export type OpenStorage = () => StorageFixture

/** Runs `body` on a fresh fixture and closes it, whether the body passed or not. */
function withFixture(
  open: OpenStorage,
  body: (storage: StorageLike, prefix: string) => void,
): void {
  const fixture = open()
  try {
    body(fixture.storage, fixture.prefix)
  } finally {
    fixture.close()
  }
}

/** Registers the Web Storage contract suite for one implementation. */
export function describeStorageContract(name: string, open: OpenStorage): void {
  describe(`${name} storage contract`, () => {
    it("returns null for a missing key", () => {
      withFixture(open, (storage, p) => {
        expect(storage.getItem(`${p}missing`)).toBeNull()
      })
    })

    it("returns what was set", () => {
      withFixture(open, (storage, p) => {
        storage.setItem(`${p}a`, `1`)
        expect(storage.getItem(`${p}a`)).toBe(`1`)
      })
    })

    it("overwrites an existing value", () => {
      withFixture(open, (storage, p) => {
        storage.setItem(`${p}a`, `1`)
        storage.setItem(`${p}a`, `2`)
        expect(storage.getItem(`${p}a`)).toBe(`2`)
      })
    })

    it("removes a key", () => {
      withFixture(open, (storage, p) => {
        storage.setItem(`${p}a`, `1`)
        storage.removeItem(`${p}a`)
        expect(storage.getItem(`${p}a`)).toBeNull()
      })
    })

    it("ignores the removal of a missing key", () => {
      withFixture(open, (storage, p) => {
        storage.removeItem(`${p}never-set`)
        expect(storage.getItem(`${p}never-set`)).toBeNull()
      })
    })

    it("keeps an empty string distinct from a missing key", () => {
      withFixture(open, (storage, p) => {
        storage.setItem(`${p}empty`, ``)
        expect(storage.getItem(`${p}empty`)).toBe(``)
      })
    })

    it("treats keys as case-sensitive", () => {
      withFixture(open, (storage, p) => {
        storage.setItem(`${p}Key`, `upper`)
        expect(storage.getItem(`${p}key`)).toBeNull()
        storage.setItem(`${p}key`, `lower`)
        expect(storage.getItem(`${p}Key`)).toBe(`upper`)
        expect(storage.getItem(`${p}key`)).toBe(`lower`)
      })
    })
  })
}
