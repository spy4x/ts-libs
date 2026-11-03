/**
 * Serve a fetch handler, such as a Hono app's `app.fetch`, and upgrade its requests to WebSockets,
 * on Deno, Node and Bun.
 *
 * - Deno: `Deno.serve` and `Deno.upgradeWebSocket`.
 * - Bun: `Bun.serve`, and `server.upgrade` for a WebSocket.
 * - Node: `node:http`, and the `ws` package for a WebSocket.
 *
 * The handler gets the connection's address as `info.remoteAddr` on every runtime, the way
 * `Deno.serve` passes it, so `serveRemoteAddr` from `@spy4x/platform/rate-limit/hono` reads the
 * peer's IP from the connection itself, never from a header.
 *
 * @example
 * ```ts
 * import { Hono } from "hono"
 *
 * const app = new Hono()
 * app.get("/socket", (c) => {
 *   const { socket, response } = upgradeWebSocket(c.req.raw)
 *   socket.addEventListener("message", (event) => socket.send(String(event.data)))
 *   return response
 * })
 * const server = await serve(app.fetch, { hostname: "0.0.0.0", port: 8000 })
 * await server.finished
 * ```
 *
 * @module
 */

import { currentServeHost, serveOver, upgradeOver } from "./_serve-host.ts"

/** The connection a request came in on. */
export interface ServeInfo {
  /** The peer's address: its IP and port, taken from the connection. */
  remoteAddr: { hostname: string; port: number }
}

/** A fetch handler: Hono's `app.fetch` is one. */
export type ServeHandler = (request: Request, info: ServeInfo) => Response | Promise<Response>

/** Options for {@link serve}. */
export interface ServeOptions {
  /** The address to listen on, such as `0.0.0.0` or `127.0.0.1`. */
  hostname: string
  /** The port to listen on; `0` picks a free one, which `onListen` reports. */
  port: number
  /** Aborting it shuts the server down, as {@link Server.shutdown} does. */
  signal?: AbortSignal
  /** Called once the server listens. Defaults to logging the address, as `Deno.serve` does. */
  onListen?: (addr: { hostname: string; port: number }) => void
}

/** A running server. */
export interface Server {
  /** Settles once the server has shut down. */
  finished: Promise<void>
  /** Stops accepting connections, lets pending requests finish, and resolves when it has. */
  shutdown(): Promise<void>
}

/**
 * Listens on `options.hostname` and `options.port` and answers every request with `handler`.
 * Resolves once the server listens, and rejects when it cannot, such as on a port in use.
 */
export function serve(handler: ServeHandler, options: ServeOptions): Promise<Server> {
  return serveOver(currentServeHost())(handler, options)
}

/** Options for {@link upgradeWebSocket}. */
export interface UpgradeWebSocketOptions {
  /** The subprotocol to accept, out of those the client offered in `Sec-WebSocket-Protocol`. */
  protocol?: string
}

/**
 * The server's end of a WebSocket: the members of a standard `WebSocket` it needs. On Deno it is
 * Deno's own `WebSocket`. It fires `open`, `message` (text as a string, binary as an
 * `ArrayBuffer`), `close` and `error` events.
 */
export interface ServerWebSocket extends EventTarget {
  /** `0` connecting, `1` open, `2` closing, `3` closed, as `WebSocket.readyState`. */
  readonly readyState: number
  /** Bytes queued by `send` and not yet written to the network. */
  readonly bufferedAmount: number
  /** Sends a frame. Throws while connecting; does nothing once closing or closed. */
  send(data: string | ArrayBuffer | Uint8Array): void
  /** Starts the closing handshake. */
  close(code?: number, reason?: string): void
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void
}

/** What {@link upgradeWebSocket} returns: the socket, and the response the handler must return. */
export interface WebSocketUpgrade {
  socket: ServerWebSocket
  response: Response
}

/**
 * Upgrades a request that {@link serve} handed to the handler, the way `Deno.upgradeWebSocket`
 * does: the handler returns `response`, and `socket` opens once the handshake completes.
 *
 * Throws when the request is not a WebSocket handshake, and on Node and Bun when it did not come
 * from {@link serve}.
 */
export function upgradeWebSocket(
  request: Request,
  options: UpgradeWebSocketOptions = {},
): WebSocketUpgrade {
  return upgradeOver(currentServeHost())(request, options)
}
