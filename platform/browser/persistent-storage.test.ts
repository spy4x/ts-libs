import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { KeyValueStore } from "../universal/key-value-store.ts"
import { memoryStorage } from "./storage.ts"
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

  describe("with askOnce", () => {
    const KEY = "persistence-asked"

    it("asks the first time and not again on the next start", async () => {
      const notes = memoryStorage()
      const fake = storage(false, false)

      expect(await requestPersistentStorage(fake, { key: KEY, store: notes })).toBe(false)
      expect(await requestPersistentStorage(fake, { key: KEY, store: notes })).toBe(false)

      expect(fake.asked).toBe(1)
      expect(notes.getItem(KEY)).toBe("1")
    })

    it("does not ask, nor leave a note, when storage is already persistent", async () => {
      const notes = memoryStorage()
      const fake = storage(true, false)

      expect(await requestPersistentStorage(fake, { key: KEY, store: notes })).toBe(true)

      expect(fake.asked).toBe(0)
      expect(notes.size).toBe(0)
    })

    it("answers true without asking when persistence was granted after an earlier ask", async () => {
      const fake = storage(true, false)

      expect(
        await requestPersistentStorage(fake, { key: KEY, store: memoryStorage({ [KEY]: "1" }) }),
      ).toBe(true)
    })

    it("asks anyway when the note cannot be read or written", async () => {
      const blocked: KeyValueStore = {
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {
          throw new Error("blocked")
        },
        removeItem: () => {},
      }
      const fake = storage(false, true)

      expect(await requestPersistentStorage(fake, { key: KEY, store: blocked })).toBe(true)
      expect(fake.asked).toBe(1)
    })

    it("asks again on every start when no askOnce is given", async () => {
      const fake = storage(false, false)

      await requestPersistentStorage(fake)
      await requestPersistentStorage(fake)

      expect(fake.asked).toBe(2)
    })
  })
})
