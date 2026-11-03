/**
 * The runtime branches behind `./serve.ts`, written over an injected host object so a unit test can
 * drive the Deno, Node and Bun branches without the runtime it is running on.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import type {
  ServeHandler,
  ServeInfo,
  ServeOptions,
  Server,
  ServerWebSocket,
  UpgradeWebSocketOptions,
  WebSocketUpgrade,
} from "./serve.ts"

/** The members of `Bun.serve`'s server that the Bun branch calls. */
export interface BunServer {
  readonly hostname?: string
  readonly port?: number
  requestIP(request: Request): { address: string; port: number } | null
  upgrade(
    request: Request,
    options: { data: BridgedSocket; headers?: Record<string, string> },
  ): boolean
  /** `true` drops open connections, WebSockets included, instead of waiting for them. */
  stop(closeActiveConnections?: boolean): Promise<void> | void
}

/** A socket of Bun's `websocket` handlers, as the Bun branch uses it. */
export interface BunSocket {
  readonly data: BridgedSocket
  send(data: string | ArrayBuffer | Uint8Array): unknown
  close(code?: number, reason?: string): void
  getBufferedAmount?(): number
}

/** The options the Bun branch hands to `Bun.serve`. */
export interface BunServeOptions {
  hostname: string
  port: number
  fetch(request: Request, server: BunServer): Promise<Response | undefined>
  websocket: {
    open(ws: BunSocket): void
    message(ws: BunSocket, message: string | Uint8Array): void
    close(ws: BunSocket, code: number, reason: string): void
  }
}

/** The globals the branches read: `Deno` first (Deno 2 also defines `process`), then `Bun`. */
export interface ServeHost {
  Deno?: {
    serve(
      options: {
        hostname: string
        port: number
        signal?: AbortSignal
        onListen?: (addr: { hostname: string; port: number }) => void
      },
      handler: ServeHandler,
    ): { finished: Promise<void>; shutdown(): Promise<void> }
    upgradeWebSocket(request: Request, options: UpgradeWebSocketOptions): WebSocketUpgrade
  }
  Bun?: { serve(options: BunServeOptions): BunServer }
  process?: unknown
  /** Loads `node:http`, `node:stream` and `ws` for the Node branch. */
  loadNode?: () => Promise<NodeModules>
}

/** The members of `node:http`'s incoming request the Node branch reads. */
export interface NodeIncoming {
  method?: string
  url?: string
  headers: { host?: string }
  rawHeaders: string[]
  socket: { remoteAddress?: string; remotePort?: number }
}

/** The members of `node:http`'s response the Node branch writes. */
export interface NodeOutgoing {
  readonly writableFinished: boolean
  readonly headersSent: boolean
  readonly destroyed: boolean
  /** Throws, sending nothing, when a header name or value is one Node refuses. */
  writeHead(status: number, headers: string[]): void
  end(body?: string): void
  destroy(): void
  on(event: "close", listener: () => void): void
}

/** The raw TCP socket of an upgrade request. */
export interface NodeRawSocket {
  on(event: "error" | "close", listener: () => void): void
  end(data: Uint8Array, done: () => void): void
  destroy(): void
}

/** A socket of the `ws` package, as the Node branch uses it. */
export interface NodeWs {
  readonly bufferedAmount: number
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  on(event: "message", listener: (data: Uint8Array, isBinary: boolean) => void): void
  on(event: "close", listener: (code: number, reason: Uint8Array) => void): void
  on(event: "error", listener: () => void): void
}

/** The members of `node:http`, `node:stream` and `ws` the Node branch calls. */
export interface NodeModules {
  createServer(): {
    on(event: "request", listener: (req: NodeIncoming, res: NodeOutgoing) => void): void
    on(
      event: "upgrade",
      listener: (req: NodeIncoming, socket: NodeRawSocket, head: Uint8Array) => void,
    ): void
    once(event: "listening", listener: () => void): void
    once(event: "error", listener: (error: Error) => void): void
    off(event: "error", listener: (error: Error) => void): void
    listen(port: number, hostname: string): void
    address(): { address: string; port: number } | string | null
    close(callback: () => void): void
    closeIdleConnections(): void
  }
  STATUS_CODES: Record<number, string | undefined>
  /** `Readable.toWeb` of `node:stream`. */
  toWeb(req: NodeIncoming): ReadableStream<Uint8Array>
  /** `pipeline(Readable.fromWeb(body), res, done)` of `node:stream`. */
  pipeBody(body: ReadableStream<Uint8Array>, res: NodeOutgoing, done: () => void): void
  /**
   * A `ws` `WebSocketServer` with `noServer: true`, the given protocol chooser and a 64 MiB
   * message limit, as Deno's.
   */
  createWss(chooseProtocol: (req: NodeIncoming) => string | false): {
    handleUpgrade(
      req: NodeIncoming,
      socket: NodeRawSocket,
      head: Uint8Array,
      done: (ws: NodeWs) => void,
    ): void
  }
}

/** The largest message a Node socket accepts: 64 MiB, Deno's limit. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

async function loadNodeModules(): Promise<NodeModules> {
  // Computed specifiers keep `deno check` from pulling in `@types/node`. `ws` is a literal, so a
  // `deno bundle` of the app carries it.
  const [http, stream, ws] = await Promise.all([
    import(["node", "http"].join(":")),
    import(["node", "stream"].join(":")),
    import("ws"),
  ])
  const WebSocketServer = ws.WebSocketServer ?? ws.default.WebSocketServer
  return {
    createServer: () => http.createServer(),
    STATUS_CODES: http.STATUS_CODES,
    toWeb: (req) => stream.Readable.toWeb(req),
    pipeBody: (body, res, done) => stream.pipeline(stream.Readable.fromWeb(body), res, done),
    createWss: (chooseProtocol) =>
      new WebSocketServer({
        noServer: true,
        maxPayload: MAX_MESSAGE_BYTES,
        handleProtocols: (_offered: Set<string>, req: NodeIncoming) => chooseProtocol(req),
      }),
  }
}

/** The running process's globals, read on every call so nothing is captured at import time. */
export function currentServeHost(): ServeHost {
  const host = globalThis as unknown as ServeHost
  return { Deno: host.Deno, Bun: host.Bun, process: host.process, loadNode: loadNodeModules }
}

/** What a socket's runtime end gives {@link BridgedSocket} once the handshake completes. */
interface SocketBackend {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  bufferedAmount(): number
}

/** The typed listener overloads of {@link ServerWebSocket}, merged into the class below. */
export interface BridgedSocket {
  addEventListener: ServerWebSocket["addEventListener"]
  removeEventListener: ServerWebSocket["removeEventListener"]
}

/**
 * The standard-`WebSocket` face of a Node or Bun socket. It exists from the moment the handler
 * upgrades, before the handshake completes, as Deno's does; the runtime calls `opened`,
 * `received` and `closed` as the connection goes.
 */
export class BridgedSocket extends EventTarget implements ServerWebSocket {
  #state = 0
  #backend: SocketBackend | undefined
  #closeOnOpen: [number | undefined, string | undefined] | undefined

  get readyState(): number {
    return this.#state
  }

  get bufferedAmount(): number {
    return this.#backend?.bufferedAmount() ?? 0
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.#state === 0) throw new DOMException("the socket is not open yet", "InvalidStateError")
    if (this.#state === 1) this.#backend?.send(data)
  }

  close(code?: number, reason?: string): void {
    if (this.#state >= 2) return
    const wasConnecting = this.#state === 0
    this.#state = 2
    if (wasConnecting) this.#closeOnOpen = [code, reason]
    else this.#backend?.close(code, reason)
  }

  /** The handshake completed. */
  opened(backend: SocketBackend): void {
    this.#backend = backend
    if (this.#closeOnOpen) return backend.close(...this.#closeOnOpen)
    this.#state = 1
    this.dispatchEvent(new Event("open"))
  }

  /** A frame arrived. */
  received(data: string | ArrayBuffer): void {
    if (this.#state === 1) this.dispatchEvent(new MessageEvent("message", { data }))
  }

  /** The connection failed. */
  failed(): void {
    this.dispatchEvent(new Event("error"))
  }

  /** The connection closed; `1006` means it dropped without a closing handshake. */
  closed(code: number, reason: string): void {
    if (this.#state === 3) return
    this.#state = 3
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }))
  }
}

/** A copy of a binary frame as the `ArrayBuffer` a standard `WebSocket` hands out. */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

/** Turns one request's upgrade into a socket: set by the Node and Bun branches per request. */
type Upgrader = (options: UpgradeWebSocketOptions) => WebSocketUpgrade

const upgraders = new WeakMap<Request, Upgrader>()

/** `upgradeWebSocket` of `./serve.ts` over `host`. */
export function upgradeOver(host: ServeHost): typeof import("./serve.ts").upgradeWebSocket {
  return (request, options = {}) => {
    if (host.Deno) return host.Deno.upgradeWebSocket(request, options)
    const upgrade = upgraders.get(request)
    if (!upgrade) throw new TypeError("upgradeWebSocket: this request did not come from serve()")
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new TypeError("upgradeWebSocket: the request is not a WebSocket handshake")
    }
    upgraders.delete(request)
    return upgrade(options)
  }
}

/** A placeholder the handler returns after an upgrade; Node and Bun never send it. */
function upgradedResponse(): Response {
  return new Response(null)
}

function logListen(addr: { hostname: string; port: number }): void {
  console.log(`Listening on http://${addr.hostname}:${addr.port}/`)
}

/** Runs the handler, answering a thrown error with a 500, as `Deno.serve` does. */
async function answer(handler: ServeHandler, request: Request, info: ServeInfo): Promise<Response> {
  try {
    return await handler(request, info)
  } catch (error) {
    console.error(error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

/** `serve` of `./serve.ts` over `host`. Deno is asked first, since Deno 2 also defines `process`. */
export function serveOver(host: ServeHost): typeof import("./serve.ts").serve {
  return async (handler, options) => {
    if (host.Deno) {
      const { hostname, port, signal, onListen } = options
      const server = host.Deno.serve({
        hostname,
        port,
        ...(signal ? { signal } : {}),
        ...(onListen ? { onListen } : {}),
      }, handler)
      return { finished: server.finished, shutdown: () => server.shutdown() }
    }
    if (host.Bun) return serveBun(host.Bun, handler, options)
    if (host.process && host.loadNode) return serveNode(await host.loadNode(), handler, options)
    throw new Error("unsupported runtime: neither Deno, Bun nor process is defined")
  }
}

function serveBun(
  bun: NonNullable<ServeHost["Bun"]>,
  handler: ServeHandler,
  options: ServeOptions,
): Server {
  const open = new Set<BridgedSocket>()
  const server = bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request, server) {
      let socket: BridgedSocket | undefined
      upgraders.set(request, ({ protocol }) => {
        const bridged = new BridgedSocket()
        const headers = protocol ? { "sec-websocket-protocol": protocol } : undefined
        if (!server.upgrade(request, { data: bridged, headers })) {
          throw new TypeError("upgradeWebSocket: the request is not a WebSocket handshake")
        }
        socket = bridged
        return { socket: bridged, response: upgradedResponse() }
      })
      const peer = server.requestIP(request)
      const info = { remoteAddr: { hostname: peer?.address ?? "", port: peer?.port ?? 0 } }
      const response = await answer(handler, request, info)
      upgraders.delete(request)
      // Bun answers an upgraded request itself; it wants no response for it.
      return socket ? undefined : response
    },
    websocket: {
      open(ws) {
        open.add(ws.data)
        ws.data.opened({
          send: (data) => void ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          bufferedAmount: () => ws.getBufferedAmount?.() ?? 0,
        })
      },
      message(ws, message) {
        ws.data.received(typeof message === "string" ? message : arrayBufferOf(message))
      },
      close(ws, code, reason) {
        open.delete(ws.data)
        ws.data.closed(code, reason)
      },
    },
  })
  ;(options.onListen ?? logListen)({
    hostname: server.hostname ?? options.hostname,
    port: server.port ?? options.port,
  })
  return stoppable(options.signal, async () => {
    closeAll(open)
    await server.stop(true)
  })
}

/**
 * Closes every open socket with `1001` ("going away"), so a shutdown does not wait for clients
 * that would never leave on their own.
 */
function closeAll(open: Set<BridgedSocket>): void {
  for (const socket of open) socket.close(1001, "server shutting down")
}

/** A {@link Server} over `stop`, which runs once, on `shutdown()` or when `signal` aborts. */
function stoppable(signal: AbortSignal | undefined, stop: () => Promise<void>): Server {
  let stopping: Promise<void> | undefined
  let resolveFinished = () => {}
  const finished = new Promise<void>((resolve) => resolveFinished = resolve)
  const shutdown = () => stopping ??= stop().then(resolveFinished)
  if (signal?.aborted) void shutdown()
  else signal?.addEventListener("abort", () => void shutdown(), { once: true })
  return { finished, shutdown }
}

/** A host header that names only a host and an optional port. */
const HOST_SHAPE = /^[\w.~:[\]-]+$/

/**
 * The standard `Request` for a Node request. Only the origin form (`/path`) is accepted: the URL
 * is built from the `Host` header and the path, as Deno builds it, and a `Host` that holds anything
 * but a host and port is refused, so it cannot move the path.
 */
function toRequest(
  node: NodeModules,
  req: NodeIncoming,
  fallbackHost: string,
  signal?: AbortSignal,
): Request | undefined {
  const host = req.headers.host ?? fallbackHost
  if (!req.url?.startsWith("/") || !HOST_SHAPE.test(host)) return undefined
  try {
    const headers = new Headers()
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    }
    const method = req.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"
    return new Request(`http://${host}${req.url}`, {
      method,
      headers,
      signal,
      ...(hasBody ? { body: node.toWeb(req), duplex: "half" } : {}),
    } as RequestInit)
  } catch {
    return undefined
  }
}

function peerOf(req: NodeIncoming): ServeInfo {
  return {
    remoteAddr: { hostname: req.socket.remoteAddress ?? "", port: req.socket.remotePort ?? 0 },
  }
}

/**
 * Writes a response to `res`, streaming its body. When the client has already hung up, nothing is
 * written. When Node refuses a header, the client gets a 500 instead, or, once the headers are out,
 * a dropped connection; the server keeps serving either way.
 */
async function writeResponse(
  node: NodeModules,
  response: Response,
  method: string | undefined,
  res: NodeOutgoing,
): Promise<void> {
  try {
    if (res.destroyed) return void await response.body?.cancel()
    const headers: string[] = []
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") headers.push(name, value)
    }
    for (const cookie of response.headers.getSetCookie()) headers.push("set-cookie", cookie)
    res.writeHead(response.status, headers)
    if (!response.body || method === "HEAD") return res.end()
    await new Promise<void>((resolve) => node.pipeBody(response.body!, res, resolve))
  } catch (error) {
    console.error(error)
    if (res.headersSent || res.destroyed) return res.destroy()
    res.writeHead(500, ["content-type", "text/plain;charset=UTF-8"])
    res.end("Internal Server Error")
  }
}

/** The whole response, written to a raw socket that asked for an upgrade the app refused. */
async function rawResponse(node: NodeModules, response: Response): Promise<Uint8Array> {
  const body = new Uint8Array(await response.arrayBuffer())
  let head = `HTTP/1.1 ${response.status} ${node.STATUS_CODES[response.status] ?? ""}\r\n`
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie" && name !== "content-length" && name !== "connection") {
      head += `${name}: ${value}\r\n`
    }
  }
  for (const cookie of response.headers.getSetCookie()) head += `set-cookie: ${cookie}\r\n`
  head += `content-length: ${body.byteLength}\r\nconnection: close\r\n\r\n`
  const headBytes = new TextEncoder().encode(head)
  const bytes = new Uint8Array(headBytes.byteLength + body.byteLength)
  bytes.set(headBytes)
  bytes.set(body, headBytes.byteLength)
  return bytes
}

const badRequest = () => new Response("Bad Request", { status: 400 })

function serveNode(
  node: NodeModules,
  handler: ServeHandler,
  options: ServeOptions,
): Promise<Server> {
  const server = node.createServer()
  const protocols = new WeakMap<NodeIncoming, string>()
  const wss = node.createWss((req) => protocols.get(req) ?? false)
  const fallbackHost = `${options.hostname}:${options.port}`
  const open = new Set<BridgedSocket>()

  server.on("request", async (req, res) => {
    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) controller.abort()
    })
    const request = toRequest(node, req, fallbackHost, controller.signal)
    const response = request ? await answer(handler, request, peerOf(req)) : badRequest()
    await writeResponse(node, response, req.method, res)
  })

  server.on("upgrade", async (req, raw, head) => {
    raw.on("error", () => {})
    try {
      await upgradeNode(req, raw, head)
    } catch (error) {
      console.error(error)
      raw.destroy()
    }
  })

  async function upgradeNode(req: NodeIncoming, raw: NodeRawSocket, head: Uint8Array) {
    const request = toRequest(node, req, fallbackHost)
    let socket: BridgedSocket | undefined
    if (request) {
      upgraders.set(request, ({ protocol }) => {
        socket = new BridgedSocket()
        if (protocol) protocols.set(req, protocol)
        return { socket, response: upgradedResponse() }
      })
    }
    const response = request ? await answer(handler, request, peerOf(req)) : badRequest()
    if (request) upgraders.delete(request)
    if (!socket || response.status >= 500) {
      socket?.closed(1006, "")
      const bytes = await rawResponse(node, response)
      raw.end(bytes, () => raw.destroy())
      return
    }
    const bridged = socket
    let opened = false
    // `ws` refuses a malformed handshake by closing the connection, without calling back.
    raw.on("close", () => {
      if (!opened) bridged.closed(1006, "")
    })
    wss.handleUpgrade(req, raw, head, (ws) => {
      opened = true
      ws.on("error", () => bridged.failed())
      ws.on("message", (data, isBinary) => {
        bridged.received(isBinary ? arrayBufferOf(data) : new TextDecoder().decode(data))
      })
      ws.on("close", (code, reason) => {
        open.delete(bridged)
        bridged.closed(code, new TextDecoder().decode(reason))
      })
      open.add(bridged)
      bridged.opened({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        bufferedAmount: () => ws.bufferedAmount,
      })
    })
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", () => {
      server.off("error", reject)
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : options.port
      ;(options.onListen ?? logListen)({ hostname: options.hostname, port })
      resolve(stoppable(options.signal, () =>
        new Promise<void>((done) => {
          server.close(done)
          server.closeIdleConnections()
          closeAll(open)
        })))
    })
    server.listen(options.port, options.hostname)
  })
}
