/**
 * State mapping and send-refusal for the real `WebSocket` adapter (issue #65, finding 4).
 *
 * No real `WebSocket` is constructed here — that needs a network permission and a real peer, and is
 * covered end to end by `web-socket-adapter.integration.test.ts`. What is pinned here is the bug the
 * finding is actually about: `SocketState` is numbered 1-4 and the platform's `readyState` is
 * numbered 0-3, so a naive adapter reads a real open socket as this package's "connecting" and every
 * `send` is silently refused. `FakeNativeSocket` stands in for the native socket, driven directly by
 * setting `readyState`, exactly like a test would drive a real one if it could.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { adaptWebSocket, mapReadyState, type NativeSocketLike } from "./web-socket-adapter.ts"
import { SocketState } from "./socket-port.ts"

/** A listener for any of the three events this adapter subscribes to. */
type NativeListener = (() => void) | ((event: MessageEvent) => void) | ((event: CloseEvent) => void)

/** Bare-bones stand-in for a native `WebSocket`, driven by setting `readyState` directly. */
class FakeNativeSocket implements NativeSocketLike {
  readyState = 0
  bufferedAmount = 0
  readonly sent: string[] = []
  readonly closeCalls: { code?: number; reason?: string }[] = []
  readonly #listeners = new Map<string, Set<NativeListener>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
  }

  addEventListener(type: "open" | "message" | "close", listener: NativeListener): void {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(listener)
    this.#listeners.set(type, set)
  }

  removeEventListener(type: "open" | "message" | "close", listener: NativeListener): void {
    this.#listeners.get(type)?.delete(listener)
  }

  /** Fire every listener registered for `type`, the way the real socket would dispatch an event. */
  emit(type: "open" | "message" | "close", event?: MessageEvent | CloseEvent): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      // deno-lint-ignore no-explicit-any
      ;(listener as (event?: any) => void)(event)
    }
  }
}

describe("mapReadyState", () => {
  it("maps every native readyState to the corresponding SocketState, not the same number", () => {
    expect(mapReadyState(0)).toBe(SocketState.Connecting)
    expect(mapReadyState(1)).toBe(SocketState.Open)
    expect(mapReadyState(2)).toBe(SocketState.Closing)
    expect(mapReadyState(3)).toBe(SocketState.Closed)
  })

  it("never returns the native number unchanged for a real open socket", () => {
    // The exact regression the finding names: a naive `return ws.readyState` would report `1` for
    // an open socket, and this package's `SocketState.Open` is `2`, not `1`.
    expect(mapReadyState(1)).not.toBe(1)
    expect(mapReadyState(1)).toBe(SocketState.Open)
  })

  it("falls back to Closed for a readyState it does not recognise", () => {
    expect(mapReadyState(99)).toBe(SocketState.Closed)
  })
})

describe("adaptWebSocket", () => {
  it("reports Open once the native socket is open, not Connecting", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)
    expect(socket.state).toBe(SocketState.Connecting)

    native.readyState = 1

    expect(socket.state).toBe(SocketState.Open)
  })

  it("sends through to the native socket once open", () => {
    const native = new FakeNativeSocket()
    native.readyState = 1
    const socket = adaptWebSocket(native)

    socket.send("hello")

    expect(native.sent).toEqual(["hello"])
  })

  it("throws instead of silently dropping a send while not open", () => {
    const native = new FakeNativeSocket()
    // readyState 0: CONNECTING.
    const socket = adaptWebSocket(native)

    expect(() => socket.send("hello")).toThrow()
    expect(native.sent).toEqual([])
  })

  it("throws on send once the native socket has started closing", () => {
    const native = new FakeNativeSocket()
    native.readyState = 2 // CLOSING
    const socket = adaptWebSocket(native)

    expect(() => socket.send("hello")).toThrow()
    expect(native.sent).toEqual([])
  })

  it("forwards close with the code and reason given", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)

    socket.close(1000, "done")

    expect(native.closeCalls).toEqual([{ code: 1000, reason: "done" }])
  })

  it("fires onOpen when the native socket fires its open event", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)
    let opened = 0
    socket.onOpen(() => opened++)

    native.emit("open")

    expect(opened).toBe(1)
  })

  it("delivers only string message data to onMessage", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)
    const received: string[] = []
    socket.onMessage((data) => received.push(data))

    native.emit("message", { data: "frame-1" } as MessageEvent)
    native.emit("message", { data: new Uint8Array([1, 2, 3]) } as unknown as MessageEvent)

    expect(received).toEqual(["frame-1"])
  })

  it("reports close info with the abnormal flag derived from wasClean", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)
    const infos: { code: number; reason: string; abnormal: boolean }[] = []
    socket.onClose((info) => infos.push(info))

    native.emit("close", { code: 1006, reason: "lost", wasClean: false } as CloseEvent)

    expect(infos).toEqual([{ code: 1006, reason: "lost", abnormal: true }])
  })

  it("unsubscribes so a handler stops firing", () => {
    const native = new FakeNativeSocket()
    const socket = adaptWebSocket(native)
    let opened = 0
    const unsubscribe = socket.onOpen(() => opened++)

    unsubscribe()
    native.emit("open")

    expect(opened).toBe(0)
  })

  it("reads bufferedAmount through from the native socket", () => {
    const native = new FakeNativeSocket()
    native.bufferedAmount = 4_096
    const socket = adaptWebSocket(native)

    expect(socket.bufferedAmount).toBe(4_096)
  })
})
