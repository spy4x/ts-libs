import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { ConnectionLostError } from "./client-transport.ts"
import { RealtimeRequestError } from "./errors.ts"
import {
  createMemoryOutboxStore,
  createOutbox,
  createPromiseLock,
  createWebLock,
  type LockManagerLike,
  type OutboxCommand,
  type OutboxLock,
  type OutboxStore,
  type SendFailure,
} from "./outbox.ts"
import { describeOutboxStoreContract } from "./outbox-store-contract.test.ts"

interface Text {
  title: string
  body: string
}

interface Item {
  id: string
  version: number
  title: string
}

type Store = OutboxStore<Text, Item>

function item(id: string, version = 1, title = id): Item {
  return { id, version, title }
}

function text(title: string, body = ""): Text {
  return { title, body }
}

function refused(code: string) {
  return new RealtimeRequestError("conflict", "refused", { code })
}

const CODES: Record<string, SendFailure> = {
  VERSION_CONFLICT: { kind: "version" },
  NOTE_NOT_FOUND: { kind: "not-found" },
  ID_ALREADY_EXISTS: { kind: "already-exists" },
}

/** One refusal code for each way the server refuses: stale, gone, and refused for good. */
const REFUSALS = ["VERSION_CONFLICT", "NOTE_NOT_FOUND", "ROLE_INSUFFICIENT"]

function classify(error: unknown): SendFailure {
  if (!(error instanceof RealtimeRequestError)) return { kind: "unreachable" }
  const code = (error.details as { code?: string } | undefined)?.code
  return CODES[code ?? ""] ?? { kind: "rejected", message: error.message }
}

interface Sent {
  command: OutboxCommand<Text>
  key: string
}

/** A cache of server state that records what the outbox told it. */
function fakeCache() {
  const items = new Map<string, Item>()
  return {
    items,
    port: {
      put: (server: Item) => {
        items.set(server.id, server)
        return Promise.resolve()
      },
      remove: (id: string) => {
        items.delete(id)
        return Promise.resolve()
      },
    },
  }
}

/** An outbox over a memory store whose server is a function the test replaces. */
function harness() {
  const store: Store = createMemoryOutboxStore()
  const cache = fakeCache()
  const sent: Sent[] = []
  const state = {
    /** Throws to simulate the server; returns the answer otherwise. */
    server: (_sent: Sent): Item | undefined => item("n", 2),
    current: null as Item | null,
    /** The server's copy cannot be read: `fetchServer` loses the connection. */
    fetchFails: false,
    online: true,
    /** Runs when a send starts, before the server answers. */
    onSend: undefined as undefined | (() => Promise<void>),
  }
  let keys = 0
  const outbox = createOutbox<Text, Item>({
    store,
    lock: createPromiseLock(),
    canSend: () => state.online,
    newKey: () => `key-${++keys}`,
    now: () => "2026-10-03T00:00:00.000Z",
    cache: cache.port,
    classify,
    async send(command, key) {
      const call = { command, key }
      sent.push(call)
      await state.onSend?.()
      return state.server(call)
    },
    fetchServer: () =>
      state.fetchFails
        ? Promise.reject(new ConnectionLostError("lost before the read"))
        : Promise.resolve(state.current),
  })
  const offline = () => {
    state.online = false
    state.server = () => {
      throw new ConnectionLostError("the socket is not open")
    }
  }
  return { store, cache, outbox, sent, state, offline }
}

describe("outbox while the connection is down", () => {
  it("keeps a create made offline in the queue", async () => {
    const { outbox, offline } = harness()
    offline()
    const outcome = await outbox.submit({
      kind: "create",
      entityId: "n-new",
      payload: text("Written offline"),
    })
    expect(outcome.kind).toBe("queued")
    expect(outbox.entries().map((e) => [e.entityId, e.payload.title])).toEqual([
      ["n-new", "Written offline"],
    ])
  })

  it("keeps a queued write across a restart of the layer", async () => {
    const { store, outbox, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "n-new", payload: text("T") })
    const again = createOutbox<Text, Item>({
      store,
      lock: createPromiseLock(),
      canSend: () => true,
      classify,
      send: () => Promise.resolve(item("n-new")),
      fetchServer: () => Promise.resolve(null),
    })
    expect((await again.reload()).map((e) => e.entityId)).toEqual(["n-new"])
  })

  it("sends the queue in order with the original keys once the connection is back", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    await outbox.submit({ kind: "create", entityId: "b", payload: text("B") })
    state.online = true
    state.server = ({ command }) => item(command.entityId)
    await outbox.flush()
    expect(sent.map((s) => [s.command.kind, s.command.entityId, s.key])).toEqual([
      ["create", "a", "key-1"],
      ["create", "b", "key-2"],
    ])
    expect(outbox.entries()).toEqual([])
  })

  it("stops at the first write that cannot reach the server and keeps the rest", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    await outbox.submit({ kind: "create", entityId: "b", payload: text("B") })
    sent.length = 0
    state.online = true
    await outbox.flush()
    expect(sent.length).toBe(1)
    expect(outbox.entries().length).toBe(2)
  })

  it("tells a subscriber about every change to the queue until it unsubscribes", async () => {
    const { outbox, offline } = harness()
    offline()
    const lengths: number[] = []
    const stop = outbox.subscribe((entries) => lengths.push(entries.length))
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    stop()
    const seen = lengths.length
    await outbox.submit({ kind: "create", entityId: "b", payload: text("B") })
    expect(seen).toBeGreaterThan(0)
    expect(lengths.length).toBe(seen)
    expect(lengths[lengths.length - 1]).toBe(1)
  })

  it("saves an entry as attempted before the server answers, so a closed page cannot resend it under a new key", async () => {
    const { store, outbox, state } = harness()
    let during: boolean | undefined
    state.onSend = async () => {
      during = (await store.readOutbox())[0]?.attempted
    }
    await outbox.submit({ kind: "create", entityId: "n", payload: text("T") })
    expect(during).toBe(true)
  })
})

describe("outbox as the wrong user", () => {
  it("sends nothing while the page is not signed in as the queue's user", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    state.online = false
    state.server = () => item("a")
    await outbox.flush()
    expect(sent).toEqual([])
    expect(outbox.entries().map((e) => [e.key, e.attempted])).toEqual([["key-1", false]])
  })

  it("sends the queue once the page is the queue's user again, under the original key", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    state.online = true
    state.server = () => item("a")
    await outbox.flush()
    expect(sent.map((s) => s.key)).toEqual(["key-1"])
  })

  it("stops in the middle of the queue when the user changes after a send", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    await outbox.submit({ kind: "create", entityId: "b", payload: text("B") })
    state.online = true
    state.server = ({ command }) => {
      state.online = false
      return item(command.entityId)
    }
    await outbox.flush()
    expect(sent.map((s) => s.command.entityId)).toEqual(["a"])
    expect(outbox.entries().map((e) => e.entityId)).toEqual(["b"])
  })
})

describe("outbox merging edits of one entity", () => {
  it("sends an entity created and edited offline as one create with the last text", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "n", payload: text("First") })
    await outbox.submit({ kind: "update", entityId: "n", payload: text("Second", "b"), version: 0 })
    state.online = true
    state.server = () => item("n", 1, "Second")
    await outbox.flush()
    expect(sent.map((s) => [s.command.kind, s.command.payload.title])).toEqual([
      ["create", "Second"],
    ])
  })

  it("sends nothing for an entity created and deleted before any send", async () => {
    const { outbox, sent, offline } = harness()
    offline()
    await outbox.submit({ kind: "create", entityId: "n", payload: text("T") })
    const outcome = await outbox.submit({
      kind: "delete",
      entityId: "n",
      payload: text("T"),
      version: 0,
    })
    expect(outcome.kind).toBe("dropped")
    expect(outbox.entries()).toEqual([])
    expect(sent.filter((s) => s.command.kind !== "create").length).toBe(0)
  })

  it("sends a second edit as one update on the first edit's base version", async () => {
    const { outbox, sent, state, offline } = harness()
    offline()
    await outbox.submit({ kind: "update", entityId: "n", payload: text("A"), version: 3 })
    await outbox.submit({ kind: "update", entityId: "n", payload: text("B"), version: 3 })
    state.online = true
    state.server = () => item("n", 4, "B")
    await outbox.flush()
    expect(sent.map((s) => [s.command.payload.title, s.command.baseVersion])).toEqual([["B", 3]])
  })

  it("keeps the key of an edit that was never sent", async () => {
    const { outbox, offline } = harness()
    offline()
    await outbox.submit({ kind: "update", entityId: "n", payload: text("A"), version: 3 })
    await outbox.submit({ kind: "update", entityId: "n", payload: text("B"), version: 3 })
    expect(outbox.entries().map((e) => [e.key, e.payload.title])).toEqual([["key-1", "B"]])
  })

  it("uses a new key for an edit made after a send whose outcome is unknown", async () => {
    const { outbox, sent, state } = harness()
    state.server = () => {
      throw new ConnectionLostError("closed after the send")
    }
    await outbox.submit({ kind: "update", entityId: "n", payload: text("A"), version: 3 })
    await outbox.submit({ kind: "update", entityId: "n", payload: text("B"), version: 3 })
    expect(sent.map((s) => s.key)).toEqual(["key-1", "key-2"])
  })

  it("deletes version 1 for an entity created and deleted after a send with unknown outcome", async () => {
    const { outbox, sent, state } = harness()
    state.server = () => {
      throw new ConnectionLostError("closed after the send")
    }
    await outbox.submit({ kind: "create", entityId: "n", payload: text("T") })
    state.server = () => undefined
    const outcome = await outbox.submit({
      kind: "delete",
      entityId: "n",
      payload: text("T"),
      version: 0,
    })
    expect(outcome.kind).toBe("sent")
    expect(sent[sent.length - 1].command).toMatchObject({ kind: "delete", baseVersion: 1 })
  })

  it("does not edit an entity again once it is queued for deletion", async () => {
    const { outbox, offline } = harness()
    offline()
    await outbox.submit({ kind: "delete", entityId: "n", payload: text("T"), version: 2 })
    await outbox.submit({ kind: "update", entityId: "n", payload: text("Later"), version: 2 })
    expect(outbox.entries().map((e) => [e.kind, e.payload.title])).toEqual([["delete", "T"]])
  })
})

describe("outbox when the server answers", () => {
  it("answers a change made online with the server's entity, caches it and leaves nothing queued", async () => {
    const { outbox, state, cache } = harness()
    state.server = () => item("n", 2, "Saved")
    const outcome = await outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Saved"),
      version: 1,
    })
    expect(outcome).toEqual({ kind: "sent", server: item("n", 2, "Saved") })
    expect(outbox.entries()).toEqual([])
    expect(cache.items.get("n")).toEqual(item("n", 2, "Saved"))
  })

  it("removes a deleted entity from the cache", async () => {
    const { outbox, state, cache } = harness()
    await cache.port.put(item("n"))
    state.server = () => undefined
    const outcome = await outbox.submit({
      kind: "delete",
      entityId: "n",
      payload: text("n"),
      version: 1,
    })
    expect(outcome).toEqual({ kind: "sent", server: undefined })
    expect(cache.items.has("n")).toBe(false)
  })

  for (const code of REFUSALS) {
    it(`hands a ${code} refusal to the person who just made the change and queues nothing`, async () => {
      const { outbox, state } = harness()
      state.server = () => {
        throw refused(code)
      }
      const outcome = await outbox.submit({
        kind: "update",
        entityId: "n",
        payload: text("Mine"),
        version: 1,
      })
      expect(outcome.kind).toBe("failed")
      expect(outbox.entries()).toEqual([])
    })
  }
})

describe("outbox when a change made online joins a write queued offline", () => {
  /**
   * An edit queued offline, the server copy changed meanwhile, and a second edit of the same
   * entity made once the connection is back, before the queue was sent: the two merge into one
   * entry, which the server refuses with `code`.
   */
  async function editAfterReconnect(code: string, current: Item | null) {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Offline"), version: 1 })
    h.state.server = () => {
      throw refused(code)
    }
    h.state.current = current
    h.state.online = true
    const outcome = await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Online"),
      version: 1,
    })
    return { ...h, outcome }
  }

  const cases = [
    { code: "VERSION_CONFLICT", current: item("n", 2, "Theirs"), reason: "version" },
    { code: "NOTE_NOT_FOUND", current: null, reason: "gone" },
    { code: "ROLE_INSUFFICIENT", current: null, reason: "rejected" },
  ] as const
  for (const { code, current, reason } of cases) {
    it(`keeps the offline edit as a ${reason} conflict and answers conflict, not failed`, async () => {
      const { outbox, outcome } = await editAfterReconnect(code, current)
      expect(outcome).toEqual({ kind: "conflict", reason })
      const [entry] = outbox.entries()
      expect(outbox.entries()).toHaveLength(1)
      expect(entry.status).toBe("conflict")
      expect(entry.conflict?.reason).toBe(reason)
      expect(entry.payload.title).toBe("Online")
      expect(entry.before?.payload.title).toBe("Offline")
    })
  }

  it("sends the merged edit on top of the server's version when I keep mine", async () => {
    const { outbox, sent, state } = await editAfterReconnect(
      "VERSION_CONFLICT",
      item("n", 2, "Theirs"),
    )
    state.server = () => item("n", 3, "Online")
    sent.length = 0
    await outbox.keepMine(outbox.entries()[0])
    expect(sent.map((s) => [s.command.kind, s.command.payload.title, s.command.baseVersion]))
      .toEqual([["update", "Online", 2]])
    expect(outbox.entries()).toEqual([])
  })

  it("drops the merged edit and shows the server's entity when I use theirs", async () => {
    const { outbox, cache } = await editAfterReconnect("VERSION_CONFLICT", item("n", 2, "Theirs"))
    await outbox.useTheirs(outbox.entries()[0])
    expect(outbox.entries()).toEqual([])
    expect(cache.items.get("n")?.title).toBe("Theirs")
  })

  it("keeps the offline edit queued when the server refuses and its copy cannot be read", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Offline"), version: 1 })
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    h.state.fetchFails = true
    h.state.online = true
    const outcome = await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Online"),
      version: 1,
    })
    expect(outcome).toEqual({ kind: "queued" })
    expect(h.outbox.entries().map((e) => [e.status, e.payload.title, e.before?.payload.title]))
      .toEqual([["pending", "Online", "Offline"]])
  })

  it("keeps a delete queued offline as a conflict when an edit made online after it is refused", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("Offline"), version: 1 })
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    h.state.current = item("n", 2, "Theirs")
    h.state.online = true
    const outcome = await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Online"),
      version: 1,
    })
    expect(outcome).toEqual({ kind: "conflict", reason: "version" })
    expect(h.outbox.entries().map((e) => [e.kind, e.status])).toEqual([["delete", "conflict"]])
  })

  it("keeps an edit another tab merged into my write before its send as a conflict", async () => {
    const store: Store = createMemoryOutboxStore()
    const ports = {
      store,
      classify,
      send: () => Promise.reject(refused("VERSION_CONFLICT")),
      fetchServer: () => Promise.resolve(item("n", 2, "Theirs")),
    }
    const otherTab = createOutbox<Text, Item>({
      ...ports,
      lock: createPromiseLock(),
      canSend: () => false,
    })
    // The third step of this tab's submit is the send: the other tab edits just before it.
    const steps = createPromiseLock()
    let step = 0
    const lock: OutboxLock = (work) =>
      steps(async () => {
        if (++step === 3) {
          await otherTab.submit({
            kind: "update",
            entityId: "n",
            payload: text("Other tab"),
            version: 1,
          })
        }
        return await work()
      })
    const thisTab = createOutbox<Text, Item>({ ...ports, lock, canSend: () => true })
    const outcome = await thisTab.submit({
      kind: "update",
      entityId: "n",
      payload: text("Mine"),
      version: 1,
    })
    expect(outcome).toEqual({ kind: "conflict", reason: "version" })
    const [entry] = await store.readOutbox()
    expect([entry.status, entry.payload.title]).toEqual(["conflict", "Other tab"])
  })
})

describe("outbox conflicts found after a reconnect", () => {
  async function staleUpdate() {
    const h = harness()
    h.offline()
    await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Mine", "my body"),
      version: 1,
    })
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    h.state.current = item("n", 2, "Theirs")
    h.state.online = true
    await h.outbox.flush()
    return h
  }

  it("keeps an edit the server refused as a visible conflict with both versions", async () => {
    const { outbox } = await staleUpdate()
    const [entry] = outbox.entries()
    expect(entry.status).toBe("conflict")
    expect(entry.conflict?.reason).toBe("version")
    expect(entry.conflict?.server?.title).toBe("Theirs")
    expect(entry.payload.title).toBe("Mine")
  })

  it("does not send a conflicted write again on its own", async () => {
    const { outbox, sent } = await staleUpdate()
    sent.length = 0
    await outbox.flush()
    expect(sent).toEqual([])
  })

  it("sends my version on top of the server's when I keep mine", async () => {
    const { outbox, sent, state } = await staleUpdate()
    state.server = () => item("n", 3, "Mine")
    sent.length = 0
    await outbox.keepMine(outbox.entries()[0])
    expect(sent.map((s) => [s.command.kind, s.command.payload.title, s.command.baseVersion]))
      .toEqual([["update", "Mine", 2]])
    expect(outbox.entries()).toEqual([])
  })

  it("shows the server's entity and drops mine when I use theirs", async () => {
    const { outbox, cache } = await staleUpdate()
    await outbox.useTheirs(outbox.entries()[0])
    expect(outbox.entries()).toEqual([])
    expect([...cache.items.values()].map((i) => i.title)).toEqual(["Theirs"])
  })

  it("keeps an edit of an entity deleted on the server as a conflict with no server entity", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Mine"), version: 1 })
    h.state.server = () => {
      throw refused("NOTE_NOT_FOUND")
    }
    h.state.current = null
    h.state.online = true
    await h.outbox.flush()
    expect(h.outbox.entries()[0].conflict?.reason).toBe("gone")
    expect(h.outbox.entries()[0].conflict?.server).toBe(null)
  })

  it("removes the cached entity when I use theirs after it was deleted on the server", async () => {
    const h = harness()
    await h.cache.port.put(item("n"))
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Mine"), version: 1 })
    h.state.server = () => {
      throw refused("NOTE_NOT_FOUND")
    }
    h.state.online = true
    await h.outbox.flush()
    await h.outbox.useTheirs(h.outbox.entries()[0])
    expect(h.cache.items.has("n")).toBe(false)
    expect(h.outbox.entries()).toEqual([])
  })

  it("treats a delete of an entity already gone as done", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("T"), version: 1 })
    h.state.server = () => {
      throw refused("NOTE_NOT_FOUND")
    }
    h.state.online = true
    await h.outbox.flush()
    expect(h.outbox.entries()).toEqual([])
  })

  it("treats a create onto a taken id as a version conflict", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "create", entityId: "n", payload: text("Mine") })
    h.state.server = () => {
      throw refused("ID_ALREADY_EXISTS")
    }
    h.state.current = item("n", 1, "Theirs")
    h.state.online = true
    await h.outbox.flush()
    expect(h.outbox.entries()[0].conflict?.reason).toBe("version")
  })

  it("keeps the queue when the server cannot be asked about a conflict", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Mine"), version: 1 })
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    h.state.online = true
    const outbox = createOutbox<Text, Item>({
      store: h.store,
      lock: createPromiseLock(),
      canSend: () => true,
      classify,
      send: () => Promise.reject(refused("VERSION_CONFLICT")),
      fetchServer: () => Promise.reject(new ConnectionLostError("down")),
    })
    await outbox.flush()
    expect((await h.store.readOutbox()).map((e) => e.status)).toEqual(["pending"])
  })

  it("keeps a write the server refuses for another reason, with the server's message", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "create", entityId: "n", payload: text("T") })
    h.state.server = () => {
      throw refused("ROLE_INSUFFICIENT")
    }
    h.state.online = true
    await h.outbox.flush()
    const [entry] = h.outbox.entries()
    expect(entry.status).toBe("conflict")
    expect(entry.conflict).toMatchObject({ reason: "rejected", message: "refused" })
  })

  it("words a conflict with the messages the app gives", async () => {
    const store: Store = createMemoryOutboxStore()
    const outbox = createOutbox<Text, Item>({
      store,
      lock: createPromiseLock(),
      canSend: () => true,
      classify,
      messages: { version: "Changed elsewhere." },
      send: () => Promise.reject(refused("VERSION_CONFLICT")),
      fetchServer: () => Promise.resolve(item("n", 2)),
    })
    await store.putEntry({
      key: "k",
      entityId: "n",
      kind: "update",
      payload: text("Mine"),
      baseVersion: 1,
      attempted: false,
      status: "pending",
      queuedAt: "",
    })
    await outbox.flush()
    expect((await store.readOutbox())[0].conflict?.message).toBe("Changed elsewhere.")
  })
})

/** Two tabs over one store, each with its own outbox and its own idea of the connection. */
function twoTabs(
  settle: (send: Promise<void>) => Promise<Item>,
  lock: () => OutboxLock = createPromiseLock,
) {
  const store: Store = createMemoryOutboxStore()
  let finish: () => void = () => {}
  const gate = new Promise<void>((resolve) => (finish = resolve))
  let started: () => void = () => {}
  const sendStarted = new Promise<void>((resolve) => (started = resolve))
  let keys = 0
  const tab = (online: boolean, prefix: string, shared?: OutboxLock) =>
    createOutbox<Text, Item>({
      store,
      lock: shared ?? lock(),
      canSend: () => online,
      newKey: () => `${prefix}-${++keys}`,
      now: () => "2026-10-03T00:00:00.000Z",
      classify,
      async send() {
        started()
        return await settle(gate)
      },
      fetchServer: () => Promise.resolve(item("n", 2, "Theirs")),
    })
  return { store, tab, finish: () => finish(), sendStarted }
}

describe("outbox shared by two tabs", () => {
  it("keeps an edit made in one tab while another tab's send of the same entity is running", async () => {
    const t = twoTabs(async (gate) => {
      await gate
      return item("n", 2, "From tab B")
    })
    const tabA = t.tab(false, "key-a")
    const tabB = t.tab(true, "key-b")
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Old"), version: 1 })
    const flushing = tabB.flush()
    await t.sendStarted
    // Tab A, offline, edits the same entity while tab B's send is in flight.
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Edit in A"), version: 1 })
    t.finish()
    await flushing
    const [kept] = await t.store.readOutbox()
    expect(kept?.payload.title).toBe("Edit in A")
  })

  it("keeps an edit made in one tab when another tab's send of the same entity is refused", async () => {
    const t = twoTabs(async (gate) => {
      await gate
      throw refused("VERSION_CONFLICT")
    })
    const tabA = t.tab(false, "key-a")
    const tabB = t.tab(true, "key-b")
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Old"), version: 1 })
    const flushing = tabB.flush()
    await t.sendStarted
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Edit in A"), version: 1 })
    t.finish()
    await flushing
    const [kept] = await t.store.readOutbox()
    expect([kept?.payload.title, kept?.status]).toEqual(["Edit in A", "pending"])
  })

  it("makes a tab wait for the send of another tab when they share a lock", async () => {
    const locks = fakeLockManager()
    const t = twoTabs(async (gate) => {
      await gate
      return item("n", 2, "From tab B")
    })
    const tabA = t.tab(false, "key-a", createWebLock(locks, "outbox:1"))
    const tabB = t.tab(true, "key-b", createWebLock(locks, "outbox:1"))
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Old"), version: 1 })
    const flushing = tabB.flush()
    await t.sendStarted
    let edited = false
    const editing = tabA.submit({
      kind: "update",
      entityId: "n",
      payload: text("Edit in A"),
      version: 1,
    }).then(() => (edited = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(edited).toBe(false)
    t.finish()
    await flushing
    await editing
    expect((await t.store.readOutbox()).map((e) => e.payload.title)).toEqual(["Edit in A"])
  })
})

/** A `LockManager` for tests: one holder per name, the rest wait in order. */
function fakeLockManager(): LockManagerLike & { requested: string[] } {
  const tails = new Map<string, Promise<unknown>>()
  const requested: string[] = []
  return {
    requested,
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      requested.push(name)
      const run = (tails.get(name) ?? Promise.resolve()).then(callback)
      tails.set(name, run.catch(() => {}))
      return run
    },
  }
}

describe("outbox conflicts settled from two tabs", () => {
  const conflicted = {
    key: "k-conflict",
    entityId: "n",
    kind: "update" as const,
    payload: text("Mine"),
    baseVersion: 1,
    attempted: true,
    status: "conflict" as const,
    conflict: { reason: "version" as const, message: "m", server: item("n", 2, "Theirs") },
    queuedAt: "",
  }

  it("keeps a newer edit when another tab's stale conflict card chooses the server's version", async () => {
    const locks = fakeLockManager()
    const store: Store = createMemoryOutboxStore()
    const cache = fakeCache()
    let keys = 0
    const tab = (name: string) =>
      createOutbox<Text, Item>({
        store,
        lock: createWebLock(locks, "outbox:1"),
        canSend: () => false,
        newKey: () => `${name}-${++keys}`,
        cache: cache.port,
        classify,
        send: () => Promise.reject(new ConnectionLostError("down")),
        fetchServer: () => Promise.resolve(null),
      })
    const tabA = tab("a")
    const tabB = tab("b")
    const saved = await store.putEntry(conflicted)
    const [cardInA] = await tabA.reload()
    // Tab B keeps its version, then the person edits the item again there.
    await tabB.reload()
    await tabB.keepMine(saved)
    await tabB.submit({
      kind: "update",
      entityId: "n",
      payload: text("Mine, edited again"),
      version: 2,
    })
    // Tab A still shows the old conflict card and chooses the server's version.
    await tabA.useTheirs(cardInA)
    expect((await store.readOutbox()).map((e) => [e.payload.title, e.status])).toEqual([
      ["Mine, edited again", "pending"],
    ])
    expect(cache.items.get("n")).toEqual(item("n", 2, "Theirs"))
  })

  it("ignores a stale conflict card when the entry has since become a newer conflict", async () => {
    const store: Store = createMemoryOutboxStore()
    const sent: string[] = []
    const outbox = createOutbox<Text, Item>({
      store,
      lock: createPromiseLock(),
      canSend: () => true,
      classify,
      send: (command) => {
        sent.push(command.payload.title)
        return Promise.resolve(item("n", 3))
      },
      fetchServer: () => Promise.resolve(null),
    })
    const saved = await store.putEntry(conflicted)
    await store.putEntry({ ...saved, key: "k-newer" })
    await outbox.keepMine(saved)
    await outbox.useTheirs(saved)
    expect(sent).toEqual([])
    expect((await store.readOutbox()).map((e) => [e.key, e.status])).toEqual([
      ["k-newer", "conflict"],
    ])
  })

  it("ignores a conflict card once the entry is no longer a conflict, even under the same key", async () => {
    const store: Store = createMemoryOutboxStore()
    const outbox = createOutbox<Text, Item>({
      store,
      lock: createPromiseLock(),
      canSend: () => false,
      classify,
      send: () => Promise.reject(new ConnectionLostError("down")),
      fetchServer: () => Promise.resolve(null),
    })
    const saved = await store.putEntry(conflicted)
    await store.putEntry({ ...saved, status: "pending", conflict: undefined })
    await outbox.useTheirs(saved)
    await outbox.keepMine(saved)
    expect((await store.readOutbox()).map((e) => [e.key, e.status, e.baseVersion])).toEqual([
      ["k-conflict", "pending", 1],
    ])
  })

  it("keeps an edit made in another tab while the server is asked about a refusal", async () => {
    const store: Store = createMemoryOutboxStore()
    let answer: () => void = () => {}
    const gate = new Promise<void>((resolve) => (answer = resolve))
    let asked: () => void = () => {}
    const fetchStarted = new Promise<void>((resolve) => (asked = resolve))
    let keys = 0
    const tab = (canSend: boolean, name: string) =>
      createOutbox<Text, Item>({
        store,
        lock: createPromiseLock(),
        canSend: () => canSend,
        newKey: () => `${name}-${++keys}`,
        classify,
        send: () => Promise.reject(refused("VERSION_CONFLICT")),
        async fetchServer() {
          asked()
          await gate
          return item("n", 2, "Theirs")
        },
      })
    const tabA = tab(false, "a")
    const tabB = tab(true, "b")
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Old"), version: 1 })
    const flushing = tabB.flush()
    await fetchStarted
    await tabA.submit({ kind: "update", entityId: "n", payload: text("Edit in A"), version: 1 })
    answer()
    await flushing
    const [kept] = await store.readOutbox()
    expect([kept?.payload.title, kept?.status]).toEqual(["Edit in A", "pending"])
  })
})

describe("createWebLock", () => {
  it("takes the lock under the name it was given", async () => {
    const locks = fakeLockManager()
    const lock = createWebLock(locks, "outbox:7")
    expect(await lock(() => Promise.resolve("done"))).toBe("done")
    expect(locks.requested).toEqual(["outbox:7"])
  })

  it("does not make two users of one browser wait for each other", async () => {
    const locks = fakeLockManager()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = createWebLock(locks, "outbox:1")(() => held)
    const other = await createWebLock(locks, "outbox:2")(() => Promise.resolve("ran"))
    expect(other).toBe("ran")
    release()
    await first
  })
})

describe("createPromiseLock", () => {
  it("runs pieces of work one at a time in the order asked, even after one fails", async () => {
    const lock = createPromiseLock()
    const order: string[] = []
    const a = lock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push("a")
      throw new Error("a failed")
    })
    const b = lock(() => {
      order.push("b")
      return Promise.resolve()
    })
    await expect(a).rejects.toThrow("a failed")
    await b
    expect(order).toEqual(["a", "b"])
  })
})

describe("outbox withdraw", () => {
  it("removes a waiting delete so it is never sent", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("T"), version: 3 })

    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(h.outbox.entries()).toEqual([])
    expect(await h.store.readOutbox()).toEqual([])

    h.state.online = true
    h.state.server = () => item("n", 4)
    await h.outbox.flush()
    expect(h.sent).toEqual([])
  })

  it("removes a waiting create or update of any kind", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "create", entityId: "a", payload: text("A") })
    await h.outbox.submit({ kind: "update", entityId: "b", payload: text("B"), version: 1 })

    expect(await h.outbox.withdraw("a")).toBe(true)
    expect(h.outbox.entries().map((e) => e.entityId)).toEqual(["b"])
    expect(await h.outbox.withdraw("b")).toBe(true)
    expect(h.outbox.entries()).toEqual([])
  })

  it("leaves the other entities' entries queued", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "a", payload: text("A"), version: 1 })
    await h.outbox.submit({ kind: "update", entityId: "b", payload: text("B"), version: 1 })

    await h.outbox.withdraw("a")

    expect((await h.store.readOutbox()).map((e) => e.entityId)).toEqual(["b"])
  })

  it("answers false for an entity with no waiting entry", async () => {
    const h = harness()
    expect(await h.outbox.withdraw("nothing")).toBe(false)
  })

  it("answers false and changes nothing for an entry that was already sent", async () => {
    const h = harness()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("T"), version: 1 })
    expect(h.sent.length).toBe(1)

    expect(await h.outbox.withdraw("n")).toBe(false)
    expect(h.sent.length).toBe(1)
  })

  it("answers false and keeps an entry whose send was started but did not finish", async () => {
    const h = harness()
    h.state.server = () => {
      throw new ConnectionLostError("the socket closed mid-send")
    }
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("T"), version: 1 })
    const before = await h.store.readOutbox()
    expect(before[0].attempted).toBe(true)

    expect(await h.outbox.withdraw("n")).toBe(false)
    expect(await h.store.readOutbox()).toEqual(before)
  })

  it("waits for a send in progress and then answers false, the send completing", async () => {
    const h = harness()
    let asked: Promise<boolean> | undefined
    h.state.onSend = () => {
      // The send holds the lock, so the withdraw can only run after it.
      asked = h.outbox.withdraw("n")
      return Promise.resolve()
    }
    const outcome = await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("T"),
      version: 1,
    })

    expect(await asked).toBe(false)
    expect(outcome.kind).toBe("sent")
  })

  it("takes back only a delete merged into an earlier edit, and the edit is still sent", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({
      kind: "update",
      entityId: "n",
      payload: text("Edited offline"),
      version: 3,
    })
    await h.outbox.submit({
      kind: "delete",
      entityId: "n",
      payload: text("Edited offline"),
      version: 3,
    })

    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(h.outbox.entries().map((e) => [e.kind, e.payload.title])).toEqual([
      ["update", "Edited offline"],
    ])

    h.state.online = true
    h.state.server = () => item("n", 4, "Edited offline")
    await h.outbox.flush()
    expect(h.sent.map((s) => [s.command.kind, s.command.payload.title])).toEqual([
      ["update", "Edited offline"],
    ])
  })

  it("takes back only a second edit, and the first edit is still sent", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "create", entityId: "n", payload: text("First") })
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Second"), version: 1 })

    expect(await h.outbox.withdraw("n")).toBe(true)

    h.state.online = true
    await h.outbox.flush()
    expect(h.sent.map((s) => [s.command.kind, s.command.payload.title])).toEqual([
      ["create", "First"],
    ])
  })

  async function lostSend(kind: "update" | "create") {
    const h = harness()
    h.state.server = () => {
      throw new ConnectionLostError("the socket closed mid-send")
    }
    await h.outbox.submit(
      kind === "create"
        ? { kind, entityId: "n", payload: text("Sent, answer lost") }
        : { kind, entityId: "n", payload: text("Sent, answer lost"), version: 1 },
    )
    const original = (await h.store.readOutbox())[0]
    expect(original.attempted).toBe(true)
    h.state.online = false // the next changes wait in the queue
    return { h, original }
  }

  for (const kind of ["update", "create"] as const) {
    it(`keeps a ${kind} whose send was lost when an edit merged into it is withdrawn`, async () => {
      const { h, original } = await lostSend(kind)
      await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Edit"), version: 1 })
      expect((await h.store.readOutbox())[0].key).not.toBe(original.key)

      expect(await h.outbox.withdraw("n")).toBe(true)

      const [kept] = await h.store.readOutbox()
      expect([kept.kind, kept.key, kept.attempted, kept.payload.title]).toEqual([
        kind,
        original.key,
        true,
        "Sent, answer lost",
      ])
      expect(await h.outbox.withdraw("n")).toBe(false)
      expect((await h.store.readOutbox()).length).toBe(1)
    })

    it(`keeps a ${kind} whose send was lost when a delete merged into it is withdrawn`, async () => {
      const { h, original } = await lostSend(kind)
      await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("x"), version: 1 })
      expect((await h.store.readOutbox())[0].kind).toBe("delete")

      expect(await h.outbox.withdraw("n")).toBe(true)

      const [kept] = await h.store.readOutbox()
      expect([kept.kind, kept.key, kept.attempted]).toEqual([kind, original.key, true])
      h.state.online = true
      h.state.server = () => item("n", 2)
      await h.outbox.flush()
      expect(h.sent[h.sent.length - 1].key).toBe(original.key)
      expect(h.sent.some((s, i) => i > 0 && s.command.kind === "delete")).toBe(false)
    })
  }

  it("takes back one change per withdraw, so edit, edit, delete and two withdraws send the first edit", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("E1"), version: 3 })
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("E2"), version: 3 })
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("E2"), version: 3 })

    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(h.outbox.entries().map((e) => [e.kind, e.payload.title])).toEqual([["update", "E2"]])
    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(h.outbox.entries().map((e) => [e.kind, e.payload.title])).toEqual([["update", "E1"]])

    h.state.online = true
    h.state.server = () => item("n", 4, "E1")
    await h.outbox.flush()
    expect(h.sent.map((s) => [s.command.kind, s.command.payload.title, s.key])).toEqual([
      ["update", "E1", "key-1"],
    ])
  })

  it("never drops an update whose send was lost, however many withdraws follow an edit and a delete", async () => {
    const { h, original } = await lostSend("update")
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("U2"), version: 1 })
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("U2"), version: 1 })

    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(await h.outbox.withdraw("n")).toBe(true)
    expect(await h.outbox.withdraw("n")).toBe(false)
    const [kept] = await h.store.readOutbox()
    expect([kept.kind, kept.key, kept.attempted, kept.payload.title]).toEqual([
      "update",
      original.key,
      true,
      "Sent, answer lost",
    ])

    h.state.online = true
    h.state.server = () => item("n", 2)
    await h.outbox.flush()
    expect(h.sent.slice(1).map((s) => [s.command.kind, s.command.payload.title, s.key])).toEqual([
      ["update", "Sent, answer lost", original.key],
    ])
  })

  it("sends a delete for a create whose send was lost, then edited and deleted offline", async () => {
    const { h } = await lostSend("create")
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("Edit"), version: 1 })
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("Edit"), version: 1 })

    expect(h.outbox.entries().map((e) => [e.kind, e.baseVersion])).toEqual([["delete", 1]])

    h.state.online = true
    h.state.server = () => undefined
    await h.outbox.flush()
    expect(h.sent.slice(1).map((s) => [s.command.kind, s.command.entityId])).toEqual([
      ["delete", "n"],
    ])
  })

  it("keeps the last 20 steps of an entity edited offline 100 times, and no more", async () => {
    const h = harness()
    h.offline()
    for (let i = 0; i <= 100; i++) {
      await h.outbox.submit({ kind: "update", entityId: "n", payload: text(`E${i}`), version: 3 })
    }
    const [entry] = await h.store.readOutbox()
    let depth = 0
    for (let step = entry.before; step; step = step.before) depth++
    expect(depth).toBe(20)

    for (let i = 0; i < 20; i++) expect(await h.outbox.withdraw("n")).toBe(true)
    expect(await h.outbox.withdraw("n")).toBe(false)
    expect(h.outbox.entries().map((e) => e.payload.title)).toEqual(["E80"])
  })

  it("sends a delete for a lost create whose send fell out of the last 20 steps", async () => {
    const { h } = await lostSend("create")
    for (let i = 0; i < 25; i++) {
      await h.outbox.submit({ kind: "update", entityId: "n", payload: text(`E${i}`), version: 1 })
    }
    await h.outbox.submit({ kind: "delete", entityId: "n", payload: text("E24"), version: 1 })

    expect(h.outbox.entries().map((e) => [e.kind, e.baseVersion])).toEqual([["delete", 1]])
  })

  it("answers false for a conflict that waits for a person", async () => {
    const h = harness()
    h.offline()
    await h.outbox.submit({ kind: "update", entityId: "n", payload: text("T"), version: 1 })
    h.state.online = true
    h.state.current = item("n", 5)
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    await h.outbox.flush()
    expect(h.outbox.entries()[0].status).toBe("conflict")

    expect(await h.outbox.withdraw("n")).toBe(false)
    expect(h.outbox.entries().length).toBe(1)
  })
})

describe("outbox with two overlapping submits for one entity", () => {
  const edits = (h: ReturnType<typeof harness>) => [
    h.outbox.submit({ kind: "update", entityId: "n", payload: text("A"), version: 1 }),
    h.outbox.submit({ kind: "update", entityId: "n", payload: text("B"), version: 1 }),
  ]

  it("answers sent to both callers when the server accepts the shared write", async () => {
    const h = harness()
    const [a, b] = await Promise.all(edits(h))
    expect(a.kind).toBe("sent")
    expect(b.kind).toBe("sent")
    expect(h.outbox.entries()).toEqual([])
  })

  it("answers conflict to both callers when the server refuses the shared write", async () => {
    const h = harness()
    h.state.current = item("n", 5)
    h.state.server = () => {
      throw refused("VERSION_CONFLICT")
    }
    const [a, b] = await Promise.all(edits(h))
    expect(a).toEqual({ kind: "conflict", reason: "version" })
    expect(b).toEqual({ kind: "conflict", reason: "version" })
  })
})

describeOutboxStoreContract("createMemoryOutboxStore", () => createMemoryOutboxStore())
