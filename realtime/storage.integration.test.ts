/**
 * Deno's real `localStorage` against the `KeyValueStore` contract that `MemoryKeyValueStore` is
 * written to (issue #74). `MemoryKeyValueStore` stands in for `localStorage` in every other test
 * of this package, so this file is what keeps that stand-in honest.
 *
 * `localStorage` is shared by every run of the tier on this machine, so each case writes only keys
 * under a prefix that is unique to it and removes them in a `finally`; nothing is ever `clear()`ed.
 */

import { uniqueKeyPrefix } from "@integration-testing"
import { describeKeyValueStoreContract } from "./key-value-store-contract.test.ts"

describeKeyValueStoreContract("localStorage", () => {
  const prefix = uniqueKeyPrefix("realtime_kv")
  const written = new Set<string>()
  const store = {
    getItem: (k: string) => localStorage.getItem(k),
    setItem: (k: string, v: string) => {
      written.add(k)
      localStorage.setItem(k, v)
    },
    removeItem: (k: string) => localStorage.removeItem(k),
  }
  return {
    store,
    key: (name) => `${prefix}${name}`,
    close: () => {
      for (const k of written) localStorage.removeItem(k)
    },
  }
})
