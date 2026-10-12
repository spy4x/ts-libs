import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { memoryStorage } from "./storage.ts"
import { installLocalStorage } from "./testing.ts"
import { createLastSignIn, MAX_LAST_SIGN_IN_METHOD_LENGTH } from "./last-sign-in.ts"
import type { KeyValueStore } from "../universal/key-value-store.ts"

const KEY = "auth:last-sign-in"

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

describe("createLastSignIn", () => {
  it("reads back the remembered method with the address masked", () => {
    const store = createLastSignIn(KEY, { storage: memoryStorage() })
    expect(store.read()).toBeNull()
    store.remember("google", "jane.doe@example.com")
    expect(store.read()).toEqual({ method: "google", email: "j***@example.com" })
  })

  it("never writes the full address to storage", () => {
    const storage = memoryStorage()
    createLastSignIn(KEY, { storage }).remember("password", "jane.doe@example.com")
    const raw = storage.getItem(KEY) ?? ""
    expect(JSON.parse(raw)).toEqual({ method: "password", email: "j***@example.com" })
    expect(raw).not.toContain("jane")
  })

  it("keeps an already masked address as it is", () => {
    const store = createLastSignIn(KEY, { storage: memoryStorage() })
    store.remember("password", "j***@example.com")
    expect(store.read()?.email).toBe("j***@example.com")
  })

  it("keeps no address when none is given or the value has no @", () => {
    const store = createLastSignIn(KEY, { storage: memoryStorage() })
    for (const email of [undefined, null, "", "jane.doe"]) {
      store.remember("github", email)
      expect(store.read()).toEqual({ method: "github", email: null })
    }
  })

  it("replaces the earlier value with the latest one", () => {
    const store = createLastSignIn(KEY, { storage: memoryStorage() })
    store.remember("google", "jane@example.com")
    store.remember("password", "bob@example.org")
    expect(store.read()).toEqual({ method: "password", email: "b***@example.org" })
  })

  it("forgets the remembered sign-in", () => {
    const storage = memoryStorage()
    const store = createLastSignIn(KEY, { storage })
    store.remember("google", "jane@example.com")
    store.forget()
    expect(store.read()).toBeNull()
    expect(storage.size).toBe(0)
  })

  it("keeps nothing for an empty or over-long method, and leaves the earlier value", () => {
    const store = createLastSignIn(KEY, { storage: memoryStorage() })
    store.remember("google", "jane@example.com")
    store.remember("", "bob@example.org")
    store.remember("m".repeat(MAX_LAST_SIGN_IN_METHOD_LENGTH + 1), "bob@example.org")
    store.remember(7 as unknown as string, "bob@example.org")
    expect(store.read()).toEqual({ method: "google", email: "j***@example.com" })
    store.remember("m".repeat(MAX_LAST_SIGN_IN_METHOD_LENGTH))
    expect(store.read()?.method).toHaveLength(MAX_LAST_SIGN_IN_METHOD_LENGTH)
  })

  it("masks a full address another script stored under the key", () => {
    const storage = memoryStorage({
      [KEY]: JSON.stringify({ method: "google", email: "jane.doe@example.com" }),
    })
    expect(createLastSignIn(KEY, { storage }).read()).toEqual({
      method: "google",
      email: "j***@example.com",
    })
  })

  it("reads a stored value that is not a remembered sign-in as none", () => {
    for (
      const raw of ["not json", "null", "7", `"google"`, "{}", `{"method":""}`, `{"method":7}`]
    ) {
      const storage = memoryStorage({ [KEY]: raw })
      expect(createLastSignIn(KEY, { storage }).read()).toBeNull()
    }
  })

  it("does not throw when storage throws, and remembers for the life of the page", () => {
    const store = createLastSignIn(KEY, { storage: throwing })
    expect(store.read()).toBeNull()
    store.remember("google", "jane@example.com")
    expect(store.read()).toEqual({ method: "google", email: "j***@example.com" })
    store.forget()
    expect(store.read()).toBeNull()
  })

  it("does not throw when there is no localStorage at all", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError")
      },
    })
    try {
      const store = createLastSignIn(KEY)
      expect(store.read()).toBeNull()
      store.remember("google", "jane@example.com")
      store.forget()
      expect(store.read()).toBeNull()
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })

  it("uses the global localStorage by default, under the key it was given", () => {
    const { kept, restore } = installLocalStorage()
    try {
      const store = createLastSignIn(KEY)
      expect(store.key).toBe(KEY)
      store.remember("google", "jane@example.com")
      expect(kept.getItem(KEY)).toBe(`{"method":"google","email":"j***@example.com"}`)
      expect(kept.getItem("other")).toBeNull()
    } finally {
      restore()
    }
  })
})
