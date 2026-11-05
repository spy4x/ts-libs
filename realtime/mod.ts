/**
 * `@spy4x/realtime` — transport mechanics for a hint-only realtime connection.
 *
 * The contract, from ADR 002 (`spy4x/seed`, `docs/decisions/002-realtime-transport-and-sync.md`)
 * and restated in `README.md` as an invariant:
 *
 * - **Requests over the socket are envelopes only.** The socket carries liveness, a sync handshake,
 *   change hints, and request and response frames (`client.command`, `client.query`,
 *   `server.result`, `server.error`). The library validates the envelope, correlates and bounds
 *   requests; what a request means, and who may make it, is the host's.
 * - **A push carries a sequence.** Every hint names the group and the `next_change_sequence` the
 *   change was committed at.
 * - **A gap triggers a pull.** A hint whose sequence is not contiguous with the client's cursor is
 *   discarded and the cursor is pulled over REST. A missed frame costs a pull, never divergence.
 *
 * Nothing here imports Preact, `@preact/signals`, a WebSocket library or a framework. A signals
 * binding is a thin wrapper over {@link ClientTransport} and belongs in the component library.
 *
 * The governing record is ADR 002 in `spy4x/seed`
 * (`docs/decisions/002-realtime-transport-and-sync.md`). Three rules, and
 * everything below follows from them. Where the ADR's wording is quoted, the file
 * and line are given, so a reader can check the citation rather than the summary.
 *
 * 1. **The socket carries request envelopes, and nothing about what they mean.**
 *    Besides liveness, the sync handshake and change hints, the socket carries
 *    `client.command` and `client.query` frames, answered by `server.result` or
 *    `server.error`. This package validates the envelope (arktype), correlates
 *    each answer to its request id, bounds how many requests one connection may
 *    have in flight, times requests out and rejects them when the socket drops.
 *    It never interprets a command or query name or payload, never authorizes and
 *    never dispatches: a host registers one dispatcher with `registry.onRequest`
 *    and maps names to its own buses. Authorization lives in that host code
 *    (ADR 002, Consequences), not in the transport. (ADR 002:50 requires exactly
 *    this; earlier versions of this package declined it. See _Divergence_ below.)
 * 2. **A push carries a sequence.** ADR 002:60-61 — "Servers push committed
 *    changes over the socket, stamped with the per-group `next_change_sequence`
 *    they were committed at." A hint names a group and that sequence, and no entity
 *    payload.
 * 3. **A gap triggers a pull.** ADR 002:63-66 — "A client applies a pushed change
 *    only when its sequence is contiguous with the cursor the client already holds.
 *    On any gap it discards the payload and pulls from its cursor over REST.
 *    Correctness therefore lives in exactly one path - the cursor pull - which is
 *    also the path that runs when the socket is absent." Dropped frame, reconnect
 *    gap, reorder, duplicate delivery: each degrades to a redundant pull, never to
 *    divergent state.
 *
 * The test of any future change is ADR 002:72-74: _delete every line of WebSocket
 * code and the application must still converge to correct state._
 *
 * ## Where this package diverges from ADR 002, and why
 *
 * ADR 002:50 says "`apps/spa` speaks WebSocket for all mutations, queries and
 * realtime updates". Earlier versions of this package declined that half of the
 * ADR: `ClientMessage` had no mutation frame, so it was hint-only by construction.
 * `spy4x/template#79` reverses the ruling, and this package now carries request
 * and response frames.
 *
 * What still holds, and is the reason the change is additive rather than a second
 * application surface:
 *
 * - **Correctness lives in the cursor pull.** A hint still carries a sequence and
 *   no entity payload; a gap still discards and pulls over REST (rules 2 and 3).
 *   A request's result is not a change feed: the client does not move a cursor on
 *   it.
 * - **No authorization or business logic here.** The registry hands every request
 *   to the host's dispatcher with the authenticated `userId` it was attached
 *   with; the ADR's prerequisite (authorization inside the CQRS handlers, not in
 *   route middleware) is the host's to meet, and this package gives a host nothing
 *   to bypass it with.
 * - **Closed, typed failures.** A client switches on `RealtimeRequestError.code`,
 *   one of `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
 *   `rate_limited`, `internal`, `timeout`. A dispatcher exception that is not a
 *   `RealtimeRequestError` is answered `internal` with a fixed message; its text
 *   goes to `onRequestError`, never to the client. On the page,
 *   `describeError(error, fallback)` gives the text to show: the server's message
 *   for a `RealtimeRequestError`, the caller's fallback for anything else.
 * - **Bounded.** One connection may have `maxInFlightRequests` (default 16)
 *   unanswered requests; the next is answered `rate_limited` and takes no slot. A
 *   request id already in flight is answered `bad_request`, and so is a request
 *   frame that fails validation but has a readable `id`. A dispatcher that
 *   outlives `requestTimeoutMs` (default 10 s) is answered `timeout` and its
 *   `AbortSignal` is aborted, as it is when the connection closes. The limit
 *   counts _unanswered_ requests: a request answered `timeout` frees its slot
 *   while its dispatcher may still be running, so the limit bounds running work
 *   only for dispatchers that honour `signal`. An answer that cannot be encoded (a
 *   message over 1024 characters, a `BigInt` in the details) is replaced by a
 *   generic `internal` answer.
 * - **Idempotency is carried, not stored.** A `client.command` may carry an
 *   `idempotencyKey`, surfaced to the dispatcher as `context.idempotencyKey`.
 *   Remembering keys, replaying the first result and the 7-day sweep are the
 *   host's job ("Explicitly not implemented"). A query cannot carry one.
 * - **A dropped socket or a timeout has an unknown outcome.** Pending calls
 *   reject with `ConnectionLostError` when the socket drops, and with
 *   `RequestTimeoutError` when the client's own timeout (default 15 s, longer than
 *   the server's so the server's typed `timeout` normally arrives first) expires.
 *   Neither is a server answer: the command may have run. Resending with the same
 *   idempotency key is the safe retry.
 * - **The message unions grew.** `ClientMessage` and `ServerMessage` gained the
 *   four request kinds. That is a protocol extension: code that switches
 *   exhaustively over `kind` without a `default` needs the new cases. `send` and
 *   `request` keep their parameter types but refuse request frames at runtime
 *   (`send` returns `false`, `request` rejects): use `command` and `query`.
 *
 * The test of any future change is still ADR 002:72-74: delete every line of
 * WebSocket code and the application must still converge through the cursor pull.
 *
 * ## What "hint-only" buys
 *
 * `financy`'s socket was the only mutation path, so the app did not work with the
 * socket down, and its pushes carried no sequence, so a missed frame silently
 * diverged local state. Here a dropped frame costs one redundant pull, a
 * duplicated hint costs nothing, and a reordered hint cannot move a cursor
 * backwards.
 *
 * ## Ports
 *
 * Nothing here imports a WebSocket library, a framework or Preact. A host adapts
 * its own objects once — except the browser `WebSocket` itself, which this
 * package now adapts (see below).
 *
 * | Port                | Shape                                                                                                                                                                               | File                  |
 * | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
 * | `ManagedSocket`     | `state`, `send`, `close`, `onOpen`, `onMessage`, `onClose`, optional `bufferedAmount`                                                                                               | `socket-port.ts`      |
 * | `SocketFactory`     | `(url) => ManagedSocket`                                                                                                                                                            | `socket-port.ts`      |
 * | `TimerClock`        | `now`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`                                                                                                                   | `clock.ts`            |
 * | `KeyValueStore`     | `getItem`, `setItem`, `removeItem` — satisfied by Web Storage `Storage`; a deprecated alias of `@spy4x/platform/universal/key-value-store`'s `KeyValueStore`, the actual home | `storage.ts`          |
 * | `MessageCodec`      | `encode`, `decode`                                                                                                                                                                  | `codec.ts`            |
 * | `CursorPort`        | `syncRequest`, `cursorFor`, `apply`, optional `markSynced`                                                                                                                          | `client-transport.ts` |
 * | `UserFanout`        | `sendToUsers(userIds, message)`                                                                                                                                                     | `notify.ts`           |
 * | `RecipientResolver` | `(change) => userIds`                                                                                                                                                               | `notify.ts`           |
 *
 * Adapters a host writes — `localStorage` to `KeyValueStore`, `fetch` to the two
 * sync calls — are each a handful of lines and are the only place a platform
 * primitive is named. The one exception is `ManagedSocket` over a browser
 * `WebSocket`: this package ships `adaptWebSocket` and `createWebSocketFactory`
 * (`web-socket-adapter.ts`), because the mapping from the platform's `readyState`
 * (0-3) to this package's `SocketState` (1-4) is exactly the kind of bug a host
 * would silently reproduce — see "Fixed after ship" below.
 *
 * `UserFanout` deliberately exposes no broadcast. The registry has `sendToAll` for
 * a server-wide notice, but the notify path is only ever given `sendToUsers`, and
 * `AggregateNotifier` fails closed: an aggregate with no resolver produces zero
 * recipients.
 *
 * ## Explicitly not implemented
 *
 * - **The sync protocol.** Bootstrap, the pull endpoint, `authorization_revision`,
 *   the change log and the 7-day idempotency-key store are the server's job
 *   (`spy4x/template#11`, gaps 4 and 5). This package carries an
 *   `idempotencyKey` on a command and stores none. This package is the transport: it decides
 *   _when_ a pull is needed, and hands the cursor to whatever performs it.
 * - **A signals binding.** The client transport is deliberately signal-free, so it
 *   is testable without Preact. A binding over `onStatus`/`onChange` belongs in
 *   `preact-components`.
 * - **An SSE or long-poll transport.** The name is the design doc's, chosen so
 *   "adding SSE or long-polling later does not make the name a lie"
 *   (`docs/design/realtime-websockets.md:68`); the reason it is not built is ADR
 *   002:76-82 ("One mechanism") — no second, lower-guarantee lane before a
 *   stream-shaped feed justifies one. The ports would accept such a transport; this
 *   package does not ship one.
 * - **A server upgrade adapter.** `apps/api` owns wrapping its own framework's
 *   upgraded socket (Hono's, `Deno.upgradeWebSocket`'s, or another's) into
 *   `ManagedSocket` for `registry.attach`, because only the host knows its
 *   upgrade path and its cookie handling. The _client_ side is different: a
 *   browser `WebSocket` has exactly one shape, so this package now ships that
 *   adapter itself (`web-socket-adapter.ts`; see "Fixed after ship" below).
 * - **Hint coalescing.** The design doc leaves it open whether a group under rapid
 *   writes should emit at most one hint per client per interval
 *   (`docs/design/realtime-websockets.md:131-132`). `AggregateNotifier` sends one
 *   hint per committed change; a host that wants coalescing can batch before
 *   calling it, and the client is unaffected because it pulls the latest state
 *   either way. Deliberately not built on speculation.
 *
 * ### Undeclared keys are rejected by this package, not by the validator
 *
 * A frame carrying an undeclared property is refused on both `decode` and `encode`, so
 * "no mutations over the socket" is a property of the protocol rather than of the frame
 * kinds `codec.ts` happens to declare. The check is this package's own: each parsed
 * frame is compared against an explicit declared-key allow-list using **own-property**
 * membership (`Object.keys` plus the allow-list), on the frame and on every handshake
 * cursor, with a plain-object check so nothing can be read through a prototype chain.
 *
 * The validator cannot do this alone, and its strict option does not close it either:
 *
 * - arktype's default is `onUndeclaredKey: "ignore"` — extra properties are accepted and
 *   _preserved_ on the parsed value, so a hint carrying `payload` decoded, survived
 *   `encode` and reached a host's `onFrame`.
 * - `@ark/schema@0.56.2` decides declaredness with `k in this.propsByKey`
 *   (`out/structure/structure.js`), and `in` walks the prototype chain. All twelve
 *   `Object.prototype` member names — `__proto__`, `constructor`, `toString`, `valueOf`,
 *   `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`,
 *   `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` — are
 *   therefore read as _declared_, and `@ark/util@0.56.2/out/flatMorph.js` starts its morph
 *   target from `{}`, so they survive onto the parsed value, own and enumerable.
 *   Measured: 12 of 12 passed both `decode` and `encode` and reached `onFrame`, with **or
 *   without** `"+": "reject"` on the schemas.
 *
 * That last measurement is why the schemas carry **no** undeclared-key marker: with the
 * allow-list in place, removing the marker leaves the whole suite green, so it would be a
 * line no test can distinguish. One mechanism, and it is the one with tests.
 *
 * Own-property membership is the right test because it is the only thing that can travel:
 * JSON serialises own enumerable properties only, and `JSON.parse` never produces an
 * inherited one. The dependency's behaviour is documented rather than patched — this
 * package does not fork arktype; the guard is a handful of lines next to the schemas it
 * protects, and mutating it reddens nine tests.
 *
 * The rule is exported as `findUndeclaredKey` so it can be pinned on its own, because it
 * must stay a _declared-set_ check rather than a prototype-name blacklist. A blacklist
 * would reject a legitimate key whose name happens to exist on `Object.prototype`, and
 * would accept nothing else it is supposed to: the test "accepts a declared key whose name
 * also exists on `Object.prototype`" (with `toString` and `__proto__` passed as declared)
 * fails against that rewrite, and no frame in this protocol declares such a key today, so
 * no wire-level test could hold the property. Two acceptance tests pin it — one with an
 * explicit declared list, one deriving the list from a synthetic arktype schema whose
 * declared keys include `toString`. Measured: rewriting the predicate as a blacklist
 * reddens six tests, while _adding_ a blacklist beside the allow-list reddens exactly those
 * two and nothing else in the suite, which is what makes them non-redundant.
 *
 * @module
 */

export { type Clock, createSystemClock, type TimerClock, type TimerHandle } from "./clock.ts"

export {
  type BackoffConfig,
  type BackoffOptions,
  DEFAULT_BACKOFF,
  nextBackoffDelay,
} from "./backoff.ts"

export {
  type ChangeHint,
  type ClientCommandMessage,
  type ClientMessage,
  type ClientQueryMessage,
  type ClientRequestMessage,
  createError,
  createHint,
  createJsonCodec,
  createResult,
  type DecodeResult,
  findUndeclaredKey,
  isChangeHint,
  type MessageCodec,
  type ServerErrorMessage,
  type ServerMessage,
  type ServerResultMessage,
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

export {
  describeError,
  isRealtimeErrorCode,
  REALTIME_ERROR_CODES,
  type RealtimeErrorCode,
  RealtimeRequestError,
  type RealtimeRequestErrorOptions,
} from "./errors.ts"

export { type KeyValueStore, MemoryKeyValueStore } from "./storage.ts"

export {
  type CloseHandler,
  CloseReason,
  type ConnectionHandle,
  ConnectionRegistry,
  type ConnectionRegistryOptions,
  type EncodeFailure,
  type FrameContext,
  type FrameHandler,
  type MalformedFrame,
  type MalformedFrameHandler,
  type OpenHandler,
  type RegistryCloseInfo,
  type RequestContext,
  type RequestDispatcher,
} from "./registry.ts"

export {
  CALL_ERROR_STATUS,
  type CallErrorContext,
  type CallHandler,
  type CallHandlerOptions,
  createCallHandler,
  createOperationDispatcher,
  DEFAULT_MAX_CALL_BYTES,
  expectNoPayload,
  IDEMPOTENCY_KEY_HEADER,
  isBoundToUser,
  type Operation,
  type OperationCall,
  type OperationDispatcherOptions,
  type OperationErrorMapper,
  type Operations,
  parsePayload,
  REALTIME_USER_HEADER,
} from "./operations.ts"

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
  type CallOptions,
  ClientTransport,
  type ClientTransportOptions,
  type CommandOptions,
  ConnectionLostError,
  ConnectTimeoutError,
  type CursorPort,
  type GateResult,
  type HandshakeAcknowledgedEvent,
  PongTimeoutError,
  type RequestOptions,
  RequestTimeoutError,
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
  type AdaptWebSocketOptions,
  createWebSocketFactory,
  mapReadyState,
  type NativeSocketLike,
} from "./web-socket-adapter.ts"

export {
  type AvailableCallPort,
  type CallPort,
  type CallPortCommandOptions,
  type CallPortOptions,
  type ComposedCallPortOptions,
  createComposedCallPort,
  createHttpCallPort,
  createSocketCallPort,
  type HttpCallPortOptions,
  isForeignAnswer,
  isRetryable,
  isUnknownOutcome,
  type RetryOptions,
  sendCommand,
  sendQuery,
  type SocketCallTransport,
  withUnauthorizedHook,
} from "./calls.ts"
