/**
 * The real `WebSocket` adapter against a real local server (issue #65, findings 1, 2, 3 and 4).
 *
 * No real `WebSocket` was ever used in a test before this file: `client-transport.test.ts` drives
 * `FakeSocket`, and `web-socket-adapter.test.ts` drives a stand-in shaped like a native socket. Both
 * are honest about that limit. This file starts a real WebSocket server on `127.0.0.1` with an
 * ephemeral port (`Deno.serve({ port: 0 })` and `Deno.upgradeWebSocket`) and runs the real adapter —
 * `createWebSocketFactory`, backed by the platform `WebSocket` — against it. Nothing here reaches
 * outside loopback and nothing needs a container.
 *
 * `waitFor` polls instead of sleeping a fixed amount, so each assertion is made as soon as its
 * condition is true rather than after a guessed delay, and it throws — never silently times out — if
 * the condition is never met, which is what "fail loudly, never skip" means for a real clock.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { ClientTransport } from "./client-transport.ts"
import { createSystemClock } from "./clock.ts"
import { createJsonCodec } from "./codec.ts"
import type { GapReport } from "./cursor.ts"
import { PersistentCursorStore } from "./cursor.ts"
import { MemoryKeyValueStore } from "./storage.ts"
import { SocketState } from "./socket-port.ts"
import { adaptWebSocket, createWebSocketFactory } from "./web-socket-adapter.ts"

interface TestServer {
  url: string
  /** Server-side sockets, in connection order. */
  sockets: WebSocket[]
  close(): Promise<void>
}

/**
 * Starts a real WebSocket server on loopback with an ephemeral port. `onSocket` is called with each
 * upgraded server-side socket and its connection index (0 for the first), so a test can script drops
 * and hints per attempt.
 */
function startServer(onSocket: (socket: WebSocket, index: number) => void): TestServer {
  const sockets: WebSocket[] = []
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request)
      const index = sockets.length
      sockets.push(socket)
      onSocket(socket, index)
      return response
    },
  )
  const addr = server.addr
  const port = "port" in addr ? addr.port : 0

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    sockets,
    close: async () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.close()
          } catch {
            // Already gone.
          }
        }
      }
      await server.shutdown()
    },
  }
}

/** Polls `predicate` until it is true. Throws — never silently gives up — past `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("the real WebSocket adapter against a real local server", () => {
  it("reports Connecting, then Open, then Closed as a real socket moves through its life cycle", async () => {
    const server = startServer(() => {})
    try {
      const native = new WebSocket(server.url)
      const socket = adaptWebSocket(native)
      // The regression the finding names: a naive `return ws.readyState` would report this as
      // SocketState.Open (2 in this package's numbering happens to equal native readyState 2,
      // CLOSING) instead of Connecting.
      expect(socket.state).toBe(SocketState.Connecting)

      await waitFor(() => socket.state === SocketState.Open)
      expect(socket.state).toBe(SocketState.Open)

      socket.close(1000, "done")
      await waitFor(() => socket.state === SocketState.Closed)
      expect(socket.state).toBe(SocketState.Closed)
    } finally {
      await server.close()
    }
  })

  it("throws instead of silently dropping a send while the real socket is not open", async () => {
    const server = startServer(() => {})
    try {
      const native = new WebSocket(server.url)
      const socket = adaptWebSocket(native)

      expect(() => socket.send("hello")).toThrow()

      await waitFor(() => socket.state === SocketState.Open)
      socket.send("hello") // now the socket is open, so this succeeds

      socket.close()
      await waitFor(() => socket.state === SocketState.Closed)
      expect(() => socket.send("hello")).toThrow()
    } finally {
      await server.close()
    }
  })

  it("fetches exactly once after exactly one reconnect when the server drops the connection", async () => {
    // Issue #65, finding 2, over a real socket: the first connection is accepted and dropped once;
    // every connection after it stays open.
    const server = startServer((socket, index) => {
      if (index === 0) {
        socket.addEventListener("open", () => socket.close(1001, "dropping the first connection"))
      }
    })

    const clock = createSystemClock()
    const store = new PersistentCursorStore({ storage: new MemoryKeyValueStore(), clock })
    store.advanceTo("group-1", 4)
    const pulls: GapReport[] = []

    const transport = new ClientTransport({
      url: server.url,
      socketFactory: createWebSocketFactory(),
      clock,
      cursors: store,
      pull: (gap) => {
        pulls.push(gap)
      },
      backoff: { baseMs: 20, factor: 2, maxMs: 200, jitterRatio: 0 },
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 60_000,
      handshakeAckTimeoutMs: 60_000,
    })

    try {
      transport.connect()
      await waitFor(() => pulls.length >= 1)

      expect(pulls).toEqual([{ groupId: "group-1", since: 4, received: 4 }])
      expect(server.sockets.length).toBe(2) // the original attempt, plus exactly one reconnect
    } finally {
      transport.stop()
      await server.close()
    }
  })

  it("saves the position only once the fetch a real hint triggers actually succeeds", async () => {
    // Issue #65, finding 1, over a real socket and the real wire codec: the position must not move
    // on a failed fetch, and must move once a retry of the same hint succeeds.
    const hint: { send: (() => void) | null } = { send: null }
    const codec = createJsonCodec()
    const server = startServer((socket) => {
      socket.addEventListener("open", () => {
        hint.send = () => {
          socket.send(codec.encode({ kind: "change.hint", groupId: "group-1", sequence: 5 }))
        }
      })
    })

    const clock = createSystemClock()
    const store = new PersistentCursorStore({ storage: new MemoryKeyValueStore(), clock })
    store.advanceTo("group-1", 4)
    const pulls: GapReport[] = []
    let failNextPull = true

    const transport = new ClientTransport({
      url: server.url,
      socketFactory: createWebSocketFactory(),
      clock,
      cursors: store,
      pull: (gap) => {
        pulls.push(gap)
        if (failNextPull) {
          failNextPull = false
          throw new Error("fetch failed")
        }
      },
      backoff: { baseMs: 20, factor: 2, maxMs: 200, jitterRatio: 0 },
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 60_000,
      handshakeAckTimeoutMs: 60_000,
    })

    try {
      transport.connect()
      await waitFor(() => hint.send !== null)
      hint.send?.()

      await waitFor(() => pulls.length >= 1)
      expect(store.cursorFor("group-1")).toBe(4) // the failed fetch must not have moved it

      hint.send?.() // redelivered, as a server legitimately might
      await waitFor(() => store.cursorFor("group-1") === 5)
      expect(pulls.length).toBe(2)
    } finally {
      transport.stop()
      await server.close()
    }
  })

  it("does not storm-reconnect when the server accepts and drops every attempt at once", async () => {
    // Issue #65, finding 3, over real sockets and real time: a server that accepts and immediately
    // drops every attempt must not turn into a reconnect every few milliseconds forever.
    const server = startServer((socket) => {
      socket.addEventListener("open", () => socket.close(1001, "dropped immediately"))
    })

    const clock = createSystemClock()
    const store = new PersistentCursorStore({ storage: new MemoryKeyValueStore(), clock })

    const transport = new ClientTransport({
      url: server.url,
      socketFactory: createWebSocketFactory(),
      clock,
      cursors: store,
      pull: () => {},
      backoff: { baseMs: 30, factor: 2, maxMs: 300, jitterRatio: 0.3 },
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 60_000,
      handshakeAckTimeoutMs: 60_000,
    })

    try {
      transport.connect()
      await new Promise((resolve) => setTimeout(resolve, 800))

      // Exponential backoff over an 800ms window with a 30ms base, factor 2 and a 300ms cap yields
      // on the order of 5-6 attempts (30 + 60 + 120 + 240 + 300 + 300 ≈ 800). A reconnect storm from
      // resetting the backoff on every open — the bug this finding fixes — would produce dozens in
      // the same window. The bound below is generous on purpose; it is not a timing assertion.
      expect(server.sockets.length).toBeGreaterThanOrEqual(2)
      expect(server.sockets.length).toBeLessThan(15)
    } finally {
      transport.stop()
      await server.close()
    }
  })
})
