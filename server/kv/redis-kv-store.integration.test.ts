/**
 * `RedisKvStore` against a real Redis.
 *
 * Every key this test writes is scoped under a unique prefix (`uniqueKeyPrefix`) and
 * every `reset()`/`del()` in a `finally` touches only that prefix's keys — never
 * `FLUSHDB` or `FLUSHALL`, since this Redis container is shared with every other
 * worktree's run. The "killed connection" test kills only the one connection id this
 * store's own `clientId()` reports, never a filter broad enough to reach another
 * worktree's connection.
 */
import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { RedisClient, RedisError } from "@iuioiua/redis"
import { redisSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore, RedisKvStoreClosedError } from "./redis-kv-store.ts"

describe("RedisKvStore against a real server", () => {
  it("sets, gets, deletes and resets within its own prefix only", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv")
    const outsidePrefix = uniqueKeyPrefix("it_kv_outside")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    const sentinel = await RedisKvStore.connect(settings.hostname, settings.port, outsidePrefix)

    try {
      assertEquals(await store.get("missing"), null)

      await store.set("greeting", "hello from the integration tier", 60)
      assertEquals(await store.get("greeting"), "hello from the integration tier")

      // A key outside this store's prefix, written directly through a second store so
      // `reset()` below can be shown to leave it alone.
      await sentinel.set("bystander", "still here", 60)

      await store.del("greeting")
      assertEquals(await store.get("greeting"), null)

      await store.set("a", "1", 60)
      await store.set("b", "2", 60)
      await store.reset()
      assertEquals(await store.get("a"), null)
      assertEquals(await store.get("b"), null)

      // reset() only ever touched this store's own prefix.
      assertEquals(await sentinel.get("bystander"), "still here")
    } finally {
      // A failed assertion above must not leave this test's own keys behind for up to
      // 60 seconds: reset both stores, not only the sentinel.
      await store.reset()
      await sentinel.reset()
      store.close()
      sentinel.close()
    }
  })

  it("rejects a ttlSec that is not a positive integer", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_ttl")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)

    try {
      for (const ttlSec of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
        await assertRejects(() => store.set("key", "value", ttlSec), RangeError)
      }
      // None of the rejected calls reached Redis.
      assertEquals(await store.get("key"), null)
    } finally {
      await store.reset()
      store.close()
    }
  })

  it("reset() escapes glob metacharacters in the prefix instead of matching them as a pattern", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const base = uniqueKeyPrefix("it_kv_glob")
    const starStore = await RedisKvStore.connect(settings.hostname, settings.port, `${base}_app*`)
    const starSibling = await RedisKvStore.connect(settings.hostname, settings.port, `${base}_app2`)
    const questionStore = await RedisKvStore.connect(
      settings.hostname,
      settings.port,
      `${base}_a?p`,
    )
    const questionSibling = await RedisKvStore.connect(
      settings.hostname,
      settings.port,
      `${base}_abp`,
    )
    const bracketStore = await RedisKvStore.connect(
      settings.hostname,
      settings.port,
      `${base}_t[12]`,
    )
    const bracketSibling = await RedisKvStore.connect(
      settings.hostname,
      settings.port,
      `${base}_t1`,
    )

    try {
      await starSibling.set("k", "from-star-sibling", 60)
      await questionSibling.set("k", "from-question-sibling", 60)
      await bracketSibling.set("k", "from-bracket-sibling", 60)

      // If the prefix were not escaped, each of these would also match — and delete —
      // its sibling's key above: `app*` as a glob matches `app2:...`, `a?p` matches
      // `abp:...`, and `t[12]` matches `t1:...`.
      await starStore.reset()
      await questionStore.reset()
      await bracketStore.reset()

      assertEquals(await starSibling.get("k"), "from-star-sibling")
      assertEquals(await questionSibling.get("k"), "from-question-sibling")
      assertEquals(await bracketSibling.get("k"), "from-bracket-sibling")
    } finally {
      await starSibling.reset()
      await questionSibling.reset()
      await bracketSibling.reset()
      starStore.close()
      starSibling.close()
      questionStore.close()
      questionSibling.close()
      bracketStore.close()
      bracketSibling.close()
    }
  })

  it("does not let one store's reset() reach a sibling that merely extends its prefix", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const base = uniqueKeyPrefix("it_kv_sep")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, base)
    const sibling = await RedisKvStore.connect(settings.hostname, settings.port, `${base}2`)

    try {
      await sibling.set("k", "from-sibling", 60)
      // If reset()'s pattern omitted the `:` separator, `${base}*` would also match
      // `${base}2:...`.
      await store.reset()
      assertEquals(await sibling.get("k"), "from-sibling")
    } finally {
      await sibling.reset()
      store.close()
      sibling.close()
    }
  })

  it("a store's own prefix reaches a sibling that extends it with a colon", async () => {
    // Not a bug: documents the design note in server/README.md. A prefix is a plain
    // string match, not a namespace, so `outer`'s key `sub:k` and `inner`'s key `k`
    // are the same Redis key, and this overlap is expected.
    const settings = redisSettings()
    await requireReachable(settings.address)

    const base = uniqueKeyPrefix("it_kv_overlap")
    const outer = await RedisKvStore.connect(settings.hostname, settings.port, base)
    const inner = await RedisKvStore.connect(settings.hostname, settings.port, `${base}:sub`)

    try {
      await inner.set("k", "from-inner", 60)
      assertEquals(await outer.get("sub:k"), "from-inner")
      await outer.reset()
      assertEquals(await inner.get("k"), null)
    } finally {
      outer.close()
      inner.close()
    }
  })

  it("close() is safe to call more than once", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_close")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    store.close()
    store.close()
  })

  it("rejects instead of crashing after close()", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_closed_use")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    store.close()

    // Reaching this assertion at all is most of what this test proves: the ported
    // original crashed the whole process here instead of rejecting.
    await assertRejects(() => store.get("k"), RedisKvStoreClosedError)
    await assertRejects(() => store.set("k", "v", 60), RedisKvStoreClosedError)
    await assertRejects(() => store.del("k"), RedisKvStoreClosedError)
    await assertRejects(() => store.reset(), RedisKvStoreClosedError)
  })

  it("answers the first call after its connection is killed, by reconnecting and resending", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_killed")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    const ownId = await store.clientId()
    await store.set("k", "before-kill", 60)

    const adminConnection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
    const admin = new RedisClient(adminConnection)
    try {
      // Kills exactly this store's own connection, by the id it reported for itself —
      // never a filter (address, or "everyone but me") broad enough to also catch
      // another worktree's connection to this shared container.
      await admin.sendCommand(["CLIENT", "KILL", "ID", ownId])

      // Nothing here watches the connection: the kill is only noticed once a call
      // next tries to use it. This `get` is that call — its own read fails — and it
      // reconnects and sends the GET once more instead of throwing (#169).
      assertEquals(await store.get("k"), "before-kill")

      // It really is a new connection, not the killed one answering after all.
      assertEquals((await store.clientId()) !== ownId, true)
    } finally {
      await store.reset()
      adminConnection.close()
      store.close()
    }
  })

  it("answers every call still queued at the moment the connection is killed", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_killed_queued")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    const ownId = await store.clientId()

    const adminConnection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
    const admin = new RedisClient(adminConnection)
    try {
      // 20 calls are sent (and their writes trapped) before the connection dies, not
      // after: this is what proves the write trap itself, not just the #closed/
      // recorded-error checks a call made after the kill would hit before ever
      // writing anything.
      const queued = Array.from(
        { length: 20 },
        (_, index) => store.get(`q${index}`),
      )
      // Promise.allSettled attaches its handlers to all 20 immediately, in this same
      // microtask turn — before awaiting the kill below gives any of them a chance to
      // reject with no handler attached yet, which is what an unhandled rejection is.
      const settledPromise = Promise.allSettled(queued)
      await admin.sendCommand(["CLIENT", "KILL", "ID", ownId])

      // Every call still in flight when the kill landed, not just the first to
      // notice, is resent on the one shared fresh connection and answered; none
      // crashes the process or rejects.
      const settled = await settledPromise
      assertEquals(settled, queued.map(() => ({ status: "fulfilled", value: null })))
      assertEquals((await store.clientId()) !== ownId, true)
    } finally {
      adminConnection.close()
      store.close()
    }
  })

  it("keeps working after Redis answers one command with an error", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_wrongtype")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    const sideConnection = await Deno.connect({ hostname: settings.hostname, port: settings.port })
    const side = new RedisClient(sideConnection)
    try {
      // A list, written directly through a side connection so GET on it is guaranteed
      // to be refused with WRONGTYPE — an ordinary error reply, not a dead connection.
      await side.sendCommand(["LPUSH", `${prefix}:list`, "x"])

      const idBefore = await store.clientId()
      await assertRejects(() => store.get("list"), RedisError)
      // Not resent, and no reconnect: the same connection is still in use.
      assertEquals(await store.clientId(), idBefore)

      // The connection is still good: a command after the error reply succeeds.
      await store.set("fine", "v", 60)
      assertEquals(await store.get("fine"), "v")
    } finally {
      await side.sendCommand(["DEL", `${prefix}:list`])
      await store.del("fine")
      sideConnection.close()
      store.close()
    }
  })

  it("take() returns a value once and deletes it", async () => {
    const settings = redisSettings()
    await requireReachable(settings.address)

    const prefix = uniqueKeyPrefix("it_kv_take")
    const store = await RedisKvStore.connect(settings.hostname, settings.port, prefix)
    try {
      await store.set("flow", "pending", 60)
      assertEquals(await store.take("flow"), "pending")
      assertEquals(await store.take("flow"), null)
      assertEquals(await store.get("flow"), null)
    } finally {
      await store.reset()
      store.close()
    }
  })
})
