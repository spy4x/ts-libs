/**
 * Registry behaviour: many sockets per user, verified liveness, orphan cleanup, fan-out.
 *
 * Every case runs against a fake socket and a fake clock, so the heartbeat, the liveness deadline
 * and the reap path are asserted exactly rather than approximately.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import type { ServerMessage } from "./codec.ts"
import {
  CloseReason,
  ConnectionRegistry,
  type ConnectionRegistryOptions,
  type RegistryCloseInfo,
} from "./registry.ts"
import { RealtimeRequestError } from "./errors.ts"
import { type RequestContext } from "./registry.ts"
import { SocketState } from "./socket-port.ts"
import { drainMicrotasks, FakeClock, FakeSocketFactory } from "./testing.ts"

const HEARTBEAT_INTERVAL_MS = 1_000
const LIVENESS_TIMEOUT_MS = 3_000

interface Harness {
  clock: FakeClock
  factory: FakeSocketFactory
  registry: ConnectionRegistry
}

function createHarness(
  autoOpen = true,
  registryOptions: Partial<ConnectionRegistryOptions> = {},
): Harness {
  const clock = new FakeClock()
  const factory = new FakeSocketFactory({ autoOpen })
  const registry = new ConnectionRegistry({
    clock,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    livenessTimeoutMs: LIVENESS_TIMEOUT_MS,
    ...registryOptions,
  })
  return { clock, factory, registry }
}

function pingFrame(id?: string): string {
  return JSON.stringify(
    id === undefined ? { kind: "client.ping" } : { kind: "client.ping", id },
  )
}

describe("ConnectionRegistry", () => {
  it("keeps one entry per socket for a user with two connected devices", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    expect(registry.connectionsFor("user-1")).toBe(2)
    expect(registry.count()).toBe(2)
    expect(registry.userIds()).toEqual(["user-1"])
  })

  it("fires the open handler once per socket", () => {
    const { registry, factory } = createHarness()
    const opened: string[] = []
    registry.onOpen((handle) => opened.push(`${handle.userId}:${handle.id}`))

    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    expect(opened).toEqual(["user-1:socket-1", "user-1:socket-2"])
  })

  it("fires the open handler once when the socket is still connecting", () => {
    const { registry, factory } = createHarness(false)
    let opens = 0
    registry.onOpen(() => opens++)
    const socket = factory.open("wss://api.example.test/ws")
    registry.attach("user-1", socket)

    expect(opens).toBe(0)
    socket.openFromPeer()
    socket.openFromPeer()

    expect(opens).toBe(1)
  })

  it("delivers to every socket of one user", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    const delivered = registry.sendToUser("user-1", { kind: "server.ping" })

    expect(delivered).toBe(2)
    expect(factory.sockets.map((socket) => socket.frames())).toEqual([
      [{ kind: "server.ping" }],
      [{ kind: "server.ping" }],
    ])
  })

  it("delivers nothing to a user with no socket", () => {
    const { registry } = createHarness()

    expect(registry.sendToUser("user-404", { kind: "server.ping" })).toBe(0)
  })

  it("delivers to each listed user once, even when the list repeats one", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-2", factory.open("wss://api.example.test/ws"))

    const delivered = registry.sendToUsers(["user-1", "user-1", "user-2"], {
      kind: "server.ping",
    })

    expect(delivered).toBe(2)
  })

  it("ignores a socket id that is not registered", () => {
    const { registry } = createHarness()

    expect(registry.send("socket-404", { kind: "server.ping" })).toBe(false)
  })

  it("answers a client ping with a pong that echoes the frame id", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(pingFrame("frame-9"))

    expect(factory.latest.frames()).toEqual([{
      kind: "server.pong",
      id: "frame-9",
    }])
  })

  it("drops a client frame that is not protocol without answering it", () => {
    const { registry, factory } = createHarness()
    const malformed: string[] = []
    registry.onMalformedFrame((frame) => malformed.push(frame.reason))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive("not json at all")

    expect(factory.latest.sent).toEqual([])
    expect(malformed.length).toBe(1)
  })

  it("drops a server frame that a client sent instead of dispatching it", () => {
    const { registry, factory } = createHarness()
    const malformed: string[] = []
    const frames: string[] = []
    registry.onMalformedFrame((frame) => malformed.push(frame.reason))
    registry.onFrame((context) => frames.push(context.message.kind))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(
      JSON.stringify({
        kind: "change.hint",
        groupId: "group-1",
        aggregate: "invoice",
        sequence: 4,
      }),
    )

    expect(frames).toEqual([])
    expect(malformed).toEqual(['frame kind "change.hint" is server-to-client'])
  })

  it("hands a sync handshake to the frame handler with the user it belongs to", () => {
    const { registry, factory } = createHarness()
    const seen: unknown[] = []
    registry.onFrame((context) => seen.push({ userId: context.userId, message: context.message }))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(
      JSON.stringify({
        kind: "client.sync",
        cursors: [{ groupId: "group-1", sequence: 41 }],
        fromStart: false,
      }),
    )

    expect(seen).toEqual([
      {
        userId: "user-1",
        message: {
          kind: "client.sync",
          cursors: [{ groupId: "group-1", sequence: 41 }],
          fromStart: false,
        },
      },
    ])
  })

  it("reaps a socket that is silent past the liveness deadline", async () => {
    const { clock, factory, registry } = createHarness()
    const closed: RegistryCloseInfo[] = []
    registry.onClose((_handle, info) => closed.push(info))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    await clock.advance(LIVENESS_TIMEOUT_MS)

    expect(registry.count()).toBe(0)
    expect(registry.userIds()).toEqual([])
    expect(closed.map((info) => info.reason)).toEqual([
      CloseReason.LivenessTimeout,
    ])
    expect(factory.latest.closeCalls.at(-1)?.code).toBe(1001)
  })

  it("keeps a socket that answers every ping", async () => {
    const { clock, factory, registry } = createHarness()
    const socket = factory.open("wss://api.example.test/ws")
    registry.attach("user-1", socket)
    socket.onMessage(() => {})

    for (let beat = 0; beat < 4; beat++) {
      await clock.advance(HEARTBEAT_INTERVAL_MS)
      socket.receive(JSON.stringify({ kind: "client.pong" }))
    }

    expect(registry.count()).toBe(1)
    expect(
      socket.frames().filter((frame) => isKind(frame, "server.ping")).length,
    ).toBe(4)
  })

  it("counts any inbound frame as liveness evidence", async () => {
    const { clock, factory, registry } = createHarness()
    const socket = factory.open("wss://api.example.test/ws")
    registry.attach("user-1", socket)

    for (let beat = 0; beat < 3; beat++) {
      await clock.advance(HEARTBEAT_INTERVAL_MS)
      socket.receive(pingFrame())
    }

    expect(registry.count()).toBe(1)
    expect(registry.sendToUser("user-1", { kind: "server.ping" })).toBe(1)
  })

  it("keeps fanning out to the other sockets when one throws on send", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-2", factory.open("wss://api.example.test/ws"))
    const first = factory.sockets[0]
    const second = factory.sockets[1]
    first.failNextSend(new Error("socket is dead"))

    const delivered = registry.sendToAll({ kind: "server.ping" })

    expect(delivered).toBe(1)
    expect(second.frames()).toEqual([{ kind: "server.ping" }])
    expect(registry.count()).toBe(1)
    expect(registry.userIds()).toEqual(["user-2"])
  })

  it("reports a send failure as the reap reason and does not reap the socket twice", () => {
    const { registry, factory } = createHarness()
    const closed: RegistryCloseInfo[] = []
    registry.onClose((_handle, info) => closed.push(info))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const socket = factory.latest
    socket.failNextSend(new Error("write failed"))

    socket.receive(pingFrame())
    socket.dropFromPeer()

    expect(closed).toEqual([
      { reason: CloseReason.SendFailed, code: 1001, detail: "write failed" },
    ])
    expect(registry.count()).toBe(0)
  })

  it("reports the peer's own close code when the peer closed", () => {
    const { registry, factory } = createHarness()
    const closed: RegistryCloseInfo[] = []
    registry.onClose((_handle, info) => closed.push(info))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.dropFromPeer(1006)

    expect(closed).toEqual([
      { reason: CloseReason.Remote, code: 1006, detail: "connection lost" },
    ])
  })

  it("removes only the socket that closed, not the user's other devices", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.sockets[0].dropFromPeer()

    expect(registry.count()).toBe(1)
    expect(registry.connectionsFor("user-1")).toBe(1)
    expect(registry.sendToUser("user-1", { kind: "server.ping" })).toBe(1)
  })

  it("stops the heartbeat once the last socket leaves", async () => {
    const { clock, factory, registry } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    expect(clock.pendingTimers).toBe(1)

    factory.latest.dropFromPeer()

    expect(clock.pendingTimers).toBe(0)
    await clock.advance(10 * HEARTBEAT_INTERVAL_MS)
    expect(clock.pendingTimers).toBe(0)
  })

  it("closes every socket and leaves no timer on shutdown", async () => {
    const { clock, factory, registry } = createHarness()
    const closed: RegistryCloseInfo[] = []
    registry.onClose((_handle, info) => closed.push(info))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    registry.attach("user-2", factory.open("wss://api.example.test/ws"))

    registry.shutdown()

    expect(registry.count()).toBe(0)
    expect(registry.userIds()).toEqual([])
    expect(closed.map((info) => info.reason)).toEqual([
      CloseReason.Shutdown,
      CloseReason.Shutdown,
    ])
    // A real socket's close is asynchronous — `state` is `Closing` right after `close()` is called,
    // and only reaches `Closed` once the closing handshake finishes (#74; `FakeSocket` used to close
    // synchronously, which this suite never had a reason to catch).
    await drainMicrotasks()
    expect(
      factory.sockets.every((socket) => socket.state === SocketState.Closed),
    ).toBe(true)
    expect(clock.pendingTimers).toBe(0)
  })

  it("does not send to a socket that is not open", () => {
    const { registry, factory } = createHarness(false)
    const socket = factory.open("wss://api.example.test/ws")
    registry.attach("user-1", socket)

    expect(registry.sendToUser("user-1", { kind: "server.ping" })).toBe(0)
    expect(socket.sent).toEqual([])

    socket.openFromPeer()

    expect(registry.sendToUser("user-1", { kind: "server.ping" })).toBe(1)
  })

  it("ignores frames that arrive after the socket was reaped", () => {
    const { registry, factory } = createHarness()
    const malformed: string[] = []
    registry.onMalformedFrame((frame) => malformed.push(frame.reason))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const socket = factory.latest

    socket.failNextSend(new Error("write failed"))
    socket.receive(pingFrame())

    expect(registry.count()).toBe(0)

    socket.receive("still not json")

    expect(malformed).toEqual([])
    expect(socket.sent).toEqual([])
  })
})

describe("ConnectionRegistry limits", () => {
  it("refuses a socket once a user is at the connection cap", () => {
    // Issue #65, finding 5: one user id was measured holding 50 000 sockets.
    const { registry, factory } = createHarness(true, { maxConnectionsPerUser: 2 })

    const first = registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const second = registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const third = registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(third).toBeNull()
    expect(registry.connectionsFor("user-1")).toBe(2)
    expect(factory.sockets[2]?.closeCalls).toEqual([{
      code: 1013,
      reason: "too many connections for this user (max 2)",
    }])
  })

  it("does not count a refused socket against another user's cap", () => {
    const { registry, factory } = createHarness(true, { maxConnectionsPerUser: 1 })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    const forOther = registry.attach("user-2", factory.open("wss://api.example.test/ws"))

    expect(forOther).not.toBeNull()
    expect(registry.connectionsFor("user-2")).toBe(1)
  })

  it("frees a slot once a capped user's socket disconnects", () => {
    const { registry, factory } = createHarness(true, { maxConnectionsPerUser: 1 })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    expect(registry.attach("user-1", factory.open("wss://api.example.test/ws"))).toBeNull()

    factory.sockets[0].dropFromPeer()

    expect(registry.attach("user-1", factory.open("wss://api.example.test/ws"))).not.toBeNull()
  })

  it("reaps a connection whose frame exceeds the message size limit, without decoding it", () => {
    // Issue #65, finding 5: a single 6.9 MB message was decoded and validated, costing 81 ms of CPU
    // it should never have spent. `maxMessageBytes` measures the frame before the codec ever runs.
    const { registry, factory } = createHarness(true, { maxMessageBytes: 16 })
    const malformed: string[] = []
    const closed: RegistryCloseInfo[] = []
    registry.onMalformedFrame((frame) => malformed.push(frame.reason))
    registry.onClose((_handle, info) => closed.push(info))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    // Well-formed JSON, but longer than the 16 byte limit configured above.
    factory.latest.receive(pingFrame("a-very-long-frame-id"))

    expect(registry.count()).toBe(0)
    expect(malformed.length).toBe(1)
    expect(malformed[0]).toContain("exceeds the 16 byte limit")
    expect(closed.length).toBe(1)
    expect(closed[0]?.reason).toBe(CloseReason.MessageTooLarge)
    expect(closed[0]?.code).toBe(1009)
    expect(closed[0]?.detail).toContain("exceeds the 16 byte limit")
  })

  it("still accepts a frame at or under the message size limit", () => {
    const { registry, factory } = createHarness(true, { maxMessageBytes: 1_024 })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(pingFrame("frame-1"))

    expect(registry.count()).toBe(1)
    expect(factory.latest.frames()).toEqual([{ kind: "server.pong", id: "frame-1" }])
  })

  it("skips delivery to a socket whose peer has stopped draining it, without reaping it", () => {
    // Issue #65, finding 5: nothing previously slowed delivery to a client that was not reading.
    // Skipping a hint is safe the same way a dropped one always is — the client notices the gap
    // itself and pulls — so this must not tear the connection down.
    const { registry, factory } = createHarness(true, { maxBufferedBytes: 1_000 })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    factory.latest.setBufferedAmount(2_000)

    const delivered = registry.sendToUser("user-1", { kind: "server.ping" })

    expect(delivered).toBe(0)
    expect(factory.latest.sent).toEqual([])
    expect(registry.count()).toBe(1)
  })

  it("delivers again once a backed-up socket's buffer drains below the limit", () => {
    const { registry, factory } = createHarness(true, { maxBufferedBytes: 1_000 })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    factory.latest.setBufferedAmount(2_000)
    registry.sendToUser("user-1", { kind: "server.ping" })

    factory.latest.setBufferedAmount(0)
    const delivered = registry.sendToUser("user-1", { kind: "server.ping" })

    expect(delivered).toBe(1)
    expect(factory.latest.frames()).toEqual([{ kind: "server.ping" }])
  })
})

function commandFrame(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "client.command", id, name: "group.rename", ...extra })
}

function queryFrame(id: string): string {
  return JSON.stringify({ kind: "client.query", id, name: "group.list", payload: { page: 1 } })
}

describe("ConnectionRegistry request frames", () => {
  it("hands a command to the dispatcher with its name, payload, user and idempotency key", () => {
    const { registry, factory } = createHarness()
    const seen: RequestContext[] = []
    registry.onRequest((context) => {
      seen.push(context)
      return null
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(commandFrame("r1", { payload: { title: "Trip" }, idempotencyKey: "k1" }))
    factory.latest.receive(queryFrame("r2"))

    expect(seen.map((c) => [c.kind, c.requestId, c.name, c.userId, c.idempotencyKey])).toEqual([
      ["command", "r1", "group.rename", "user-1", "k1"],
      ["query", "r2", "group.list", "user-1", undefined],
    ])
    expect(seen[0].payload).toEqual({ title: "Trip" })
  })

  it("answers with a result carrying the dispatcher's return value, correlated by request id", async () => {
    const { registry, factory } = createHarness()
    registry.onRequest((context) => ({ echoed: context.name }))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(commandFrame("r1"))
    await drainMicrotasks()

    expect(factory.latest.frames()).toEqual([
      { kind: "server.result", requestId: "r1", payload: { echoed: "group.rename" } },
    ])
  })

  it("answers with the typed code a dispatcher throws", async () => {
    const { registry, factory } = createHarness()
    registry.onRequest(() => {
      throw new RealtimeRequestError("conflict", "stale version", { expected: 3 })
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(commandFrame("r1"))
    await drainMicrotasks()

    expect(factory.latest.frames()).toEqual([
      {
        kind: "server.error",
        requestId: "r1",
        code: "conflict",
        message: "stale version",
        details: { expected: 3 },
      },
    ])
  })

  it("answers an unexpected exception as internal without leaking its text", async () => {
    const errors: unknown[] = []
    const { registry, factory } = createHarness(true, {
      onRequestError: (error) => errors.push(error),
    })
    registry.onRequest(() => Promise.reject(new Error("password=hunter2 in SQL")))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    await drainMicrotasks()

    expect(factory.latest.sent.join("")).not.toContain("hunter2")
    expect(factory.latest.frames()).toEqual([
      { kind: "server.error", requestId: "r1", code: "internal", message: "internal error" },
    ])
    expect((errors[0] as Error).message).toContain("hunter2")
  })

  it("refuses a request beyond the in-flight limit with rate_limited and serves it after one finishes", async () => {
    const { registry, factory } = createHarness(true, { maxInFlightRequests: 2 })
    const release: (() => void)[] = []
    registry.onRequest(() => new Promise<void>((resolve) => release.push(resolve)))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    factory.latest.receive(queryFrame("r2"))
    factory.latest.receive(queryFrame("r3"))

    expect(factory.latest.frames()).toEqual([
      {
        kind: "server.error",
        requestId: "r3",
        code: "rate_limited",
        message: "too many requests in flight (max 2)",
      },
    ])
    expect(registry.inFlightRequests("socket-1")).toBe(2)

    release[0]()
    await drainMicrotasks()
    expect(registry.inFlightRequests("socket-1")).toBe(1)

    factory.latest.receive(queryFrame("r4"))
    expect(release.length).toBe(3)
  })

  it("counts the in-flight limit per connection, not per user", () => {
    const { registry, factory } = createHarness(true, { maxInFlightRequests: 1 })
    let dispatched = 0
    registry.onRequest(() => {
      dispatched++
      return new Promise(() => {})
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const first = factory.latest
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    const second = factory.latest

    first.receive(queryFrame("r1"))
    second.receive(queryFrame("r1"))

    expect(dispatched).toBe(2)
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual([])
  })

  it("refuses a request id that is already in flight without running it twice", () => {
    const { registry, factory } = createHarness()
    let dispatched = 0
    registry.onRequest(() => {
      dispatched++
      return new Promise(() => {})
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    factory.latest.receive(queryFrame("r1"))

    expect(dispatched).toBe(1)
    expect((factory.latest.frames()[0] as { code: string }).code).toBe("bad_request")
  })

  it("answers timeout and drops the late result when the dispatcher outlives the deadline", async () => {
    const { registry, factory, clock } = createHarness(true, { requestTimeoutMs: 500 })
    let finish: (value: string) => void = () => {}
    let signal: AbortSignal | undefined
    registry.onRequest((context) => {
      signal = context.signal
      return new Promise<string>((resolve) => (finish = resolve))
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    await clock.advance(500)

    expect((factory.latest.frames()[0] as { code: string }).code).toBe("timeout")
    expect(signal?.aborted).toBe(true)
    expect(registry.inFlightRequests("socket-1")).toBe(0)

    finish("late")
    await drainMicrotasks()
    expect(factory.latest.frames().length).toBe(1)
  })

  it("aborts in-flight requests and sends nothing when the connection closes", async () => {
    const { registry, factory } = createHarness()
    let signal: AbortSignal | undefined
    let finish: (value: string) => void = () => {}
    registry.onRequest((context) => {
      signal = context.signal
      return new Promise<string>((resolve) => (finish = resolve))
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    factory.latest.receive(queryFrame("r1"))

    factory.latest.dropFromPeer()
    finish("too late")
    await drainMicrotasks()

    expect(signal?.aborted).toBe(true)
    expect(factory.latest.sent).toEqual([])
    expect(registry.inFlightRequests("socket-1")).toBe(0)
  })

  it("answers internal when a typed error cannot be encoded", async () => {
    const { registry, factory } = createHarness()
    registry.onRequest(() => {
      throw new RealtimeRequestError("conflict", "x".repeat(2_000))
    })
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    await drainMicrotasks()

    expect(factory.latest.frames()).toEqual([
      { kind: "server.error", requestId: "r1", code: "internal", message: "internal error" },
    ])
  })

  it("answers a malformed request frame that has a readable id with bad_request", () => {
    const { registry, factory } = createHarness()
    registry.onRequest(() => null)
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(JSON.stringify({ kind: "client.query", id: "r9", name: "" }))

    const [frame] = factory.latest.frames() as { requestId: string; code: string }[]
    expect(factory.latest.frames().length).toBe(1)
    expect([frame.requestId, frame.code]).toEqual(["r9", "bad_request"])
  })

  it("only reports, and sends nothing, for a malformed frame without a usable id", () => {
    const { registry, factory } = createHarness()
    const reasons: string[] = []
    registry.onMalformedFrame((frame) => reasons.push(frame.reason))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(JSON.stringify({ kind: "client.query", name: "n" }))
    factory.latest.receive(JSON.stringify({ kind: "client.query", id: 7, name: "n" }))
    factory.latest.receive(JSON.stringify({ kind: "client.ping", id: 7 }))
    factory.latest.receive(JSON.stringify({ kind: "client.ping", id: "p1", extra: 1 }))

    expect(reasons.length).toBe(4)
    expect(factory.latest.sent).toEqual([])
  })

  it("times a request out after 10 seconds by default", async () => {
    const { registry, factory, clock } = createHarness(true, {
      heartbeatIntervalMs: 100_000,
      livenessTimeoutMs: 200_000,
    })
    registry.onRequest(() => new Promise(() => {}))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))
    factory.latest.receive(queryFrame("r1"))

    const errors = () => factory.latest.frames().filter((f) => isKind(f, "server.error"))
    await clock.advance(9_999)
    expect(errors()).toEqual([])
    await clock.advance(1)

    expect((errors()[0] as { code: string }).code).toBe("timeout")
  })

  it("treats a request timeout below 1 ms as 1 ms instead of answering at once", async () => {
    const { registry, factory, clock } = createHarness(true, { requestTimeoutMs: -5 })
    registry.onRequest(() => new Promise(() => {}))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    const errors = () => factory.latest.frames().filter((f) => isKind(f, "server.error"))
    await clock.advance(0)
    expect(errors()).toEqual([])
    await clock.advance(1)

    expect((errors()[0] as { code: string }).code).toBe("timeout")
  })

  it("answers not_found when no dispatcher is registered", () => {
    const { registry, factory } = createHarness()
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))

    expect((factory.latest.frames()[0] as { code: string }).code).toBe("not_found")
  })

  it("answers internal instead of staying silent when the result cannot be encoded", async () => {
    const { registry, factory } = createHarness()
    registry.onRequest(() => ({ big: 10n }))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(queryFrame("r1"))
    await drainMicrotasks()

    expect(factory.latest.frames()).toEqual([
      { kind: "server.error", requestId: "r1", code: "internal", message: "internal error" },
    ])
  })

  it("refuses a second dispatcher and lets a new one register after unsubscribe", () => {
    const { registry } = createHarness()
    const off = registry.onRequest(() => null)

    expect(() => registry.onRequest(() => null)).toThrow("already registered")
    off()
    expect(() => registry.onRequest(() => null)).not.toThrow()
  })

  it("still treats a server-only frame from a client as malformed", () => {
    const { registry, factory } = createHarness()
    const reasons: string[] = []
    registry.onMalformedFrame((frame) => reasons.push(frame.reason))
    registry.attach("user-1", factory.open("wss://api.example.test/ws"))

    factory.latest.receive(JSON.stringify({ kind: "server.result", requestId: "r1" }))

    expect(reasons.length).toBe(1)
  })
})

function isKind(frame: unknown, kind: string): boolean {
  return typeof frame === "object" && frame !== null &&
    (frame as ServerMessage).kind === kind
}
