import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { MemoryKeyValueStore } from "./storage.ts"

describe("MemoryKeyValueStore", () => {
  it("returns null for a key that was never set", () => {
    const store = new MemoryKeyValueStore()
    expect(store.getItem("missing")).toBeNull()
  })

  it("round-trips a value through setItem/getItem", () => {
    const store = new MemoryKeyValueStore()
    store.setItem("cursor", "42")
    expect(store.getItem("cursor")).toBe("42")
  })

  it("overwrites an existing key on a second setItem", () => {
    const store = new MemoryKeyValueStore()
    store.setItem("cursor", "1")
    store.setItem("cursor", "2")
    expect(store.getItem("cursor")).toBe("2")
  })

  it("forgets a key after removeItem", () => {
    const store = new MemoryKeyValueStore()
    store.setItem("cursor", "1")
    store.removeItem("cursor")
    expect(store.getItem("cursor")).toBeNull()
  })

  it("lists currently held keys, sorted", () => {
    const store = new MemoryKeyValueStore()
    store.setItem("b", "1")
    store.setItem("a", "1")
    expect(store.keys()).toEqual(["a", "b"])
  })

  it("does not survive past the instance", () => {
    const first = new MemoryKeyValueStore()
    first.setItem("cursor", "1")
    const second = new MemoryKeyValueStore()
    expect(second.getItem("cursor")).toBeNull()
  })
})
