/**
 * The socket port the transport core talks to.
 *
 * This is deliberately four methods and a state: no `ws`, no `socket.io`, no `hono/ws`, no
 * `WebSocket` global. A host application adapts its own socket object once, and every module in
 * this package is then testable against a fake socket with no network and no extra permission.
 */

/** Lifecycle state of a socket, mirroring the platform `WebSocket` constants. */
export enum SocketState {
  Connecting = 1,
  Open = 2,
  Closing = 3,
  Closed = 4,
}

/** Why and how a socket stopped. */
export interface SocketCloseInfo {
  /** Platform-style close code; `1000` is a clean close, `1006` an abnormal one. */
  code: number
  reason: string
  /** True for anything other than a clean close the local side asked for. */
  abnormal: boolean
}

/** Removes a handler registered through one of the `on*` port methods. Idempotent. */
export type Unsubscribe = () => void

/** The outbound half of a socket. */
export interface SocketPort {
  readonly state: SocketState
  /** Send one text frame. Implementations throw when the socket is not open. */
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** The inbound half of a socket, as a subscription API rather than `on*` properties. */
export interface SocketObserverPort {
  onOpen(handler: () => void): Unsubscribe
  onMessage(handler: (data: string) => void): Unsubscribe
  onClose(handler: (info: SocketCloseInfo) => void): Unsubscribe
}

/**
 * What this package requires of a socket.
 *
 * A platform `WebSocket` satisfies it through a ~20 line adapter; `FakeSocket` satisfies it in
 * tests. Because the port is this small, nothing in `realtime` depends on a WebSocket library.
 */
export type ManagedSocket = SocketPort & SocketObserverPort

/** Creates a socket for a URL. Injected, so no transport decides how connections are made. */
export type SocketFactory = (url: string) => ManagedSocket
