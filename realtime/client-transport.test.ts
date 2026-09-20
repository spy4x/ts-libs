/**
 * Client transport: handshake cursors, fetch-before-apply, acks, heartbeat, backoff, gate.
 *
 * Every case is driven by `FakeClock` and `FakeSocket` — no sleep, no network, no `--allow-net`.
 * The cases that matter most are the ones ADR 002 and issue #65 are built on: the handshake
 * advertises the cursor the client actually holds (not a hardcoded `0`); a hint — contiguous or
 * not — triggers a pull and the cursor moves only once that pull succeeds; a reconnect pulls every
 * held cursor once, unprompted; and the reconnect backoff resets only once a message has actually
 * arrived, not merely because a socket opened.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { type BackoffConfig, nextBackoffDelay } from "./backoff.ts"
import type { ServerMessage } from "./codec.ts"
import type { GapReport } from "./cursor.ts"
import {
  AckTimeoutError,
  AuthGateError,
  ClientTransport,
  type ClientTransportOptions,
  ConnectionLostError,
  ConnectTimeoutError,
  type CursorPort,
  type GateResult,
  PongTimeoutError,
  TransportStatus,
} from "./client-transport.ts"
import { PersistentCursorStore } from "./cursor.ts"
import {
  drainMicrotasks,
  FakeClock,
  FakeSocketFactory,
  MemoryKeyValueStore,
  sequenceRandom,
} from "./testing.ts"

const URL = "wss://api.example.test/ws"

interface HarnessOptions {
  /** Whether a created socket opens immediately. `false` exercises the connect timeout. */
  autoOpen?: boolean
  gate?: () => GateResult | Promise<GateResult>
  random?: () => number
  backoff?: Partial<BackoffConfig>
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
  connectTimeoutMs?: number
  ackTimeoutMs?: number
  handshakeAckTimeoutMs?: number
  handshakeAttempts?: number
  /** Pre-seeded durable cursors, as a warm client would have. */
  cursors?: Record<string, number>
  cursorsPort?: (store: PersistentCursorStore) => CursorPort
  pull?: (gap: GapReport) => void | Promise<void>
}

interface Harness {
  clock: FakeClock
  factory: FakeSocketFactory
  store: PersistentCursorStore
  storage: MemoryKeyValueStore
  transport: ClientTransport
  gaps: GapReport[]
  errors: Error[]
  degraded: Error[]
  /** Connect, then acknowledge the handshake the way a server would. */
  open: () => Promise<void>
  /** Acknowledge the newest unacknowledged `client.sync` frame. */
  settleHandshake: () => void
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock()
  const factory = new FakeSocketFactory({ autoOpen: options.autoOpen ?? true })
  const storage = new MemoryKeyValueStore()
  const store = new PersistentCursorStore({ storage, clock })
  for (const [groupId, sequence] of Object.entries(options.cursors ?? {})) {
    store.advanceTo(groupId, sequence)
  }

  const gaps: GapReport[] = []
  const errors: Error[] = []
  const degraded: Error[] = []

  const transportOptions: ClientTransportOptions = {
    url: URL,
    socketFactory: (url: string) => factory.open(url),
    clock,
    cursors: options.cursorsPort ? options.cursorsPort(store) : store,
    pull: (gap) => {
      gaps.push(gap)
      options.pull?.(gap)
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 500,
    connectTimeoutMs: options.connectTimeoutMs ?? 7_500,
    ackTimeoutMs: options.ackTimeoutMs ?? 500,
    handshakeAckTimeoutMs: options.handshakeAckTimeoutMs ?? 60_000,
    backoff: options.backoff ??
      { baseMs: 100, factor: 2, maxMs: 400, jitterRatio: 0.5 },
    random: options.random ?? sequenceRandom([1]),
  }
  if (options.gate) transportOptions.gate = options.gate
  if (options.handshakeAttempts !== undefined) {
    transportOptions.handshakeAttempts = options.handshakeAttempts
  }

  const transport = new ClientTransport(transportOptions)
  transport.onError((error) => errors.push(error))
  transport.onSyncDegraded((error) => degraded.push(error))

  const settleHandshake = () => {
    const socket = factory.latest
    const sync = [...socket.frames()].reverse().find((frame) => isKind(frame, "client.sync"))
    if (!sync) return
    const id = (sync as { id?: string }).id
    if (!id) return
    socket.receive(JSON.stringify({ kind: "server.ack", ackId: id }))
  }

  return {
    clock,
    factory,
    store,
    storage,
    transport,
    gaps,
    errors,
    degraded,
    settleHandshake,
    open: async () => {
      transport.connect()
      await drainMicrotasks()
      settleHandshake()
    },
  }
}

function hintFrame(
  groupId: string,
  sequence: number,
  aggregate = "invoice",
): string {
  return JSON.stringify({ kind: "change.hint", groupId, aggregate, sequence })
}

function isKind(frame: unknown, kind: string): boolean {
  return typeof frame === "object" && frame !== null &&
    (frame as ServerMessage).kind === kind
}

function kinds(socket: { frames(): unknown[] }): string[] {
  return socket.frames().map((frame) => (frame as { kind: string }).kind)
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
    return null
  } catch (error) {
    return error
  }
}

describe("ClientTransport connection lifecycle", () => {
  it("opens a socket and reports the open status", async () => {
    const harness = createHarness()

    await harness.open()

    expect(harness.transport.status).toBe(TransportStatus.Open)
    expect(harness.factory.sockets.length).toBe(1)
    expect(harness.factory.latest.url).toBe(URL)
  })

  it("ignores a second connect while the socket is already open", async () => {
    const harness = createHarness()

    await harness.open()
    harness.transport.connect()
    await drainMicrotasks()

    expect(harness.factory.sockets.length).toBe(1)
  })

  it("sends a client frame once the socket is open", async () => {
    const harness = createHarness()
    await harness.open()

    const sent = harness.transport.send({ kind: "client.ping" })

    expect(sent).toBe(true)
    expect(kinds(harness.factory.latest)).toContain("client.ping")
  })

  it("refuses to send before the socket is open", () => {
    const harness = createHarness({ autoOpen: false })

    harness.transport.connect()

    expect(harness.transport.send({ kind: "client.ping" })).toBe(false)
    expect(harness.factory.latest.sent).toEqual([])
  })

  it("reports a malformed frame instead of acting on it", async () => {
    const harness = createHarness()
    await harness.open()

    harness.factory.latest.receive("not a frame")

    expect(harness.errors.map((error) => error.message)).toEqual([
      "dropped a malformed frame: frame is not JSON: Unexpected token 'o', \"not a frame\" is not valid JSON",
    ])
  })

  it("drops a frame that only a client may send", async () => {
    const harness = createHarness()
    await harness.open()

    harness.factory.latest.receive(
      JSON.stringify({ kind: "client.sync", cursors: [], fromStart: true }),
    )

    expect(harness.errors.at(-1)?.message).toBe(
      "dropped a frame sent in the wrong direction: client.sync",
    )
  })

  it("answers a server ping with a pong that echoes the frame id", async () => {
    const harness = createHarness()
    await harness.open()

    harness.factory.latest.receive(
      JSON.stringify({ kind: "server.ping", id: "server-1" }),
    )

    expect(harness.factory.latest.frames()).toContainEqual({
      kind: "client.pong",
      id: "server-1",
    })
  })
})

describe("ClientTransport sync handshake", () => {
  it("sends the stored cursor in the handshake, not zero", async () => {
    const harness = createHarness({ cursors: { "group-1": 42 } })

    harness.transport.connect()
    await drainMicrotasks()

    expect(harness.factory.latest.frames()).toEqual([
      {
        kind: "client.sync",
        cursors: [{ groupId: "group-1", sequence: 42 }],
        fromStart: false,
        id: "frame-1",
      },
    ])
  })

  it("sends an explicit cold start when the client holds no cursor", async () => {
    const harness = createHarness()

    harness.transport.connect()
    await drainMicrotasks()

    expect(harness.factory.latest.frames()).toEqual([
      { kind: "client.sync", cursors: [], fromStart: true, id: "frame-1" },
    ])
  })

  it("keeps the handshake pending until the server acknowledges it", async () => {
    const harness = createHarness({ cursors: { "group-1": 7 } })
    harness.transport.connect()
    await drainMicrotasks()

    expect(harness.transport.pendingRequests).toBe(1)

    harness.settleHandshake()

    expect(harness.transport.pendingRequests).toBe(0)
    expect(harness.degraded).toEqual([])
  })

  it("decides a hint while the handshake is still unacknowledged", async () => {
    const harness = createHarness({
      cursors: { "group-1": 4 },
      handshakeAckTimeoutMs: 10_000,
      handshakeAttempts: 2,
      // Wide enough that only the handshake could delay the hint.
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 60_000,
    })
    const cursors: number[] = []
    harness.transport.onChange((_hint, outcome) => cursors.push(outcome.cursor))
    harness.transport.connect()
    await drainMicrotasks()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    // The handshake is unanswered and the clock has not moved, yet the hint is decided: cursors are
    // decided in arrival order, not behind an ack that may take ten seconds.
    expect(harness.transport.pendingRequests).toBe(1)
    expect(harness.clock.now()).toBe(0)
    expect(cursors).toEqual([5])
  })

  it("retries an unacknowledged handshake and then reports the sync lane as degraded", async () => {
    const harness = createHarness({
      handshakeAttempts: 2,
      handshakeAckTimeoutMs: 1_000,
      // Wide enough that the heartbeat cannot close the socket inside this test's window.
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 60_000,
    })
    harness.transport.connect()
    await drainMicrotasks()

    await harness.clock.advance(1_000)
    expect(
      kinds(harness.factory.latest).filter((kind) => kind === "client.sync")
        .length,
    ).toBe(2)

    await harness.clock.advance(1_000)

    expect(harness.transport.status).toBe(TransportStatus.Open)
    expect(harness.transport.pendingRequests).toBe(0)
    expect(harness.degraded.length).toBe(1)
    expect(harness.degraded[0]).toBeInstanceOf(AckTimeoutError)
  })
})

describe("ClientTransport gap handling", () => {
  it("pulls a contiguous hint before applying it, and applies it once the pull succeeds", async () => {
    const harness = createHarness({ cursors: { "group-1": 4 } })
    const applied: { sequence: number; cursor: number }[] = []
    harness.transport.onChange((hint, outcome) => {
      applied.push({ sequence: hint.sequence, cursor: outcome.cursor })
    })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    // A contiguous hint carries no payload either, so it costs the same one pull a gap would.
    expect(harness.gaps).toEqual([{ groupId: "group-1", since: 4, received: 5 }])
    expect(applied).toEqual([{ sequence: 5, cursor: 5 }])
    expect(harness.store.cursorFor("group-1")).toBe(5)
  })

  it("does not move the position when the fetch a contiguous hint triggers fails", async () => {
    // Issue #65, finding 1, and #74's done-when: the position must not move when the app's own
    // fetch fails. Before the fix, `cursors.apply` ran on hint arrival, so the cursor moved
    // regardless of whether anything was ever fetched.
    const harness = createHarness({
      cursors: { "group-1": 4 },
      pull: () => {
        throw new Error("fetch failed")
      },
    })
    const applied: unknown[] = []
    harness.transport.onChange((hint, outcome) => applied.push({ hint, outcome }))
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    expect(harness.store.cursorFor("group-1")).toBe(4)
    expect(applied).toEqual([])
    expect(harness.errors.at(-1)?.message).toBe("fetch failed")
  })

  it("applies a hint on a later delivery once its fetch succeeds, after an earlier failure", async () => {
    let fail = true
    const harness = createHarness({
      cursors: { "group-1": 4 },
      pull: () => {
        if (fail) throw new Error("fetch failed")
      },
    })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()
    expect(harness.store.cursorFor("group-1")).toBe(4)

    fail = false
    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    expect(harness.store.cursorFor("group-1")).toBe(5)
  })

  it("requests a pull with the cursor it holds when a frame was missed", async () => {
    const harness = createHarness({ cursors: { "group-1": 4 } })
    let applied = 0
    harness.transport.onChange(() => applied++)
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 9))
    await drainMicrotasks()

    expect(harness.gaps).toEqual([{
      groupId: "group-1",
      since: 4,
      received: 9,
    }])
    expect(applied).toBe(0)
    expect(harness.store.cursorFor("group-1")).toBe(4)
  })

  it("requests the eventual gap's pull from the caught-up cursor, not from the start", async () => {
    const harness = createHarness({ cursors: { "group-1": 1 } })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 2))
    await drainMicrotasks()
    harness.factory.latest.receive(hintFrame("group-1", 3))
    await drainMicrotasks()
    harness.factory.latest.receive(hintFrame("group-1", 8))
    await drainMicrotasks()

    // Each contiguous hint pulled its own single-sequence range and advanced the cursor before the
    // gap arrived, so the gap resumes from 3 — the cursor the client had caught up to — not from 1.
    expect(harness.gaps).toEqual([
      { groupId: "group-1", since: 1, received: 2 },
      { groupId: "group-1", since: 2, received: 3 },
      { groupId: "group-1", since: 3, received: 8 },
    ])
    expect(harness.store.cursorFor("group-1")).toBe(3)
  })

  it("ignores a duplicate hint without pulling", async () => {
    const harness = createHarness({ cursors: { "group-1": 5 } })
    let applied = 0
    harness.transport.onChange(() => applied++)
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    expect(harness.gaps).toEqual([])
    expect(applied).toBe(0)
    expect(harness.store.cursorFor("group-1")).toBe(5)
  })

  it("never regresses the cursor when a stale hint arrives after a newer one", async () => {
    const harness = createHarness({ cursors: { "group-1": 2 } })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 3))
    await drainMicrotasks()
    harness.factory.latest.receive(hintFrame("group-1", 2))
    await drainMicrotasks()

    expect(harness.store.cursorFor("group-1")).toBe(3)
    // The first hint (contiguous) pulled once; the second, now stale against cursor 3, pulled
    // nothing.
    expect(harness.gaps).toEqual([{ groupId: "group-1", since: 2, received: 3 }])
  })

  it("decides hinted changes in arrival order when the cursor store is asynchronous", async () => {
    const harness = createHarness({
      cursorsPort: (store) => ({
        syncRequest: () => store.syncRequest(),
        cursorFor: (groupId) => store.cursorFor(groupId),
        apply: async (change) => {
          await Promise.resolve()
          return store.apply(change)
        },
      }),
    })
    const cursors: number[] = []
    harness.transport.onChange((_hint, outcome) => cursors.push(outcome.cursor))
    await harness.open()

    const socket = harness.factory.latest
    socket.receive(hintFrame("group-1", 1))
    socket.receive(hintFrame("group-1", 2))
    socket.receive(hintFrame("group-1", 3))
    // Each hint now also awaits a cursor peek and a pull before applying, on top of the store's own
    // delay, so three serialised hints need more microtask turns than the default drains.
    await drainMicrotasks(64)

    expect(cursors).toEqual([1, 2, 3])
    expect(harness.gaps).toEqual([
      { groupId: "group-1", since: 0, received: 1 },
      { groupId: "group-1", since: 1, received: 2 },
      { groupId: "group-1", since: 2, received: 3 },
    ])
  })

  it("reports a failed pull instead of retrying the hint", async () => {
    const harness = createHarness({
      cursors: { "group-1": 4 },
      pull: () => {
        throw new Error("pull endpoint unavailable")
      },
    })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 9))
    await drainMicrotasks()

    expect(harness.errors.at(-1)?.message).toBe("pull endpoint unavailable")
    expect(harness.store.cursorFor("group-1")).toBe(4)
  })

  it("records the sync time after a successful pull, so it survives a reload", async () => {
    const harness = createHarness({ cursors: { "group-1": 4 } })
    await harness.open()
    harness.clock.now()

    harness.factory.latest.receive(hintFrame("group-1", 9))
    await drainMicrotasks()

    const afterReload = new PersistentCursorStore({ storage: harness.storage })

    expect(afterReload.syncedAt()).toBe(harness.clock.now())
  })

  it("does not record a sync time when the pull failed", async () => {
    const harness = createHarness({
      cursors: { "group-1": 4 },
      pull: () => {
        throw new Error("pull endpoint unavailable")
      },
    })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 9))
    await drainMicrotasks()

    const afterReload = new PersistentCursorStore({ storage: harness.storage })

    expect(afterReload.syncedAt()).toBeNull()
  })
})

describe("ClientTransport acknowledgements", () => {
  it("resolves a request when the matching ack arrives", async () => {
    const harness = createHarness()
    await harness.open()

    const pending = harness.transport.request({ kind: "client.ping" })
    const id = await lastFrameId(harness)
    harness.factory.latest.receive(
      JSON.stringify({ kind: "server.ack", ackId: id }),
    )

    const acked = await pending

    expect(acked.kind).toBe("server.ack")
    expect(harness.transport.pendingRequests).toBe(0)
  })

  it("retries an unacknowledged frame while attempts remain", async () => {
    const harness = createHarness({ ackTimeoutMs: 500 })
    await harness.open()

    const pending = harness.transport.request({ kind: "client.ping" }, {
      maxAttempts: 2,
    })
    const id = await lastFrameId(harness)

    await harness.clock.advance(500)

    const pings = harness.factory.latest
      .frames()
      .filter((frame) => (frame as { id?: string }).id === id)
    expect(pings.length).toBe(2)

    harness.factory.latest.receive(
      JSON.stringify({ kind: "server.ack", ackId: id }),
    )

    expect((await pending).kind).toBe("server.ack")
  })

  it("surfaces an ack timeout instead of dropping the frame silently", async () => {
    const harness = createHarness({ ackTimeoutMs: 500 })
    await harness.open()

    const error = await captureError(async () => {
      const pending = harness.transport.request({ kind: "client.ping" })
      await harness.clock.advance(500)
      return await pending
    })

    expect(error).toBeInstanceOf(AckTimeoutError)
    expect((error as AckTimeoutError).attempts).toBe(1)
    expect((error as AckTimeoutError).timeoutMs).toBe(500)
    expect(harness.transport.pendingRequests).toBe(0)
    expect(harness.errors.at(-1)).toBeInstanceOf(AckTimeoutError)
  })

  it("fails every outstanding request when the socket closes", async () => {
    const harness = createHarness()
    await harness.open()

    const error = await captureError(async () => {
      const pending = harness.transport.request({ kind: "client.ping" }, {
        timeoutMs: 60_000,
      })
      harness.factory.latest.dropFromPeer()
      return await pending
    })

    expect(error).toBeInstanceOf(ConnectionLostError)
    expect(harness.transport.pendingRequests).toBe(0)
  })
})

describe("ClientTransport heartbeat", () => {
  it("pings on the interval and accepts a pong that arrives in time", async () => {
    const harness = createHarness({
      heartbeatIntervalMs: 1_000,
      pongTimeoutMs: 500,
    })
    await harness.open()

    for (let beat = 0; beat < 3; beat++) {
      await harness.clock.advance(1_000)
      expect(kinds(harness.factory.latest)).toContain("client.ping")
      harness.factory.latest.receive(JSON.stringify({ kind: "server.pong" }))
    }

    expect(harness.errors).toEqual([])
    expect(harness.transport.status).toBe(TransportStatus.Open)
  })

  it("closes the socket and reconnects when no pong arrives", async () => {
    const harness = createHarness({
      heartbeatIntervalMs: 1_000,
      pongTimeoutMs: 500,
    })
    await harness.open()

    await harness.clock.advance(1_500)

    expect(harness.errors.at(-1)).toBeInstanceOf(PongTimeoutError)
    expect(harness.factory.latest.closeCalls.at(-1)).toEqual({
      code: 1001,
      reason: "pong timeout",
    })
    expect(harness.transport.status).toBe(TransportStatus.Reconnecting)

    await harness.clock.advance(100)

    expect(harness.factory.sockets.length).toBe(2)
    expect(harness.transport.status).toBe(TransportStatus.Open)
  })

  it("keeps the original pong deadline instead of re-arming it on every unanswered ping", async () => {
    // #74: this needs a heartbeat interval shorter than the pong timeout, so more than one ping is
    // sent before the deadline — the existing "closes the socket…" test above has the interval
    // longer than the timeout, so only one ping is ever sent and the re-arm guard is never
    // exercised. If `#ping` re-armed the timer on every call instead of only the first, a peer that
    // never answers would never be detected: the deadline would keep sliding forward forever.
    const harness = createHarness({ heartbeatIntervalMs: 100, pongTimeoutMs: 250 })
    await harness.open()

    await harness.clock.advance(300) // pings at t=100, 200 and 300; none answered
    const pings = kinds(harness.factory.latest).filter((kind) => kind === "client.ping").length
    expect(pings).toBeGreaterThanOrEqual(3)
    expect(harness.errors).toEqual([]) // the first ping's deadline (100 + 250 = 350) is not yet due

    await harness.clock.advance(50) // t=350: exactly the first ping's deadline, not the third's

    expect(harness.errors.at(-1)).toBeInstanceOf(PongTimeoutError)
  })

  it("does not let an orphaned pong timer close a later, unrelated reconnection", async () => {
    // If `#ping` re-armed the timer on every call without clearing the previous one, the second and
    // third unanswered pings (at t=200 and t=300) would each leave their own timer running, due at
    // 450 and 550 — after the connection has already failed once and reconnected (the default
    // backoff's base delay puts the reconnect at 350 + 100 = 450). `#handlePongTimeout` reads
    // whatever socket is current, not the one that was open when the timer was armed, so a survivor
    // would spuriously close the reconnected socket too. This test proves none survives: it reaches
    // past both deadlines without answering anything on the reconnected socket, and before that
    // socket's own first heartbeat could legitimately time out on its own (its first ping is not due
    // until t=550, its own deadline not until t=800).
    const harness = createHarness({ heartbeatIntervalMs: 100, pongTimeoutMs: 250 })
    await harness.open()

    await harness.clock.advance(350) // three unanswered pings, then the one real timeout
    expect(harness.errors.length).toBe(1)
    expect(harness.errors[0]).toBeInstanceOf(PongTimeoutError)

    await harness.clock.advance(250) // t=600: past the reconnect and both would-be orphaned deadlines

    expect(harness.errors.length).toBe(1)
    expect(harness.factory.sockets.length).toBe(2) // the original socket, plus its one legitimate reconnect
  })
})

describe("ClientTransport reconnect", () => {
  it("backs off exponentially and then holds at the cap", async () => {
    const harness = createHarness({
      autoOpen: false,
      connectTimeoutMs: 10,
      backoff: { baseMs: 100, factor: 2, maxMs: 400, jitterRatio: 0.5 },
      random: sequenceRandom([1]),
    })

    harness.transport.connect()
    expect(harness.factory.sockets.length).toBe(1)

    await harness.clock.advance(10)
    expect(harness.errors.at(-1)).toBeInstanceOf(ConnectTimeoutError)
    expect(harness.factory.latest.closeCalls.at(-1)?.code).toBe(1001)

    await harness.clock.advance(99)
    expect(harness.factory.sockets.length).toBe(1)
    await harness.clock.advance(1)
    expect(harness.factory.sockets.length).toBe(2)

    await harness.clock.advance(10 + 199)
    expect(harness.factory.sockets.length).toBe(2)
    await harness.clock.advance(1)
    expect(harness.factory.sockets.length).toBe(3)

    await harness.clock.advance(10 + 399)
    expect(harness.factory.sockets.length).toBe(3)
    await harness.clock.advance(1)
    expect(harness.factory.sockets.length).toBe(4)

    // The next delay would be 800ms uncapped; the cap holds it at 400ms.
    await harness.clock.advance(10 + 399)
    expect(harness.factory.sockets.length).toBe(4)
    await harness.clock.advance(1)
    expect(harness.factory.sockets.length).toBe(5)
  })

  it("shortens the wait by the jitter floor and never waits longer than the cap", async () => {
    const quiet = createHarness({ random: sequenceRandom([0]) })
    await quiet.open()
    quiet.factory.latest.dropFromPeer()

    await quiet.clock.advance(49)
    expect(quiet.factory.sockets.length).toBe(1)
    await quiet.clock.advance(1)
    expect(quiet.factory.sockets.length).toBe(2)

    expect(nextBackoffDelay({ attempt: 9, random: () => 1, maxMs: 400 })).toBe(
      400,
    )
  })

  it("does not reconnect after the transport has been stopped", async () => {
    const harness = createHarness({ autoOpen: false, connectTimeoutMs: 10 })
    harness.transport.connect()

    harness.transport.stop()
    await harness.clock.advance(10_000)

    expect(harness.transport.status).toBe(TransportStatus.Stopped)
    expect(harness.factory.sockets.length).toBe(1)
    expect(harness.clock.pendingTimers).toBe(0)
  })

  it("stops reconnecting when the auth gate refuses", async () => {
    let calls = 0
    const harness = createHarness({
      gate: () => {
        calls += 1
        return { allowed: false, reason: "session expired" }
      },
    })
    await harness.open()

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100)

    expect(calls).toBe(1)
    expect(harness.errors.at(-1)).toBeInstanceOf(AuthGateError)
    expect(harness.transport.status).toBe(TransportStatus.Stopped)

    await harness.clock.advance(10_000)
    expect(harness.factory.sockets.length).toBe(1)
  })

  it("retries a gate that threw instead of treating the failure as consent", async () => {
    let calls = 0
    const harness = createHarness({
      gate: () => {
        calls += 1
        if (calls === 1) throw new Error("auth endpoint unreachable")
        return { allowed: true }
      },
    })
    await harness.open()

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100)

    expect(harness.errors.at(-1)?.message).toBe("auth endpoint unreachable")
    expect(harness.transport.status).toBe(TransportStatus.Reconnecting)
    expect(harness.factory.sockets.length).toBe(1)

    await harness.clock.advance(200)

    expect(calls).toBe(2)
    expect(harness.factory.sockets.length).toBe(2)
    expect(harness.transport.status).toBe(TransportStatus.Open)
  })

  it("asks the gate before every reconnect attempt", async () => {
    let calls = 0
    const harness = createHarness({
      autoOpen: false,
      connectTimeoutMs: 10,
      gate: () => {
        calls += 1
        return { allowed: true }
      },
    })
    harness.transport.connect()

    await harness.clock.advance(10 + 100)
    await harness.clock.advance(10 + 200)

    expect(calls).toBe(2)
  })

  it("keeps the backoff climbing when the peer accepts and drops before any message arrives", async () => {
    // Issue #65, finding 3: a server that accepts a connection and closes it immediately used to
    // reset the attempt counter the moment the socket opened, so every reconnect delay stayed at
    // the base value — a storm of attempts roughly twice a second forever. No jitter here so every
    // delay is the exact, deterministic `baseMs * factor ** attempt`.
    const harness = createHarness({
      backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitterRatio: 0 },
      random: sequenceRandom([0]),
    })
    harness.transport.connect()
    await drainMicrotasks()
    expect(harness.factory.sockets.length).toBe(1)

    harness.factory.latest.dropFromPeer() // accepted, then dropped: no message ever arrived
    await harness.clock.advance(100) // attempt 0's delay
    expect(harness.factory.sockets.length).toBe(2)

    harness.factory.latest.dropFromPeer() // dropped again, still with no message
    await harness.clock.advance(100)
    // The buggy behaviour would have reset the attempt to 0 on the open above, so 100ms would be
    // enough again here and a third socket would already exist. The fix keeps attempt at 1, so the
    // delay is 200ms and nothing has happened yet.
    expect(harness.factory.sockets.length).toBe(2)

    await harness.clock.advance(100) // 200ms total since the second drop: now it is due
    expect(harness.factory.sockets.length).toBe(3)
  })

  it("resets the backoff once a message has arrived and the socket stayed open long enough", async () => {
    // "Proven" needs both conditions, not just a message (the reviewer's finding on the previous
    // head of this branch: a peer that sends one frame and drops still reset the counter for free).
    // `minHealthyMs` defaults to `backoff.baseMs`, so 100ms here.
    const harness = createHarness({
      backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitterRatio: 0 },
      random: sequenceRandom([0]),
    })
    harness.transport.connect()
    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100) // second socket opens; still no message, so attempt stays at 1

    expect(harness.factory.sockets.length).toBe(2)

    harness.factory.latest.receive(JSON.stringify({ kind: "server.ping" })) // one condition met
    await harness.clock.advance(100) // the other condition — minHealthyMs open — is now met too

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100) // back at the base delay, not the doubled one

    expect(harness.factory.sockets.length).toBe(3)
  })

  it("keeps the backoff climbing when the peer sends one frame and drops every attempt", async () => {
    // Issue #65, finding 3, the residual the reviewer found: resetting on the message alone let a
    // peer that sends a single byte before dropping reset the counter for free, every time, so the
    // delay never grew past the base value. Requiring the socket to also have stayed open for
    // `minHealthyMs` defeats it, because the drop always arrives before that deadline.
    const harness = createHarness({
      backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitterRatio: 0 },
      random: sequenceRandom([0]),
    })
    const dropWithOneFrame = () => {
      harness.factory.latest.receive(JSON.stringify({ kind: "server.ping" }))
      harness.factory.latest.dropFromPeer()
    }

    harness.transport.connect()
    dropWithOneFrame() // the first connection: one frame, then dropped, with no time elapsed
    await harness.clock.advance(100) // attempt 0's delay
    expect(harness.factory.sockets.length).toBe(2)

    dropWithOneFrame()
    await harness.clock.advance(100)
    // Resetting on the message alone would have put attempt back at 0 here, so 100ms would be
    // enough again and a third socket would already exist. Requiring minHealthyMs too keeps attempt
    // at 1, so the delay has doubled to 200ms and nothing has happened yet.
    expect(harness.factory.sockets.length).toBe(2)

    await harness.clock.advance(100) // 200ms total since the second drop: now it is due
    expect(harness.factory.sockets.length).toBe(3)
  })
})

describe("ClientTransport reconnect fetches what was missed", () => {
  it("pulls every held cursor once after a reconnect, not on the first connect", async () => {
    // Issue #65, finding 2: a quiet group's gap used to surface only when a later hint happened to
    // reveal it, which in a quiet group might be never. A reconnect now pulls unconditionally.
    const harness = createHarness({ cursors: { "group-1": 4, "group-2": 7 } })
    await harness.open()
    expect(harness.gaps).toEqual([]) // the first connect pulls nothing on its own

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100)
    await drainMicrotasks()

    expect(harness.gaps).toEqual([
      { groupId: "group-1", since: 4, received: 4 },
      { groupId: "group-2", since: 7, received: 7 },
    ])
  })

  it("triggers exactly one fetch when a single-group client reconnects once", async () => {
    const harness = createHarness({ cursors: { "group-1": 4 } })
    await harness.open()

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100)
    await drainMicrotasks()

    expect(harness.factory.sockets.length).toBe(2) // exactly one reconnect
    expect(harness.gaps.length).toBe(1) // exactly one fetch
  })

  it("pulls nothing after a reconnect for a cold client that holds no cursor yet", async () => {
    const harness = createHarness()
    await harness.open()

    harness.factory.latest.dropFromPeer()
    await harness.clock.advance(100)
    await drainMicrotasks()

    expect(harness.gaps).toEqual([])
  })
})

describe("ClientTransport shutdown", () => {
  it("clears every timer and closes the socket on stop", async () => {
    const harness = createHarness()
    await harness.open()
    await harness.clock.advance(1_000)

    harness.transport.stop()

    expect(harness.transport.status).toBe(TransportStatus.Stopped)
    expect(harness.factory.latest.closeCalls.at(-1)).toEqual({
      code: 1000,
      reason: "client stop",
    })
    expect(harness.clock.pendingTimers).toBe(0)
  })

  it("refuses a request after stop instead of pretending it was sent", async () => {
    const harness = createHarness()
    await harness.open()
    harness.transport.stop()

    const error = await captureError(() => harness.transport.request({ kind: "client.ping" }))

    expect(error).toBeInstanceOf(ConnectionLostError)
  })

  it("reports the attempt counter and the last error in the status snapshot", async () => {
    const harness = createHarness({ autoOpen: false, connectTimeoutMs: 10 })
    const snapshots: number[] = []
    harness.transport.onStatus((snapshot) => snapshots.push(snapshot.attempt))

    harness.transport.connect()
    await harness.clock.advance(10 + 100)

    const snapshot = harness.transport.statusSnapshot
    expect(snapshot.attempt).toBe(1)
    expect(snapshot.lastError).toContain("did not open within 10ms")
    expect(snapshots.length).toBeGreaterThan(0)
  })
})

/** Id of the newest frame the client sent. */
async function lastFrameId(harness: Harness): Promise<string> {
  await drainMicrotasks()
  const frames = harness.factory.latest.frames() as { id?: string }[]
  const id = frames.at(-1)?.id
  if (!id) throw new Error("the client has not sent a frame with an id")
  return id
}
