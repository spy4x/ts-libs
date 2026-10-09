import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type PersistentStorageManager, requestPersistentStorage } from "./persistent-storage.ts"

function storage(
  persisted: boolean,
  grants: boolean,
): PersistentStorageManager & { asked: number } {
  const fake = {
    asked: 0,
    persisted: () => Promise.resolve(persisted),
    persist: () => {
      fake.asked++
      return Promise.resolve(grants)
    },
  }
  return fake
}

describe("requestPersistentStorage", () => {
  it("answers true when the browser grants the request", async () => {
    expect(await requestPersistentStorage(storage(false, true))).toBe(true)
  })

  it("answers false when the browser refuses", async () => {
    expect(await requestPersistentStorage(storage(false, false))).toBe(false)
  })

  it("answers true without asking again when storage is already persistent", async () => {
    const fake = storage(true, false)

    expect(await requestPersistentStorage(fake)).toBe(true)
    expect(fake.asked).toBe(0)
  })

  it("answers false when the browser has no storage manager", async () => {
    expect(await requestPersistentStorage(undefined)).toBe(false)
  })

  it("answers false when the browser throws", async () => {
    const throwing: PersistentStorageManager = {
      persisted: () => Promise.reject(new Error("denied")),
      persist: () => Promise.reject(new Error("denied")),
    }

    expect(await requestPersistentStorage(throwing)).toBe(false)
  })
})
