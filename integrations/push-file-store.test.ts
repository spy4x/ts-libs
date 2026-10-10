import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { PushSubscriptionJson } from "@spy4x/platform/model"
import { type FakeFs, fakeFs } from "../platform/server/_fake-fs.ts"
import {
  createFilePushSubscriptionStore,
  DEFAULT_MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  type FilePushSubscriptionStoreOptions,
  PushFileStoreError,
} from "./push-file-store.ts"

const PATH = "/data/push.json"
const USER = "owner"

const subscription = (name: string, auth = "auth-secret"): PushSubscriptionJson => ({
  endpoint: `https://push.example.com/send/${name}`,
  expirationTime: null,
  keys: { auth, p256dh: "p256dh-key" },
})

function setup(options: Partial<FilePushSubscriptionStoreOptions> = {}, fs: FakeFs = fakeFs()) {
  return { fs, store: createFilePushSubscriptionStore({ fs, path: PATH, ...options }) }
}

const names = (list: readonly PushSubscriptionJson[]) =>
  list.map((entry) => entry.endpoint.split("/").at(-1))

/** The rejection of `run`, which must be a store error; a resolved promise fails the test. */
async function failure(run: () => Promise<unknown>): Promise<PushFileStoreError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(PushFileStoreError)
    return error as PushFileStoreError
  }
  throw new Error("expected the call to reject")
}

describe("file push store: adding and removing a device", () => {
  it("lists nothing when the file does not exist, and creates no file by reading", async () => {
    const { fs, store } = setup()
    expect(await store.listByUser(USER)).toEqual([])
    expect(fs.files.size).toBe(0)
  })

  it("lists what was saved, for that user only", async () => {
    const { store } = setup()
    await store.save(USER, subscription("phone"))
    await store.save("someone-else", subscription("tablet"))
    expect(await store.listByUser(USER)).toEqual([subscription("phone")])
    expect(await store.listByUser("someone-else")).toEqual([subscription("tablet")])
    expect(await store.listByUser("nobody")).toEqual([])
  })

  it("keeps one entry when the same endpoint is saved twice, with the newer keys", async () => {
    const { store } = setup()
    await store.save(USER, subscription("phone", "old-auth"))
    await store.save(USER, subscription("laptop"))
    await store.save(USER, subscription("phone", "new-auth"))
    const list = await store.listByUser(USER)
    expect(names(list)).toEqual(["laptop", "phone"])
    expect(list[1].keys.auth).toBe("new-auth")
  })

  it("removes the subscription with that endpoint and leaves the others", async () => {
    const { store } = setup()
    await store.save(USER, subscription("phone"))
    await store.save(USER, subscription("laptop"))
    await store.save("someone-else", subscription("phone"))
    await store.deleteByEndpoint(USER, subscription("phone").endpoint)
    expect(names(await store.listByUser(USER))).toEqual(["laptop"])
    expect(names(await store.listByUser("someone-else"))).toEqual(["phone"])
  })

  it("writes nothing when the endpoint to remove is not there", async () => {
    const { fs, store } = setup()
    await store.deleteByEndpoint(USER, subscription("phone").endpoint)
    expect(fs.files.size).toBe(0)
    await store.save(USER, subscription("phone"))
    const writes = fs.calls.filter((call) => call.op === "writeText").length
    await store.deleteByEndpoint(USER, subscription("laptop").endpoint)
    expect(fs.calls.filter((call) => call.op === "writeText").length).toBe(writes)
  })

  it("survives a restart: a second store on the same file sees the subscriptions", async () => {
    const { fs, store } = setup()
    await store.save(USER, subscription("phone"))
    await store.save(7, subscription("watch"))
    const reopened = setup({}, fs).store
    expect(names(await reopened.listByUser(USER))).toEqual(["phone"])
    expect(names(await reopened.listByUser(7))).toEqual(["watch"])
  })

  it("keeps a user called __proto__ apart from every other user", async () => {
    const { store } = setup()
    await store.save("__proto__", subscription("phone"))
    expect(names(await store.listByUser("__proto__"))).toEqual(["phone"])
    expect(await store.listByUser("constructor")).toEqual([])
    expect(await store.listByUser(USER)).toEqual([])
  })
})

describe("file push store: the per-user cap", () => {
  it("drops the oldest subscription when a user saves one more than the cap", async () => {
    const { store } = setup({ maxPerUser: 3 })
    for (const name of ["a", "b", "c", "d"]) await store.save(USER, subscription(name))
    expect(names(await store.listByUser(USER))).toEqual(["b", "c", "d"])
  })

  it("counts a re-saved endpoint as the newest, so it is dropped last", async () => {
    const { store } = setup({ maxPerUser: 3 })
    for (const name of ["a", "b", "c", "a", "d"]) await store.save(USER, subscription(name))
    expect(names(await store.listByUser(USER))).toEqual(["c", "a", "d"])
  })

  it("caps each user alone", async () => {
    const { store } = setup({ maxPerUser: 1 })
    await store.save(USER, subscription("a"))
    await store.save("someone-else", subscription("b"))
    expect(names(await store.listByUser(USER))).toEqual(["a"])
    expect(names(await store.listByUser("someone-else"))).toEqual(["b"])
  })

  it("keeps 20 per user by default", async () => {
    expect(DEFAULT_MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBe(20)
    const { store } = setup()
    for (let index = 0; index < 25; index++) await store.save(USER, subscription(`d${index}`))
    const list = names(await store.listByUser(USER))
    expect(list).toHaveLength(20)
    expect(list[0]).toBe("d5")
    expect(list.at(-1)).toBe("d24")
  })

  it("refuses a cap that is not a whole number of at least 1", () => {
    for (const maxPerUser of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setup({ maxPerUser })).toThrow(RangeError)
    }
  })
})

describe("file push store: how it writes", () => {
  it("writes a temporary file and renames it over the document, never the document itself", async () => {
    const { fs, store } = setup()
    await store.save(USER, subscription("phone"))
    await store.save(USER, subscription("laptop"))
    const written = fs.calls.filter((call) => call.op === "writeText").map((call) => call.path)
    expect(written).toHaveLength(2)
    expect(written.every((path) => path.startsWith(`${PATH}.`) && path.endsWith(".tmp"))).toBe(true)
    expect(new Set(written).size).toBe(2)
    const renames = fs.calls.filter((call) => call.op === "rename")
    expect(renames.map((call) => call.extra)).toEqual([PATH, PATH])
    expect(renames.map((call) => call.path)).toEqual(written)
    expect([...fs.files.keys()]).toEqual([PATH])
  })

  it("creates the file for its owner only, and keeps it so on later writes", async () => {
    const { fs, store } = setup()
    await store.save(USER, subscription("phone"))
    expect(fs.modes.get(PATH)).toBe(0o600)
    await store.deleteByEndpoint(USER, subscription("phone").endpoint)
    await store.state("runner").save({ a: 1 })
    expect(fs.modes.get(PATH)).toBe(0o600)
  })

  it("creates the folder of the file when it is missing", async () => {
    const { fs, store } = setup()
    expect(fs.dirs.has("/data")).toBe(false)
    await store.save(USER, subscription("phone"))
    expect(fs.dirs.has("/data")).toBe(true)
  })

  it("loses nothing when many saves, removals and state writes start at once", async () => {
    const { store } = setup()
    await store.save(USER, subscription("gone"))
    const devices = Array.from({ length: 12 }, (_, index) => `d${index}`)
    await Promise.all([
      ...devices.map((name) => store.save(USER, subscription(name))),
      store.deleteByEndpoint(USER, subscription("gone").endpoint),
      store.state("runner").save({ lastRunAt: 5 }),
    ])
    expect(names(await store.listByUser(USER))).toEqual(devices)
    expect(await store.state("runner").load()).toEqual({ lastRunAt: 5 })
  })

  it("keeps the old document and leaves no temporary file when a write fails", async () => {
    const { fs, store } = setup()
    await store.save(USER, subscription("phone"))
    const before = fs.files.get(PATH)
    const original = fs.rename.bind(fs)
    fs.rename = () => Promise.reject(new Error("disk full"))
    await expect(store.save(USER, subscription("laptop"))).rejects.toThrow("disk full")
    fs.rename = original
    expect(fs.files.get(PATH)).toBe(before)
    expect([...fs.files.keys()]).toEqual([PATH])
    // The queue is not stuck behind the failed write.
    await store.save(USER, subscription("tablet"))
    expect(names(await store.listByUser(USER))).toEqual(["phone", "tablet"])
  })
})

describe("file push store: a file it cannot read", () => {
  const corruptFiles: [string, string][] = [
    ["text that is not JSON", `{"version": 1, "users": {`],
    ["an empty file", ""],
    ["JSON of another shape", `{"subscriptions": []}`],
    ["another version", `{"version": 2, "users": {}, "state": {}}`],
    [
      "a subscription with a missing key",
      JSON.stringify({
        version: 1,
        users: { owner: [{ endpoint: "https://push.example.com/send/x", keys: { auth: "a" } }] },
        state: {},
      }),
    ],
  ]

  for (const [label, content] of corruptFiles) {
    it(`reports ${label} on every call and leaves the file as it is`, async () => {
      const { fs, store } = setup({}, fakeFs({ [PATH]: content }))
      for (
        const run of [
          () => store.listByUser(USER),
          () => store.save(USER, subscription("phone")),
          () => store.deleteByEndpoint(USER, subscription("phone").endpoint),
          () => store.state("runner").load(),
          () => store.state("runner").save(1),
        ]
      ) {
        expect((await failure(run)).code).toBe("corrupt")
      }
      expect(fs.files.get(PATH)).toBe(content)
      expect(fs.calls.some((call) => call.op === "writeText" || call.op === "rename")).toBe(false)
    })
  }

  it("says nothing of the file's content in the error", async () => {
    const content = JSON.stringify({
      version: 1,
      users: { owner: [{ ...subscription("capability-path"), extra: "unexpected" }] },
      state: {},
    })
    const { store } = setup({}, fakeFs({ [PATH]: content }))
    const error = await failure(() => store.listByUser(USER))
    expect(error.message).not.toContain("capability-path")
    expect(error.message).not.toContain("auth-secret")
    expect(error.message).not.toContain("unexpected")
    expect(error.name).toBe("PushFileStoreError")
  })
})

describe("file push store: what save refuses", () => {
  const refused: [string, unknown][] = [
    ["an http endpoint", { ...subscription("x"), endpoint: "http://push.example.com/send/x" }],
    ["an endpoint that is not a URL", { ...subscription("x"), endpoint: "capability-path" }],
    ["a javascript: endpoint", { ...subscription("x"), endpoint: "javascript:alert(1)" }],
    ["an endpoint longer than 256 characters", {
      ...subscription("x"),
      endpoint: `https://push.example.com/${"a".repeat(260)}`,
    }],
    ["a subscription with no keys", { endpoint: subscription("x").endpoint }],
    ["a subscription with an extra field", { ...subscription("x"), userId: "owner" }],
    ["a value that is not an object", "capability-path"],
  ]

  for (const [label, value] of refused) {
    it(`refuses ${label}, writes nothing, and keeps the value out of the error`, async () => {
      const { fs, store } = setup()
      const error = await failure(() => store.save(USER, value as PushSubscriptionJson))
      expect(error.code).toBe("invalid-subscription")
      expect(error.message).not.toContain("capability-path")
      expect(error.message).not.toContain("push.example.com")
      expect(error.message).not.toContain("auth-secret")
      expect(fs.files.size).toBe(0)
    })
  }

  it("fills in the expiration time a browser left out", async () => {
    const { fs, store } = setup()
    const { expirationTime: _, ...bare } = subscription("phone")
    await store.save(USER, bare as PushSubscriptionJson)
    expect(await store.listByUser(USER)).toEqual([subscription("phone")])
    expect(JSON.parse(fs.files.get(PATH)!).users[USER]).toEqual([subscription("phone")])
  })

  it("refuses a user id that is empty, too long or not an id", async () => {
    const { fs, store } = setup()
    for (const userId of ["", "u".repeat(257), Number.NaN, 1.5]) {
      expect((await failure(() => store.save(userId, subscription("x")))).code).toBe("invalid-user")
      expect((await failure(() => store.listByUser(userId))).code).toBe("invalid-user")
      expect(
        (await failure(async () => await store.deleteByEndpoint(userId, "https://x.example")))
          .code,
      ).toBe("invalid-user")
    }
    expect(fs.files.size).toBe(0)
  })
})

describe("file push store: named state", () => {
  it("loads null before anything was saved, and the saved value after", async () => {
    const { store } = setup()
    const slot = store.state("runner")
    expect(await slot.load()).toBeNull()
    await slot.save({ lastRunAt: 1, sent: { a: 2 } })
    expect(await slot.load()).toEqual({ lastRunAt: 1, sent: { a: 2 } })
    await slot.save(null)
    expect(await slot.load()).toBeNull()
  })

  it("keeps two names apart, and state apart from subscriptions", async () => {
    const { fs, store } = setup()
    await store.save(USER, subscription("phone"))
    await store.state("a").save(1)
    await store.state("b").save(2)
    await store.state("__proto__").save(3)
    expect(await store.state("a").load()).toBe(1)
    expect(await store.state("b").load()).toBe(2)
    expect(await store.state("__proto__").load()).toBe(3)
    expect(await store.state("toString").load()).toBeNull()
    expect(names(await store.listByUser(USER))).toEqual(["phone"])
    expect(names(await setup({}, fs).store.listByUser(USER))).toEqual(["phone"])
    expect(await setup({}, fs).store.state("b").load()).toBe(2)
  })

  it("refuses a name that is empty or too long", () => {
    const { store } = setup()
    for (const name of ["", "n".repeat(257)]) {
      expect(() => store.state(name)).toThrow(PushFileStoreError)
    }
  })
})
