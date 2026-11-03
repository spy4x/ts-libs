import { assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import {
  BridgedSocket,
  type BunServeOptions,
  type BunServer,
  type BunSocket,
  type NodeIncoming,
  type NodeModules,
  type NodeOutgoing,
  type NodeRawSocket,
  type NodeWs,
  type ServeHost,
  serveOver,
  upgradeOver,
} from "./_serve-host.ts"
import type { ServeHandler, ServeInfo } from "./serve.ts"

const OPTIONS = { hostname: "127.0.0.1", port: 8000, onListen: () => {} }

/** Answers with the peer address the handler was given. */
const echoPeer: ServeHandler = (_request, info) => Response.json(info.remoteAddr)

function handshake(url = "http://app.test/socket"): Request {
  return new Request(url, {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": "user.1",
      "x-forwarded-for": "203.0.113.9",
    },
  })
}

function events(socket: EventTarget): string[] {
  const seen: string[] = []
  socket.addEventListener("open", () => seen.push("open"))
  socket.addEventListener(
    "message",
    (event) => seen.push(`message:${(event as MessageEvent).data}`),
  )
  socket.addEventListener("close", (event) => {
    const { code, wasClean } = event as CloseEvent
    seen.push(`close:${code}:${wasClean}`)
  })
  return seen
}

describe("serve on Deno", () => {
  it("hands the handler and options to Deno.serve, and upgrades with Deno.upgradeWebSocket", () => {
    const calls: unknown[] = []
    const response = new Response(null)
    const host: ServeHost = {
      Deno: {
        serve: (options, handler) => {
          calls.push(options, handler)
          return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }
        },
        upgradeWebSocket: (request, options) => {
          calls.push(request.url, options)
          return { socket: new BridgedSocket(), response }
        },
      },
      process: {},
    }

    void serveOver(host)(echoPeer, { hostname: "0.0.0.0", port: 8000 })
    const upgraded = upgradeOver(host)(handshake(), { protocol: "user.1" })

    assertEquals(calls, [
      { hostname: "0.0.0.0", port: 8000 },
      echoPeer,
      "http://app.test/socket",
      { protocol: "user.1" },
    ])
    assertEquals(upgraded.response, response)
  })
})

/** A fake `Bun.serve`: keeps the options and answers as a server with this peer. */
function fakeBun() {
  const upgrades: unknown[] = []
  const stops: unknown[] = []
  let options: BunServeOptions | undefined
  const server: BunServer = {
    requestIP: () => ({ address: "192.0.2.7", port: 40000 }),
    upgrade: (_request, upgrade) => {
      upgrades.push(upgrade.headers)
      return true
    },
    stop: (force) => void stops.push(force),
  }
  const host: ServeHost = {
    Bun: {
      serve: (given) => {
        options = given
        return server
      },
    },
    process: {},
  }
  return {
    host,
    server,
    upgrades,
    forced: () => stops,
    options: () => options!,
    stops: () => stops.length,
  }
}

function fakeBunSocket(data: BridgedSocket) {
  const sent: unknown[] = []
  const closed: unknown[] = []
  const socket: BunSocket = {
    data,
    send: (frame) => sent.push(frame),
    close: (...args) => void closed.push(args),
  }
  return { socket, sent, closed }
}

describe("serve on Bun", () => {
  it("gives the handler the peer address of the connection, not of a forwarding header", async () => {
    const bun = fakeBun()
    await serveOver(bun.host)(echoPeer, OPTIONS)

    const response = await bun.options().fetch(handshake(), bun.server)

    assertEquals(await response?.json(), { hostname: "192.0.2.7", port: 40000 })
  })

  it("upgrades with the chosen protocol and bridges the socket's frames", async () => {
    const bun = fakeBun()
    let socket: BridgedSocket | undefined
    await serveOver(bun.host)((request) => {
      const upgraded = upgradeOver(bun.host)(request, { protocol: "user.1" })
      socket = upgraded.socket as BridgedSocket
      return upgraded.response
    }, OPTIONS)

    const response = await bun.options().fetch(handshake(), bun.server)
    const seen = events(socket!)
    const ws = fakeBunSocket(socket!)
    bun.options().websocket.open(ws.socket)
    bun.options().websocket.message(ws.socket, "ping")
    socket!.send("pong")
    bun.options().websocket.close(ws.socket, 1000, "bye")

    assertEquals(response, undefined)
    assertEquals(bun.upgrades, [{ "sec-websocket-protocol": "user.1" }])
    assertEquals(ws.sent, ["pong"])
    assertEquals(seen, ["open", "message:ping", "close:1000:true"])
  })

  it("stops the server once, when the signal aborts and again on shutdown", async () => {
    const bun = fakeBun()
    const controller = new AbortController()
    const server = await serveOver(bun.host)(echoPeer, { ...OPTIONS, signal: controller.signal })

    controller.abort()
    await server.shutdown()
    await server.finished

    assertEquals(bun.stops(), 1)
  })

  it("closes open sockets with 1001 and drops their connections on shutdown", async () => {
    const bun = fakeBun()
    let socket: BridgedSocket | undefined
    const server = await serveOver(bun.host)((request) => {
      const upgraded = upgradeOver(bun.host)(request)
      socket = upgraded.socket as BridgedSocket
      return upgraded.response
    }, OPTIONS)
    await bun.options().fetch(handshake(), bun.server)
    const ws = fakeBunSocket(socket!)
    bun.options().websocket.open(ws.socket)

    await server.shutdown()

    assertEquals(ws.closed, [[1001, "server shutting down"]])
    assertEquals(bun.forced(), [true])
  })
})

describe("upgradeWebSocket on Node and Bun", () => {
  it("refuses a request that serve did not hand to the handler", () => {
    assertThrows(() => upgradeOver({ process: {} })(handshake()), TypeError, "did not come from")
  })
})

/** A fake `node:http`, `node:stream` and `ws`, driven by the test. */
function fakeNode() {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const handled: NodeWs[] = []
  let chooseProtocol: (req: NodeIncoming) => string | false = () => false
  let closes = 0
  const modules: NodeModules = {
    createServer: () => ({
      on: (event: string, listener: (...args: never[]) => unknown) => {
        listeners.set(event, listener)
      },
      once: (event: string, listener: (...args: never[]) => unknown) => {
        listeners.set(event, listener)
      },
      off: () => {},
      listen: () => queueMicrotask(() => (listeners.get("listening") as () => void)()),
      address: () => ({ address: "127.0.0.1", port: 8000 }),
      close: (done) => {
        closes++
        done()
      },
      closeIdleConnections: () => {},
    }),
    STATUS_CODES: { 403: "Forbidden" },
    toWeb: () => new ReadableStream(),
    pipeBody: (body, res, done) => {
      // Node's `pipeline` throws `ERR_STREAM_UNABLE_TO_PIPE` at once into a destroyed response.
      if (res.destroyed) throw new Error(`Cannot pipe to a closed or destroyed stream`)
      new Response(body).text().then((text) => {
        ;(res as FakeOutgoing).body = text
        done()
      })
    },
    createWss: (choose) => {
      chooseProtocol = choose
      return {
        handleUpgrade: (_req, _socket, _head, done) => handled[0] && done(handled[0]),
      }
    },
  }
  const host: ServeHost = { process: {}, loadNode: () => Promise.resolve(modules) }
  return {
    host,
    handled,
    closes: () => closes,
    chooseProtocol: (req: NodeIncoming) => chooseProtocol(req),
    request: listeners.get.bind(listeners, "request") as () => (
      req: NodeIncoming,
      res: NodeOutgoing,
    ) => Promise<void>,
    upgrade: listeners.get.bind(listeners, "upgrade") as () => (
      req: NodeIncoming,
      socket: NodeRawSocket,
      head: Uint8Array,
    ) => Promise<void>,
  }
}

interface FakeOutgoing extends NodeOutgoing {
  statusCode?: number
  headers: string[]
  body?: string
  destroyed: boolean
  /** Fires the listener `serve` gave for "close", as Node does when the client hangs up. */
  hangUp(): void
}

function incoming(headers: Record<string, string>, url = "/socket"): NodeIncoming {
  return {
    method: "GET",
    url,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { remoteAddress: "192.0.2.7", remotePort: 40000 },
  }
}

/** A fake `ServerResponse`; like Node's, `writeHead` throws on a control character. */
function outgoing(): FakeOutgoing {
  let onClose = () => {}
  const res: FakeOutgoing = {
    writableFinished: false,
    headersSent: false,
    destroyed: false,
    headers: [],
    writeHead: (status, headers) => {
      if (headers.some((value) => [...value].some((c) => c < " " && c !== "\t"))) {
        throw new TypeError(`Invalid character in header content`)
      }
      Object.assign(res, { statusCode: status, headers, headersSent: true })
    },
    end: (body = "") => void (res.body = body),
    destroy: () => void (res.destroyed = true),
    on: (_event, listener) => void (onClose = listener),
    hangUp: () => {
      res.destroyed = true
      onClose()
    },
  }
  return res
}

function rawSocket() {
  const written: string[] = []
  const listeners = new Map<string, () => void>()
  const socket: NodeRawSocket = {
    on: (event, listener) => void listeners.set(event, listener),
    end: (data, done) => {
      written.push(new TextDecoder().decode(data))
      done()
    },
    destroy: () => void written.push("destroyed"),
  }
  return { socket, written, hangUp: () => listeners.get("close")?.() }
}

/** A fake `ws` socket that keeps its listeners and what `close` was called with. */
function fakeWs() {
  const on = new Map<string, (...args: never[]) => void>()
  const sent: unknown[] = []
  const closed: unknown[] = []
  const ws = {
    bufferedAmount: 0,
    send: (data) => void sent.push(data),
    close: (...args) => void closed.push(args),
    on: (event: string, listener: (...args: never[]) => void) => void on.set(event, listener),
  } as NodeWs
  return { ws, on, sent, closed }
}

/** A handler that upgrades every request and hands its socket to `keep`. */
function upgrading(host: ServeHost, keep: (socket: BridgedSocket) => void): ServeHandler {
  return (request) => {
    const upgraded = upgradeOver(host)(request, { protocol: "user.1" })
    keep(upgraded.socket as BridgedSocket)
    return upgraded.response
  }
}

describe("serve on Node", () => {
  it("gives the handler the peer address of the connection, not of a forwarding header", async () => {
    const node = fakeNode()
    let info: ServeInfo | undefined
    await serveOver(node.host)((_request, given) => {
      info = given
      const headers = new Headers([["set-cookie", "a=1"], ["set-cookie", "b=2"]])
      return new Response("hello", { headers })
    }, OPTIONS)
    const res = outgoing()

    await node.request()(incoming({ host: "app.test", "x-forwarded-for": "203.0.113.9" }), res)

    assertEquals(info?.remoteAddr, { hostname: "192.0.2.7", port: 40000 })
    assertEquals(res.headers.filter((_, i) => res.headers[i - 1] === "set-cookie"), ["a=1", "b=2"])
    assertEquals(res.body, "hello")
  })

  it("refuses a Host header that would move the path, without calling the handler", async () => {
    const node = fakeNode()
    let called = false
    await serveOver(node.host)(() => {
      called = true
      return new Response("ok")
    }, OPTIONS)
    const res = outgoing()

    await node.request()(incoming({ host: "evil.test/admin?" }, "/"), res)

    assertEquals([res.statusCode, called], [400, false])
  })

  it("writes the app's refusal of an upgrade to the raw socket", async () => {
    const node = fakeNode()
    await serveOver(node.host)(() => new Response("no", { status: 403 }), OPTIONS)
    const raw = rawSocket()

    await node.upgrade()(
      incoming({ host: "app.test", upgrade: "websocket" }),
      raw.socket,
      new Uint8Array(),
    )

    assertEquals(raw.written, [
      "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain;charset=UTF-8\r\n" +
      "content-length: 2\r\nconnection: close\r\n\r\nno",
      "destroyed",
    ])
  })

  it("hands an accepted upgrade to ws with the chosen protocol and bridges its frames", async () => {
    const node = fakeNode()
    const on = new Map<string, (...args: never[]) => void>()
    const sent: unknown[] = []
    node.handled.push({
      bufferedAmount: 0,
      send: (data) => void sent.push(data),
      close: () => {},
      on: (event: string, listener: (...args: never[]) => void) => void on.set(event, listener),
    } as NodeWs)
    let socket: BridgedSocket | undefined
    await serveOver(node.host)((request) => {
      const upgraded = upgradeOver(node.host)(request, { protocol: "user.1" })
      socket = upgraded.socket as BridgedSocket
      return upgraded.response
    }, OPTIONS)
    const req = incoming({ host: "app.test", upgrade: "websocket" })
    const raw = rawSocket()

    await node.upgrade()(req, raw.socket, new Uint8Array())
    const seen = events(socket!)
    ;(on.get("message") as (data: Uint8Array, binary: boolean) => void)(
      new TextEncoder().encode("ping"),
      false,
    )
    socket!.send("pong")
    ;(on.get("close") as (code: number, reason: Uint8Array) => void)(1006, new Uint8Array())

    assertEquals(node.chooseProtocol(req), "user.1")
    assertEquals(raw.written, [])
    assertEquals(sent, ["pong"])
    assertEquals(seen, ["message:ping", "close:1006:false"])
  })

  it("aborts the request's signal and writes nothing when the client hangs up first", async () => {
    const node = fakeNode()
    const res = outgoing()
    let signal: AbortSignal | undefined
    await serveOver(node.host)((request) => {
      signal = request.signal
      res.hangUp()
      return new Response("late")
    }, OPTIONS)

    await node.request()(incoming({ host: "app.test" }, "/slow"), res)

    assertEquals([signal?.aborted, res.statusCode, res.body], [true, undefined, undefined])
  })

  it("answers 500 and keeps serving when Node refuses a response header", async () => {
    const node = fakeNode()
    // What Hono's `c.redirect(next)` answers for `?next=%2Fhome%01x`.
    const redirect = () => new Response(null, { status: 302, headers: { location: "/home\x01x" } })
    await serveOver(node.host)(redirect, OPTIONS)
    const res = outgoing()

    await node.request()(incoming({ host: "app.test" }, "/login"), res)

    assertEquals([res.statusCode, res.body], [500, "Internal Server Error"])
  })

  it("destroys the raw socket when a refused upgrade's response cannot be read", async () => {
    const node = fakeNode()
    const failing = new ReadableStream({ pull: (c) => c.error(new Error("body failed")) })
    await serveOver(node.host)(() => new Response(failing, { status: 403 }), OPTIONS)
    const raw = rawSocket()

    await node.upgrade()(
      incoming({ host: "app.test", upgrade: "websocket" }),
      raw.socket,
      new Uint8Array(),
    )

    assertEquals(raw.written, ["destroyed"])
  })

  it("closes the app's socket with 1006 when ws refuses the handshake", async () => {
    const node = fakeNode()
    let socket: BridgedSocket | undefined
    await serveOver(node.host)(upgrading(node.host, (given) => socket = given), OPTIONS)
    const raw = rawSocket()

    await node.upgrade()(
      incoming({ host: "app.test", upgrade: "websocket" }),
      raw.socket,
      new Uint8Array(),
    )
    const seen = events(socket!)
    raw.hangUp()

    assertEquals(seen, ["close:1006:false"])
  })

  it("closes open sockets with 1001 on shutdown", async () => {
    const node = fakeNode()
    const ws = fakeWs()
    node.handled.push(ws.ws)
    const server = await serveOver(node.host)(upgrading(node.host, () => {}), OPTIONS)
    await node.upgrade()(
      incoming({ host: "app.test", upgrade: "websocket" }),
      rawSocket().socket,
      new Uint8Array(),
    )

    await server.shutdown()

    assertEquals(ws.closed, [[1001, "server shutting down"]])
  })

  it("closes the server once, when the signal aborts and again on shutdown", async () => {
    const node = fakeNode()
    const controller = new AbortController()
    const server = await serveOver(node.host)(echoPeer, { ...OPTIONS, signal: controller.signal })

    controller.abort()
    await server.shutdown()
    await server.finished

    assertEquals(node.closes(), 1)
  })
})

describe("BridgedSocket", () => {
  it("refuses to send before the handshake completes", () => {
    assertThrows(() => new BridgedSocket().send("early"), DOMException, "not open yet")
  })

  it("closes on open when the app closed it while connecting, and fires no open", () => {
    const socket = new BridgedSocket()
    const seen = events(socket)
    const closed: unknown[] = []
    socket.close(4000, "gone")

    socket.opened({
      send: () => {},
      close: (...args) => closed.push(args),
      bufferedAmount: () => 0,
    })

    assertEquals([closed, seen, socket.readyState], [[[4000, "gone"]], [], 2])
  })
})
