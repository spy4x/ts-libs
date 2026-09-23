/**
 * `@spy4x/realtime` — transport mechanics for a hint-only realtime connection.
 *
 * The contract, from ADR 002 (`spy4x/template`, `docs/decisions/002-realtime-transport-and-sync.md`)
 * and restated in `README.md` as an invariant:
 *
 * - **No mutations over the socket.** REST is the external application protocol; the socket
 *   carries liveness, a sync handshake and change hints.
 * - **A push carries a sequence.** Every hint names the group and the `next_change_sequence` the
 *   change was committed at.
 * - **A gap triggers a pull.** A hint whose sequence is not contiguous with the client's cursor is
 *   discarded and the cursor is pulled over REST. A missed frame costs a pull, never divergence.
 *
 * Nothing here imports Preact, `@preact/signals`, a WebSocket library or a framework. A signals
 * binding is a thin wrapper over {@link ClientTransport} and belongs in the component library.
 */

export { type Clock, createSystemClock, type TimerHandle } from "./clock.ts"

export {
  type BackoffConfig,
  type BackoffOptions,
  DEFAULT_BACKOFF,
  nextBackoffDelay,
} from "./backoff.ts"

export {
  type ChangeHint,
  type ClientMessage,
  createHint,
  createJsonCodec,
  type DecodeResult,
  findUndeclaredKey,
  isChangeHint,
  type MessageCodec,
  type ServerMessage,
  toWireCursors,
  type WireMessage,
} from "./codec.ts"

export {
  type ApplyOutcome,
  ApplyStatus,
  type CursorSnapshot,
  CursorTracker,
  type GapReport,
  PersistentCursorStore,
  type PersistentCursorStoreOptions,
  SEQUENCE_START,
  type SequenceChange,
  type SyncRequest,
} from "./cursor.ts"

export { type KeyValueStore, MemoryKeyValueStore } from "./storage.ts"

export {
  type CloseHandler,
  CloseReason,
  type ConnectionHandle,
  ConnectionRegistry,
  type ConnectionRegistryOptions,
  type FrameContext,
  type FrameHandler,
  type MalformedFrame,
  type MalformedFrameHandler,
  type OpenHandler,
  type RegistryCloseInfo,
} from "./registry.ts"

export {
  type AggregateChange,
  AggregateNotifier,
  type AggregateNotifierOptions,
  type NotifyOutcome,
  NotifyStatus,
  type RecipientResolver,
  type UserFanout,
} from "./notify.ts"

export {
  AckTimeoutError,
  type AppliedHint,
  AuthGateError,
  ClientTransport,
  type ClientTransportOptions,
  ConnectionLostError,
  ConnectTimeoutError,
  type CursorPort,
  type GateResult,
  PongTimeoutError,
  type RequestOptions,
  TransportStatus,
  type TransportStatusSnapshot,
} from "./client-transport.ts"

export {
  type ManagedSocket,
  type SocketCloseInfo,
  type SocketFactory,
  type SocketObserverPort,
  type SocketPort,
  SocketState,
  type Unsubscribe,
} from "./socket-port.ts"

export {
  adaptWebSocket,
  createWebSocketFactory,
  mapReadyState,
  type NativeSocketLike,
} from "./web-socket-adapter.ts"
