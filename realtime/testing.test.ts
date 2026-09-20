/**
 * `FakeSocket`'s own contract: it stands in for a real `WebSocket` in every other suite in this
 * package (and in a host's own tests, via `@ts-libs/realtime/testing`), so a difference from the
 * real thing here is a difference every test built on it inherits silently.
 *
 * `close()` closing asynchronously is the one case #74 named directly: "a real socket closes
 * asynchronously" — `state` moves to `Closing` immediately and only reaches `Closed`, and fires the
 * close handlers, on a later microtask. Before this fix `close()` transitioned straight to `Closed`
 * and fired the handlers synchronously, so a caller that awaited nothing after `close()` never saw
 * `Closing`, and a bug that depended on the real async gap could not be reproduced here at all.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { SocketState } from "./socket-port.ts"
import { drainMicrotasks, FakeSocket } from "./testing.ts"

describe("FakeSocket close", () => {
  it("moves to Closing immediately and only reaches Closed on a later microtask", async () => {
    const socket = new FakeSocket("wss://api.example.test/ws")
    socket.openFromPeer()

    socket.close(1000, "done")

    expect(socket.state).toBe(SocketState.Closing)

    await drainMicrotasks()

    expect(socket.state).toBe(SocketState.Closed)
  })

  it("records the close call immediately, before the asynchronous transition", () => {
    const socket = new FakeSocket("wss://api.example.test/ws")
    socket.openFromPeer()

    socket.close(1000, "done")

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "done" }])
  })

  it("fires onClose only once the asynchronous transition completes", async () => {
    const socket = new FakeSocket("wss://api.example.test/ws")
    socket.openFromPeer()
    const closes: unknown[] = []
    socket.onClose((info) => closes.push(info))

    socket.close(1000, "done")
    expect(closes).toEqual([])

    await drainMicrotasks()

    expect(closes).toEqual([{ code: 1000, reason: "done", abnormal: false }])
  })

  it("refuses to open once closing has started", async () => {
    const socket = new FakeSocket("wss://api.example.test/ws")
    socket.openFromPeer()

    socket.close()
    socket.openFromPeer()

    expect(socket.state).toBe(SocketState.Closing)
    await drainMicrotasks()
    expect(socket.state).toBe(SocketState.Closed)
  })

  it("drops a peer close instantly, unlike a locally requested close", () => {
    // `dropFromPeer` models the network reporting a close that already happened — there is no local
    // "closing" phase to simulate, unlike calling `close()` on this side.
    const socket = new FakeSocket("wss://api.example.test/ws")
    socket.openFromPeer()

    socket.dropFromPeer()

    expect(socket.state).toBe(SocketState.Closed)
  })
})

describe("FakeSocket bufferedAmount", () => {
  it("reports zero until a test sets it", () => {
    const socket = new FakeSocket("wss://api.example.test/ws")

    expect(socket.bufferedAmount).toBe(0)
  })

  it("reports whatever a test simulates", () => {
    const socket = new FakeSocket("wss://api.example.test/ws")

    socket.setBufferedAmount(2_000_000)

    expect(socket.bufferedAmount).toBe(2_000_000)
  })
})
