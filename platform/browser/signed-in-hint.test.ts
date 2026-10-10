import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { memoryStorage } from "./storage.ts"
import { createSignedInHint } from "./signed-in-hint.ts"
import type { KeyValueStore } from "../universal/key-value-store.ts"

const KEY = "session:signed-in"

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("quota")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
}

const isUser = (value: unknown): value is { id: number } =>
  typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "number"

describe("createSignedInHint", () => {
  it("recalls a remembered flag and forgets it", () => {
    const hint = createSignedInHint(KEY, { storage: memoryStorage() })

    expect(hint.recall()).toBe(null)
    hint.remember(true)
    expect(hint.recall()).toBe(true)
    hint.forget()
    expect(hint.recall()).toBe(null)
  })

  it("keeps a whole object when the app chooses a validator", () => {
    const storage = memoryStorage()
    const hint = createSignedInHint(KEY, { storage, validate: isUser })

    hint.remember({ id: 7 })

    expect(hint.recall()).toEqual({ id: 7 })
    expect(storage.getItem(KEY)).toBe(`{"id":7}`)
  })

  it("reads a flag that an older app stored as the text 1", () => {
    const hint = createSignedInHint(KEY, {
      storage: memoryStorage({ [KEY]: "1" }),
      validate: (value): value is 1 => value === 1,
    })

    expect(hint.recall()).toBe(1)
  })

  it("treats a stored value the validator refuses as absent", () => {
    const hint = createSignedInHint(KEY, {
      storage: memoryStorage({ [KEY]: `{"id":"seven"}` }),
      validate: isUser,
    })

    expect(hint.recall()).toBe(null)
  })

  it("treats a stored value that is not valid JSON as absent", () => {
    const hint = createSignedInHint(KEY, { storage: memoryStorage({ [KEY]: "{oops" }) })

    expect(hint.recall()).toBe(null)
  })

  it("treats a stored null as absent", () => {
    const hint = createSignedInHint(KEY, { storage: memoryStorage({ [KEY]: "null" }) })

    expect(hint.recall()).toBe(null)
  })

  it("does not throw and recalls nothing when storage throws on read, write and remove", () => {
    const hint = createSignedInHint(KEY, { storage: throwing })

    hint.remember(true)
    expect(hint.recall()).toBe(null)
    hint.forget()
  })

  it("does nothing when told there is no storage", () => {
    const hint = createSignedInHint(KEY, { storage: null })

    hint.remember(true)
    expect(hint.recall()).toBe(null)
    hint.forget()
  })

  it("uses globalThis.localStorage when none is given, and survives a missing one", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get: () => {
          throw new Error("SecurityError")
        },
      })
      const hint = createSignedInHint(KEY)
      hint.remember(true)
      expect(hint.recall()).toBe(null)
      hint.forget()

      const fake = memoryStorage()
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fake })
      hint.remember(true)
      expect(fake.getItem(KEY)).toBe("true")
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})
