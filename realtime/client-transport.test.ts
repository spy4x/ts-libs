/**
 * Client transport: handshake cursors, gap fallback, acks, heartbeat, backoff, gate.
 *
 * Every case is driven by `FakeClock` and `FakeSocket` — no sleep, no network, no `--allow-net`.
 * The two cases that matter most are the ones ADR 002 is built on: the handshake advertises the
 * cursor the client actually holds (not a hardcoded `0`), and a hint that is not contiguous with
 * that cursor produces a REST pull instead of being applied.
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
  it("applies a hint contiguous with the cursor and fans it out", async () => {
    const harness = createHarness({ cursors: { "group-1": 4 } })
    const applied: { sequence: number; cursor: number }[] = []
    harness.transport.onChange((hint, outcome) => {
      applied.push({ sequence: hint.sequence, cursor: outcome.cursor })
    })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 5))
    await drainMicrotasks()

    expect(applied).toEqual([{ sequence: 5, cursor: 5 }])
    expect(harness.gaps).toEqual([])
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

  it("requests a pull from the cursor after a contiguous run, not from the start", async () => {
    const harness = createHarness({ cursors: { "group-1": 1 } })
    await harness.open()

    harness.factory.latest.receive(hintFrame("group-1", 2))
    await drainMicrotasks()
    harness.factory.latest.receive(hintFrame("group-1", 3))
    await drainMicrotasks()
    harness.factory.latest.receive(hintFrame("group-1", 8))
    await drainMicrotasks()

    expect(harness.gaps).toEqual([{
      groupId: "group-1",
      since: 3,
      received: 8,
    }])
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
    expect(harness.gaps).toEqual([])
  })

  it("decides hinted changes in arrival order when the cursor store is asynchronous", async () => {
    const harness = createHarness({
      cursorsPort: (store) => ({
        syncRequest: () => store.syncRequest(),
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
    await drainMicrotasks()

    expect(cursors).toEqual([1, 2, 3])
    expect(harness.gaps).toEqual([])
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
