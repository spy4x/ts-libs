/**
 * Adapter from the platform `WebSocket` to this package's {@link ManagedSocket} port (issue #65,
 * finding 4).
 *
 * No adapter shipped before this file, so the mismatch below was never exercised: the browser's
 * `readyState` is numbered 0-3 (`CONNECTING`, `OPEN`, `CLOSING`, `CLOSED`), while this package's
 * {@link SocketState} is numbered 1-4 for the same four states — `socket-port.ts` says so directly,
 * "mirroring the platform `WebSocket` constants", but the numbers do not actually line up. The
 * obvious adapter, `get state() { return this.#ws.readyState }`, therefore reads a real open socket
 * (native `1`) as this package's `SocketState.Connecting` (`1`), so `ClientTransport` never
 * considers it open and every `send` is refused — silently, since {@link ClientTransport.send}
 * returns `false` rather than throwing — before it ever reaches the socket. {@link READY_STATE_MAP}
 * is the translation table that fixes it, and is the whole reason this file is more than a
 * one-liner.
 *
 * This module runs in a browser as well as in Deno, so nothing here touches `Deno.*`.
 *
 * @module
 */

import type { ManagedSocket, SocketCloseInfo, SocketFactory, Unsubscribe } from "./socket-port.ts"
import { SocketState } from "./socket-port.ts"

/**
 * The subset of the platform `WebSocket` this adapter needs.
 *
 * A real `WebSocket` satisfies this structurally, and it is narrow enough that a unit test can
 * exercise {@link adaptWebSocket} with a plain object instead of an actual socket — no `--allow-net`
 * needed for the state-mapping and send-refusal behaviour, which is the part with a bug to pin. The
 * full open/message/close life cycle over a real socket is covered by
 * `web-socket-adapter.integration.test.ts`, which is the only place a real `WebSocket` is created.
 */
export interface NativeSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly bufferedAmount?: number
  addEventListener(type: "open", listener: () => void): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void
  removeEventListener(type: "open", listener: () => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "close", listener: (event: CloseEvent) => void): void
}

/** The platform's own numbering for `WebSocket.readyState`, named so the map below is readable. */
const NATIVE_CONNECTING = 0
const NATIVE_OPEN = 1
const NATIVE_CLOSING = 2
const NATIVE_CLOSED = 3

/**
 * `WebSocket.readyState` (0-3) → this package's {@link SocketState} (1-4).
 *
 * An unrecognised value maps to {@link SocketState.Closed} — the safe side to fail to, since it
 * refuses `send` rather than allowing one on a socket in a state this adapter does not understand.
 */
const READY_STATE_MAP: Readonly<Record<number, SocketState>> = {
  [NATIVE_CONNECTING]: SocketState.Connecting,
  [NATIVE_OPEN]: SocketState.Open,
  [NATIVE_CLOSING]: SocketState.Closing,
  [NATIVE_CLOSED]: SocketState.Closed,
}

/** Maps one native `readyState` value to this package's {@link SocketState}. Exported for its own test. */
export function mapReadyState(readyState: number): SocketState {
  return READY_STATE_MAP[readyState] ?? SocketState.Closed
}

/**
 * Wraps a platform `WebSocket` (or anything shaped like one) so it satisfies {@link ManagedSocket}.
 *
 * `send` checks the mapped state itself and throws when it is not {@link SocketState.Open} — the
 * `ManagedSocket` port's own contract ("Implementations throw when the socket is not open",
 * `socket-port.ts`) — rather than relying on the native socket's own behaviour, which is
 * inconsistent: a real `WebSocket.send` throws while `CONNECTING` but silently discards the frame
 * while `CLOSING` or `CLOSED`.
 */
export function adaptWebSocket(ws: NativeSocketLike): ManagedSocket {
  return {
    get state(): SocketState {
      return mapReadyState(ws.readyState)
    },
    get bufferedAmount(): number | undefined {
      return ws.bufferedAmount
    },
    send(data: string): void {
      const state = mapReadyState(ws.readyState)
      if (state !== SocketState.Open) {
        throw new Error(`cannot send while the socket is ${SocketState[state]}`)
      }
      ws.send(data)
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },
    onOpen(handler: () => void): Unsubscribe {
      ws.addEventListener("open", handler)
      return () => ws.removeEventListener("open", handler)
    },
    onMessage(handler: (data: string) => void): Unsubscribe {
      const listener = (event: MessageEvent) => {
        if (typeof event.data === "string") handler(event.data)
      }
      ws.addEventListener("message", listener)
      return () => ws.removeEventListener("message", listener)
    },
    onClose(handler: (info: SocketCloseInfo) => void): Unsubscribe {
      const listener = (event: CloseEvent) => {
        handler({ code: event.code, reason: event.reason, abnormal: !event.wasClean })
      }
      ws.addEventListener("close", listener)
      return () => ws.removeEventListener("close", listener)
    },
  }
}

/** {@link SocketFactory} over the platform `WebSocket` constructor. The only place one is created. */
export function createWebSocketFactory(): SocketFactory {
  return (url: string) => adaptWebSocket(new WebSocket(url))
}
