// `nodeTcpConnect` against a fake `node:net` socket: the root test task has no `--allow-net`.

import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type NodeNet, type NodeSocket, nodeTcpConnect } from "./tcp.ts"

type Listener = (...args: never[]) => void

/** A `node:net` socket that records what it is asked to do and emits events on demand. */
class FakeSocket implements NodeSocket {
  listeners = new Map<string, Listener[]>()
  written: string[] = []
  destroyed = false
  paused = false
  ended = false
  /** When set, the next `write` calls back with it. */
  writeError: Error | undefined

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
    return this
  }
  once(event: string, listener: Listener) {
    return this.on(event, listener)
  }
  off(event: string, listener: Listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener))
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...args: unknown[]) => void)(...args)
    }
  }
  write(chunk: Uint8Array, callback: (error?: Error | null) => void) {
    this.written.push(new TextDecoder().decode(chunk))
    queueMicrotask(() => callback(this.writeError ?? null))
    return true
  }
  end(callback: () => void) {
    this.ended = true
    queueMicrotask(callback)
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit("close")
  }
}

function fakeNet() {
  const sockets: FakeSocket[] = []
  const targets: { host: string; port: number }[] = []
  const net: NodeNet = {
    createConnection(options) {
      targets.push(options)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  }
  return { sockets, targets, connect: nodeTcpConnect(() => Promise.resolve(net)) }
}

/** Yields until `socket` has a `connect` listener, so the test can answer it. */
async function connecting(sockets: FakeSocket[]): Promise<FakeSocket> {
  for (let tick = 0; tick < 100; tick++) {
    const socket = sockets[0]
    if (socket?.listeners.get("connect")?.length) return socket
    await Promise.resolve()
  }
  throw new Error("connecting: no socket ever waited for connect")
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

describe("nodeTcpConnect", () => {
  it("connects to the given host and port and streams bytes both ways", async () => {
    const { sockets, targets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    const socket = await connecting(sockets)
    socket.emit("connect")
    const connection = await opening
    expect(targets).toEqual([{ host: "db.example", port: 6379 }])

    const writer = connection.writable.getWriter()
    await writer.write(new TextEncoder().encode("PING\r\n"))
    expect(socket.written).toEqual(["PING\r\n"])

    const reader = connection.readable.getReader()
    socket.emit("data", new TextEncoder().encode("+PONG\r\n"))
    expect(text((await reader.read()).value)).toBe("+PONG\r\n")
    socket.emit("end")
    expect((await reader.read()).done).toBe(true)
  })

  it("fails a pending read when the connection is closed here", async () => {
    const { sockets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    ;(await connecting(sockets)).emit("connect")
    const connection = await opening
    const read = connection.readable.getReader().read()
    connection.close()
    expect(sockets[0].destroyed).toBe(true)
    await expect(read).rejects.toThrow("TCP connection closed")
  })

  it("rejects a write the socket fails", async () => {
    const { sockets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    ;(await connecting(sockets)).emit("connect")
    const connection = await opening
    sockets[0].writeError = new Error("EPIPE")
    await expect(connection.writable.getWriter().write(new Uint8Array([1]))).rejects.toThrow(
      "EPIPE",
    )
  })

  it("errors the readable half on a socket error after connect, without an unhandled error", async () => {
    const { sockets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    ;(await connecting(sockets)).emit("connect")
    const connection = await opening
    const read = connection.readable.getReader().read()
    sockets[0].emit("error", new Error("ECONNRESET"))
    await expect(read).rejects.toThrow("ECONNRESET")
  })

  it("rejects and destroys the socket when the connect fails", async () => {
    const { sockets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    ;(await connecting(sockets)).emit("error", new Error("ECONNREFUSED"))
    await expect(opening).rejects.toThrow("ECONNREFUSED")
    expect(sockets[0].destroyed).toBe(true)
  })

  it("rejects with the signal's reason and destroys the socket when a pending connect is aborted", async () => {
    const { sockets, connect } = fakeNet()
    const controller = new AbortController()
    const opening = connect({ hostname: "10.255.255.1", port: 6379, signal: controller.signal })
    const socket = await connecting(sockets)
    controller.abort(new DOMException("timed out", "TimeoutError"))
    await expect(opening).rejects.toThrow("timed out")
    expect(socket.destroyed).toBe(true)
  })

  it("opens no socket for a signal that is already aborted", async () => {
    const { sockets, connect } = fakeNet()
    const signal = AbortSignal.abort(new Error("gave up"))
    await expect(connect({ hostname: "db.example", port: 6379, signal })).rejects.toThrow(
      "gave up",
    )
    expect(sockets).toEqual([])
  })

  it("pauses the socket while the reader is behind and resumes it on the next read", async () => {
    const { sockets, connect } = fakeNet()
    const opening = connect({ hostname: "db.example", port: 6379 })
    ;(await connecting(sockets)).emit("connect")
    const connection = await opening
    const socket = sockets[0]
    socket.emit("data", new Uint8Array([1]))
    expect(socket.paused).toBe(true)
    await connection.readable.getReader().read()
    expect(socket.paused).toBe(false)
  })
})
