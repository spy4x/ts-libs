import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { installLocalStorage } from "./testing.ts"

describe("installLocalStorage", () => {
  it("makes the global localStorage the in-memory one until restored", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    const { kept, restore } = installLocalStorage({ seed: "1" })
    try {
      expect(globalThis.localStorage).toBe(kept as unknown as Storage)
      expect(globalThis.localStorage.getItem("seed")).toBe("1")
      globalThis.localStorage.setItem("theme", "dark")
      expect(kept.getItem("theme")).toBe("dark")
    } finally {
      restore()
    }
    expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(before)
  })

  it("removes the global again when there was none before", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    delete (globalThis as { localStorage?: unknown }).localStorage
    try {
      const { restore } = installLocalStorage()
      expect("localStorage" in globalThis).toBe(true)
      restore()
      expect("localStorage" in globalThis).toBe(false)
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real)
    }
  })
})
