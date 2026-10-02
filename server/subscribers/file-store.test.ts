import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type FakeFs, fakeFs } from "../../platform/server/_fake-fs.ts"
import { LockUnavailableError } from "@spy4x/platform/server/file-lock"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import { createSubscriptionCrypto } from "./crypto.ts"
import { createFileSubscriberStore, SubscriberFileError } from "./file-store.ts"
import { describeSubscriberStoreContract, NOW } from "./store-contract.test.ts"
import type { AddSubscriberInput } from "./store.ts"

const PATH = "/data/subscribers.json"
const SITE_LIST = await Deno.readTextFile(
  new URL("../__fixtures__/subscribers/subscribers.json", import.meta.url),
)
const SITE_MARKS = await Deno.readTextFile(
  new URL("../__fixtures__/subscribers/subscribers.json.unsubscribed", import.meta.url),
)
/** The mark in the site's fixture, recorded at 2026-03-03T12:00:00Z. */
const FIXTURE_MARK = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
const FIXTURE_UNSUBSCRIBED_AT = Date.UTC(2026, 2, 3, 12)

function input(name: string, overrides: Partial<AddSubscriberInput> = {}): AddSubscriberInput {
  return {
    email: `${name}@example.com`,
    key: `${name}-key`,
    mark: `${name}-mark`,
    issuedAt: NOW,
    at: new Date(NOW),
    ...overrides,
  }
}

/** A store on `fs` whose lock retries are fast, and a log that records instead of printing. */
function open(fs: FakeFs | FileSystemPort = fakeFs(), extra: { lockAttempts?: number } = {}) {
  const logged: unknown[][] = []
  const store = createFileSubscriberStore({
    path: PATH,
    fs,
    log: { error: (...args) => logged.push(args) },
    lockRetryMs: 1,
    ...extra,
  })
  return { store, logged }
}

describeSubscriberStoreContract("createFileSubscriberStore", () => {
  const { store } = open()
  return Promise.resolve({ store, close: () => Promise.resolve() })
})

describe("createFileSubscriberStore", () => {
  it("keeps both rows when two stores on one file add at the same time", async () => {
    const fs = fakeFs()
    const first = open(fs).store
    const second = open(fs).store
    const results = await Promise.all([
      first.add(input("ada")),
      second.add(input("grace")),
      first.add(input("alan")),
      second.add(input("edsger")),
    ])
    expect(results).toEqual(["added", "added", "added", "added"])
    expect(await first.count()).toBe(4)
  })

  it("waits for a lock another process holds, then writes", async () => {
    const fs = fakeFs()
    const { store } = open(fs)
    await fs.mkdirp("/data")
    const other = await fs.lock(`${PATH}.lock`)
    const pending = store.add(input("ada"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fs.files.has(PATH)).toBe(false)
    await other!.release()
    expect(await pending).toBe("added")
    expect((await store.list()).map((s) => s.email)).toEqual(["ada@example.com"])
  })

  it("gives up on a lock another process keeps, writes nothing and frees its own lock", async () => {
    const fs = fakeFs()
    const { store } = open(fs, { lockAttempts: 3 })
    await fs.mkdirp("/data")
    const other = await fs.lock(`${PATH}.lock`)
    await expect(store.add(input("ada"))).rejects.toBeInstanceOf(LockUnavailableError)
    await expect(store.remove({
      email: "ada@example.com",
      mark: "m",
      at: new Date(NOW),
      pruneBefore: new Date(0),
    })).rejects.toBeInstanceOf(LockUnavailableError)
    expect(fs.files.has(PATH)).toBe(false)
    expect(fs.files.has(`${PATH}.unsubscribed`)).toBe(false)
    expect(fs.locks.size).toBe(1)
    await other!.release()
    expect(await store.add(input("ada"))).toBe("added")
    expect(fs.locks.size).toBe(0)
  })

  it("refuses an unparseable list, keeps its text aside and never writes over it", async () => {
    const fs = fakeFs({ [PATH]: `[{"email": "ada@example.com"` })
    const { store, logged } = open(fs)
    await expect(store.list()).rejects.toBeInstanceOf(SubscriberFileError)
    await expect(store.add(input("grace"))).rejects.toBeInstanceOf(SubscriberFileError)
    await expect(store.count()).rejects.toBeInstanceOf(SubscriberFileError)
    expect(fs.files.get(`${PATH}.invalid`)).toBe(`[{"email": "ada@example.com"`)
    expect(fs.files.get(PATH)).toBe(`[{"email": "ada@example.com"`)
    expect(fs.files.has(`${PATH}.unsubscribed`)).toBe(false)
    expect(logged.length).toBeGreaterThan(0)
  })

  it("refuses valid JSON that is not a subscriber list, and a row with a bad date", async () => {
    for (const text of [`{"email":"ada@example.com"}`, `[{"email":"a@example.com"}]`]) {
      const fs = fakeFs({ [PATH]: text })
      await expect(open(fs).store.list()).rejects.toBeInstanceOf(SubscriberFileError)
      expect(fs.files.get(`${PATH}.invalid`)).toBe(JSON.stringify(JSON.parse(text)))
    }
    const bad = `[{"email":"a@example.com","subscribedAt":"yesterday"}]`
    const fs = fakeFs({ [PATH]: bad })
    await expect(open(fs).store.add(input("grace"))).rejects.toThrow(/not a date/)
    expect(fs.files.get(PATH)).toBe(bad)
  })

  it("keeps the first quarantined copy when a later damaged text turns up", async () => {
    const fs = fakeFs({ [PATH]: `first damage` })
    const { store } = open(fs)
    await expect(store.list()).rejects.toThrow(/its text is kept in/)
    fs.files.set(PATH, `second damage`)
    await expect(store.list()).rejects.toThrow(/an earlier copy is already kept/)
    expect(fs.files.get(`${PATH}.invalid`)).toBe(`first damage`)
  })

  it("keeps an unreadable unsubscribe record aside, logs it, and still serves the list", async () => {
    const fs = fakeFs({ [`${PATH}.unsubscribed`]: `not json` })
    const { store, logged } = open(fs)
    expect(await store.add(input("ada"))).toBe("added")
    expect(fs.files.get(`${PATH}.unsubscribed.invalid`)).toBe(`not json`)
    expect(logged.length).toBe(1)
    await store.remove({
      email: "ada@example.com",
      mark: "ada-mark",
      at: new Date(NOW),
      pruneBefore: new Date(0),
    })
    expect(fs.files.get(`${PATH}.unsubscribed.invalid`)).toBe(`not json`)
    expect(JSON.parse(fs.files.get(`${PATH}.unsubscribed`)!)).toEqual([
      { mark: "ada-mark", at: new Date(NOW).toISOString() },
    ])
  })

  it("loads the site's files unchanged: rows without a key, dates as Dates", async () => {
    const fs = fakeFs({ [PATH]: SITE_LIST, [`${PATH}.unsubscribed`]: SITE_MARKS })
    const { store } = open(fs)
    const rows = await store.list()
    expect(rows).toEqual([
      { email: "ada@example.com", subscribedAt: new Date(`2026-03-01T09:30:00.000Z`) },
      { email: "grace@example.org", subscribedAt: new Date(`2026-03-02T18:05:12.345Z`) },
    ])
    expect("key" in rows[0]).toBe(false)
    expect(await store.findByKey("ada-key")).toBeUndefined()
    expect(fs.files.get(PATH)).toBe(SITE_LIST)
  })

  it("applies the replay rule to a mark the site recorded", async () => {
    const fs = fakeFs({ [PATH]: SITE_LIST, [`${PATH}.unsubscribed`]: SITE_MARKS })
    const { store } = open(fs)
    const replay = input("ex", { mark: FIXTURE_MARK, issuedAt: FIXTURE_UNSUBSCRIBED_AT })
    expect(await store.add(replay)).toBe("replay")
    expect(await store.count()).toBe(2)
    expect(await store.add({ ...replay, issuedAt: FIXTURE_UNSUBSCRIBED_AT + 1 })).toBe("added")
  })

  it("writes the site's shape back, adding a key only on new rows, and keeps the site's marks", async () => {
    const fs = fakeFs({ [PATH]: SITE_LIST, [`${PATH}.unsubscribed`]: SITE_MARKS })
    const { store } = open(fs)
    await store.add(input("alan"))
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual([
      ...JSON.parse(SITE_LIST),
      { email: "alan@example.com", subscribedAt: new Date(NOW).toISOString(), key: "alan-key" },
    ])
    expect(fs.files.get(`${PATH}.unsubscribed`)).toBe(SITE_MARKS)
    await store.remove({
      email: "ada@example.com",
      mark: "ada-mark",
      at: new Date(FIXTURE_UNSUBSCRIBED_AT + 1000),
      pruneBefore: new Date(0),
    })
    expect(JSON.parse(fs.files.get(`${PATH}.unsubscribed`)!)).toEqual([
      ...JSON.parse(SITE_MARKS),
      { mark: "ada-mark", at: new Date(FIXTURE_UNSUBSCRIBED_AT + 1000).toISOString() },
    ])
    expect((await store.list()).map((s) => s.email)).toEqual([
      "grace@example.org",
      "alan@example.com",
    ])
  })

  it("records the unsubscribe before removing the row, so a failed list write loses no mark", async () => {
    const fs = fakeFs({ [PATH]: SITE_LIST })
    const failing: FileSystemPort = {
      ...fs,
      rename: (from, to) =>
        to === PATH ? Promise.reject(new Error(`rename refused`)) : fs.rename(from, to),
    }
    const { store } = open(failing)
    await expect(store.remove({
      email: "ada@example.com",
      mark: "ada-mark",
      at: new Date(NOW),
      pruneBefore: new Date(0),
    })).rejects.toThrow(`rename refused`)
    expect(fs.files.get(PATH)).toBe(SITE_LIST)
    expect(JSON.parse(fs.files.get(`${PATH}.unsubscribed`)!)).toEqual([
      { mark: "ada-mark", at: new Date(NOW).toISOString() },
    ])
    expect([...fs.files.keys()].filter((p) => p.endsWith(`.tmp`))).toEqual([])
    expect(fs.locks.size).toBe(0)
  })

  describe("backfillKeys", () => {
    const secret = `s`.repeat(32)

    it("gives rows without a key their subscriber key and keeps the keys that exist", async () => {
      const fs = fakeFs({ [PATH]: SITE_LIST })
      const { store } = open(fs)
      await store.add(input("alan"))
      const crypto = createSubscriptionCrypto({ secret })
      expect(await store.backfillKeys(crypto)).toBe(2)
      const ada = await store.findByKey(await crypto.subscriberKey("ada@example.com"))
      expect(ada?.email).toBe("ada@example.com")
      expect(ada?.subscribedAt).toEqual(new Date(`2026-03-01T09:30:00.000Z`))
      expect((await store.findByKey("alan-key"))?.email).toBe("alan@example.com")
    })

    it("changes nothing and writes nothing the second time", async () => {
      const fs = fakeFs({ [PATH]: SITE_LIST })
      const { store } = open(fs)
      const crypto = createSubscriptionCrypto({ secret })
      await store.backfillKeys(crypto)
      const after = fs.files.get(PATH)
      const writes = fs.calls.filter((c) => c.op === "writeText").length
      expect(await store.backfillKeys(crypto)).toBe(0)
      expect(fs.files.get(PATH)).toBe(after)
      expect(fs.calls.filter((c) => c.op === "writeText").length).toBe(writes)
    })

    it("runs under the lock, and refuses a damaged list", async () => {
      const fs = fakeFs({ [PATH]: SITE_LIST })
      const { store } = open(fs, { lockAttempts: 2 })
      const crypto = createSubscriptionCrypto({ secret })
      const other = await fs.lock(`${PATH}.lock`)
      await expect(store.backfillKeys(crypto)).rejects.toBeInstanceOf(LockUnavailableError)
      expect(fs.files.get(PATH)).toBe(SITE_LIST)
      await other!.release()
      fs.files.set(PATH, `broken`)
      await expect(store.backfillKeys(crypto)).rejects.toBeInstanceOf(SubscriberFileError)
      expect(fs.files.get(PATH)).toBe(`broken`)
    })
  })
})
