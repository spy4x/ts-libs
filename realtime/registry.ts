/**
 * Connection registry: who is connected, on how many sockets, and are they still alive.
 *
 * Ported in behaviour from `gb/apps/api/services/websockets.ts` (registry + heartbeat half) and
 * redesigned around a socket port, so this module imports no WebSocket library and every behaviour
 * below is testable with a fake socket and a fake clock.
 *
 * What changed from the source, and why:
 *
 * - **Liveness is verified, not assumed.** `gb` pinged every socket every 30s and never looked for a
 *   pong, so a half-open socket stayed in the registry forever and every broadcast wrote to it. Here
 *   a socket that has not sent anything within `livenessTimeoutMs` is closed and reaped.
 * - **Reaping is eager.** Orphan cleanup happened only in the socket's own close handler, which by
 *   definition never runs for a socket that died silently. `#reap` removes the connection from both
 *   maps immediately; a later close event is a no-op.
 * - **A failing send does not abort a broadcast.** `gb`'s `sendToAll` called `send`, which threw out
 *   of the loop, so one bad socket truncated fan-out for everyone after it. Here a throwing socket is
 *   reaped and the loop continues.
 * - **One interval, not one per socket**, so the timer count does not grow with connections.
 * - **Direction is enforced.** A client frame that decodes as a server frame is dropped as malformed
 *   instead of being dispatched.
 * - **Three limits neither source enforced (issue #65, finding 5).** A user id could open an
 *   unbounded number of sockets; an oversized text frame was handed straight to the codec and the
 *   validator before anything measured it; and nothing slowed delivery to a socket whose peer had
 *   stopped reading. `attach` now refuses past `maxConnectionsPerUser`, `#receive` measures a frame
 *   before decoding it and reaps the connection past `maxMessageBytes`, and `#deliver` skips a send
 *   past `maxBufferedBytes` instead of queueing without bound. All three limits are this package's
 *   own — the upgrade handler, rate limiting per IP and anything else the surrounding server does is
 *   outside it, same as the rest of the sync protocol (see README, "Explicitly not implemented").
 * - **Requests are bounded, correlated and never dispatched by the registry.** A `client.command`
 *   or `client.query` is handed to the one dispatcher registered with {@link ConnectionRegistry.onRequest};
 *   the registry only enforces `maxInFlightRequests` per connection (a typed `rate_limited` error
 *   beyond it), rejects a request id already in flight, answers with `server.result` or a typed
 *   `server.error`, and gives up on a dispatcher that outlives `requestTimeoutMs`. What a request
 *   name means — a command bus, a query bus, authorization — is the host's.
 *
 * @module
 */

import {
  type ClientMessage,
  type ClientRequestMessage,
  createError,
  createJsonCodec,
  createResult,
  type MessageCodec,
  type ServerMessage,
} from "./codec.ts"
import { RealtimeRequestError } from "./errors.ts"
import type { Clock, TimerHandle } from "./clock.ts"
import { type ManagedSocket, SocketState, type Unsubscribe } from "./socket-port.ts"

/** Why a connection left the registry. */
export enum CloseReason {
  /** The peer or the transport closed it. */
  Remote = 1,
  /** No frame arrived within the liveness deadline. */
  LivenessTimeout = 2,
  /** A send threw; the socket is presumed broken. */
  SendFailed = 3,
  /** {@link ConnectionRegistry.shutdown} closed it. */
  Shutdown = 4,
  /** An inbound frame exceeded `maxMessageBytes`. */
  MessageTooLarge = 5,
}

/** Identifies one socket of one user. */
export interface ConnectionHandle {
  /** Registry-local id, stable for the life of the socket. */
  readonly id: string
  readonly userId: string
}

/** What a close handler is told. */
export interface RegistryCloseInfo {
  reason: CloseReason
  /** Platform close code when the peer closed, otherwise the code the registry asked for. */
  code: number
  detail?: string
}

/** A client frame the registry does not own, handed to the application. */
export interface FrameContext {
  socketId: string
  userId: string
  message: ClientMessage
}

/** A frame that could not be decoded, or arrived in the wrong direction. */
export interface MalformedFrame {
  socketId: string
  userId: string
  reason: string
}

/** A request handed to the dispatcher. `name` and `payload` are unvalidated beyond the envelope. */
export interface RequestContext {
  socketId: string
  userId: string
  /** The frame's `id`; the answer carries it as `requestId`. */
  requestId: string
  kind: "command" | "query"
  name: string
  payload: unknown
  /** Present on commands that carry one. The registry does not store or compare keys. */
  idempotencyKey?: string
  /** Aborted when the connection closes or the request times out; stop work that can be stopped. */
  signal: AbortSignal
}

/**
 * Answers one request. Return the result payload, or throw {@link RealtimeRequestError} to answer
 * with a specific code. Any other thrown value is answered as `internal` with a generic message, so
 * an exception's text never reaches a client; it goes to `onRequestError` instead.
 */
export type RequestDispatcher = (context: RequestContext) => unknown | Promise<unknown>

export type OpenHandler = (handle: ConnectionHandle) => void
export type CloseHandler = (
  handle: ConnectionHandle,
  info: RegistryCloseInfo,
) => void
export type FrameHandler = (context: FrameContext) => void
export type MalformedFrameHandler = (frame: MalformedFrame) => void

/** Options for {@link ConnectionRegistry}. */
export interface ConnectionRegistryOptions {
  clock: Clock
  /** Interval between liveness pings. */
  heartbeatIntervalMs?: number
  /** Silence after which a socket is reaped. Must exceed `heartbeatIntervalMs`. */
  livenessTimeoutMs?: number
  /** Wire codec. Defaults to the JSON codec. */
  codec?: MessageCodec
  /** Live sockets one user id may hold at once. `attach` refuses past this. */
  maxConnectionsPerUser?: number
  /** UTF-8 bytes one inbound frame may carry before it is refused unread. */
  maxMessageBytes?: number
  /** Bytes queued on a socket, past which a send to it is skipped instead of queued further. */
  maxBufferedBytes?: number
  /** Requests one connection may have unanswered at once. Beyond it a request gets `rate_limited`. */
  maxInFlightRequests?: number
  /** Milliseconds a dispatcher may take before the client is answered `timeout`. */
  requestTimeoutMs?: number
  /** Called with every value a dispatcher threw that was not a {@link RealtimeRequestError}. */
  onRequestError?: (error: unknown, context: RequestContext) => void
}

interface Connection {
  readonly id: string
  readonly userId: string
  readonly socket: ManagedSocket
  lastSeenAt: number
  announced: boolean
  readonly unsubscribes: Unsubscribe[]
  /** Unanswered request ids, each with the timer that will answer `timeout`. */
  readonly inFlight: Map<string, InFlightRequest>
}

interface InFlightRequest {
  readonly timer: TimerHandle
  readonly abort: AbortController
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000
/** Generous for a user with several tabs and devices; nowhere near the 50 000 the audit found open. */
const DEFAULT_MAX_CONNECTIONS_PER_USER = 20
/** Protocol frames are a handful of fields; 64 KiB comfortably fits a `client.sync` with many cursors. */
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024
/** Past this, a socket is presumed to have a peer that stopped reading; sends to it are skipped. */
const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000
/** Enough for a screen's worth of parallel calls. Counts unanswered requests, see `maxInFlightRequests`. */
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 16
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/**
 * Every live socket, indexed by user and by socket id.
 *
 * One registry per process. `attach` is called from the host's socket open handler; the registry
 * then owns heartbeats, liveness deadlines, orphan cleanup and fan-out. It never dispatches an
 * application action — a frame it does not own is handed to `onFrame`, which is where a host would
 * mount the sync handshake and nothing else.
 */
export class ConnectionRegistry {
  readonly #clock: Clock
  readonly #codec: MessageCodec
  readonly #heartbeatIntervalMs: number
  readonly #livenessTimeoutMs: number
  readonly #maxConnectionsPerUser: number
  readonly #maxMessageBytes: number
  readonly #maxBufferedBytes: number
  readonly #maxInFlightRequests: number
  readonly #requestTimeoutMs: number
  readonly #onRequestError: ConnectionRegistryOptions["onRequestError"]
  #requestDispatcher: RequestDispatcher | null = null
  readonly #connections = new Map<string, Connection>()
  readonly #byUser = new Map<string, Set<string>>()
  readonly #openHandlers = new Set<OpenHandler>()
  readonly #closeHandlers = new Set<CloseHandler>()
  readonly #frameHandlers = new Set<FrameHandler>()
  readonly #malformedHandlers = new Set<MalformedFrameHandler>()
  #heartbeat: TimerHandle | null = null
  #nextSocketId = 1

  constructor(options: ConnectionRegistryOptions) {
    this.#clock = options.clock
    this.#codec = options.codec ?? createJsonCodec()
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ??
      DEFAULT_HEARTBEAT_INTERVAL_MS
    this.#livenessTimeoutMs = options.livenessTimeoutMs ??
      DEFAULT_LIVENESS_TIMEOUT_MS
    this.#maxConnectionsPerUser = options.maxConnectionsPerUser ??
      DEFAULT_MAX_CONNECTIONS_PER_USER
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    this.#maxInFlightRequests = Math.max(
      1,
      options.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS,
    )
    this.#requestTimeoutMs = Math.max(
      1,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    )
    this.#onRequestError = options.onRequestError
  }

  /**
   * Adopt an opened socket for a user.
   *
   * The user map is many-to-one by design: a user with a tab and a phone has two sockets and one
   * user id, and both must receive a hint. Returns a {@link ConnectionHandle} the caller keeps for
   * `send`, and registers the socket's own handlers so cleanup cannot be forgotten by the host.
   *
   * Refuses past `maxConnectionsPerUser` (issue #65, finding 5: one user id was measured holding
   * 50 000 sockets) — the socket is closed with `1013` ("try again later") and `null` is returned
   * instead of a handle, before anything is added to either index.
   */
  attach(userId: string, socket: ManagedSocket): ConnectionHandle | null {
    const current = this.#byUser.get(userId)?.size ?? 0
    if (current >= this.#maxConnectionsPerUser) {
      try {
        socket.close(
          1013,
          `too many connections for this user (max ${this.#maxConnectionsPerUser})`,
        )
      } catch {
        // A socket that refuses to close is already gone as far as the registry is concerned.
      }
      return null
    }

    const connection: Connection = {
      id: `socket-${this.#nextSocketId++}`,
      userId,
      socket,
      lastSeenAt: this.#clock.now(),
      announced: false,
      unsubscribes: [],
      inFlight: new Map(),
    }

    connection.unsubscribes.push(
      socket.onMessage((data) => this.#receive(connection, data)),
      socket.onClose((info) => this.#drop(connection, info.code, info.reason)),
    )

    this.#connections.set(connection.id, connection)
    const sockets = this.#byUser.get(userId) ?? new Set<string>()
    sockets.add(connection.id)
    this.#byUser.set(userId, sockets)

    if (socket.state === SocketState.Open) {
      this.#announceOpen(connection)
    } else {
      connection.unsubscribes.push(
        socket.onOpen(() => this.#announceOpen(connection)),
      )
    }

    this.#startHeartbeat()
    return { id: connection.id, userId }
  }

  /**
   * Remove a socket from the registry and close it. Rarely needed: the socket's own close handler
   * does this.
   */
  detach(socketId: string): void {
    const connection = this.#connections.get(socketId)
    if (!connection) return
    this.#reap(connection, CloseReason.Remote, undefined)
  }

  /** Send to one registered socket. Returns whether the frame reached an open socket. */
  send(socketId: string, message: ServerMessage): boolean {
    const connection = this.#connections.get(socketId)
    if (!connection) return false
    return this.#deliver(connection, message)
  }

  /** Send to every socket of one user. Returns the number of sockets reached. */
  sendToUser(userId: string, message: ServerMessage): number {
    const sockets = this.#byUser.get(userId)
    if (!sockets) return 0
    let delivered = 0
    for (const socketId of [...sockets]) {
      const connection = this.#connections.get(socketId)
      if (connection && this.#deliver(connection, message)) delivered += 1
    }
    return delivered
  }

  /** Send to every socket of each listed user, each socket at most once. */
  sendToUsers(userIds: readonly string[], message: ServerMessage): number {
    const seen = new Set<string>()
    let delivered = 0
    for (const userId of userIds) {
      if (seen.has(userId)) continue
      seen.add(userId)
      delivered += this.sendToUser(userId, message)
    }
    return delivered
  }

  /**
   * Send to every connected socket.
   *
   * Kept because the source had it and a server-wide notice legitimately needs it. The aggregate
   * notify adapter cannot reach it: it is handed a `sendToUsers` port, so an unknown aggregate
   * produces zero recipients rather than a broadcast.
   */
  sendToAll(message: ServerMessage): number {
    let delivered = 0
    for (const connection of [...this.#connections.values()]) {
      if (this.#deliver(connection, message)) delivered += 1
    }
    return delivered
  }

  /** Number of live sockets for a user. */
  connectionsFor(userId: string): number {
    return this.#byUser.get(userId)?.size ?? 0
  }

  /** Number of live sockets overall. */
  count(): number {
    return this.#connections.size
  }

  /** User ids with at least one live socket, sorted. */
  userIds(): string[] {
    return [...this.#byUser.keys()].sort()
  }

  /** Called once per socket, when it is open. Returns an unsubscribe. */
  onOpen(handler: OpenHandler): Unsubscribe {
    this.#openHandlers.add(handler)
    return () => this.#openHandlers.delete(handler)
  }

  /** Called once per socket that leaves the registry, for any reason. */
  onClose(handler: CloseHandler): Unsubscribe {
    this.#closeHandlers.add(handler)
    return () => this.#closeHandlers.delete(handler)
  }

  /** Called for every client frame the registry itself does not consume (that is: `client.sync`). */
  onFrame(handler: FrameHandler): Unsubscribe {
    this.#frameHandlers.add(handler)
    return () => this.#frameHandlers.delete(handler)
  }

  /**
   * Register the one function that answers `client.command` and `client.query` frames.
   *
   * Only one: a request has exactly one answer, so two dispatchers would race. A second registration
   * throws instead of silently replacing the first. Without a dispatcher every request is answered
   * `not_found`.
   */
  onRequest(dispatcher: RequestDispatcher): Unsubscribe {
    if (this.#requestDispatcher) throw new Error("a request dispatcher is already registered")
    this.#requestDispatcher = dispatcher
    return () => {
      if (this.#requestDispatcher === dispatcher) this.#requestDispatcher = null
    }
  }

  /** Requests a connection has received and not yet answered. `0` for an unknown socket. */
  inFlightRequests(socketId: string): number {
    return this.#connections.get(socketId)?.inFlight.size ?? 0
  }

  /** Called for every frame that could not be decoded or arrived in the wrong direction. */
  onMalformedFrame(handler: MalformedFrameHandler): Unsubscribe {
    this.#malformedHandlers.add(handler)
    return () => this.#malformedHandlers.delete(handler)
  }

  /** Close every socket, stop the heartbeat and forget everyone. */
  shutdown(): void {
    for (const connection of [...this.#connections.values()]) {
      this.#reap(connection, CloseReason.Shutdown, undefined)
    }
    this.#stopHeartbeat()
  }

  /** A registered socket is open. Fire the open handlers exactly once. */
  #announceOpen(connection: Connection): void {
    if (connection.announced) return
    if (!this.#connections.has(connection.id)) return
    connection.announced = true
    connection.lastSeenAt = this.#clock.now()
    for (const handler of this.#openHandlers) {
      handler({ id: connection.id, userId: connection.userId })
    }
  }

  /**
   * Handle one inbound text frame.
   *
   * Any frame counts as liveness evidence, because a peer that is talking is a peer that is alive.
   * Size is measured before anything else — a frame past `maxMessageBytes` is refused and the
   * connection reaped without ever reaching the codec or the validator (issue #65, finding 5: a
   * single 6.9 MB message was decoded and validated, costing 81 ms of CPU it should never have
   * spent). Ping is answered here; everything else either goes to the frame handlers or is dropped
   * with a reason. Nothing is dispatched that the registry could not decode.
   */
  #receive(connection: Connection, data: string): void {
    connection.lastSeenAt = this.#clock.now()

    const bytes = new TextEncoder().encode(data).byteLength
    if (bytes > this.#maxMessageBytes) {
      const reason = `message of ${bytes} bytes exceeds the ${this.#maxMessageBytes} byte limit`
      this.#reportMalformed(connection, reason)
      this.#reap(connection, CloseReason.MessageTooLarge, reason)
      return
    }

    const result = this.#codec.decode(data)
    if (!result.ok) {
      this.#reportMalformed(connection, result.reason)
      this.#refuseMalformedRequest(connection, data, result.reason)
      return
    }

    const message = result.message
    if (message.kind === "client.ping") {
      this.#deliver(connection, {
        kind: "server.pong",
        ...(message.id ? { id: message.id } : {}),
      })
      return
    }
    if (message.kind === "client.pong") return
    if (message.kind === "client.sync") {
      const context: FrameContext = {
        socketId: connection.id,
        userId: connection.userId,
        message,
      }
      for (const handler of this.#frameHandlers) handler(context)
      return
    }
    if (message.kind === "client.command" || message.kind === "client.query") {
      this.#receiveRequest(connection, message)
      return
    }
    this.#reportMalformed(
      connection,
      `frame kind "${message.kind}" is server-to-client`,
    )
  }

  /**
   * A request frame that failed validation but carries a readable `id` is answered `bad_request`,
   * so its caller gets an error instead of waiting for a timeout. Without a usable id there is
   * nothing to correlate to, and the frame is only reported.
   */
  #refuseMalformedRequest(connection: Connection, data: string, reason: string): void {
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (typeof json !== "object" || json === null) return
    const { kind, id } = json as { kind?: unknown; id?: unknown }
    if (kind !== "client.command" && kind !== "client.query") return
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return
    this.#deliver(connection, createError(id, "bad_request", reason.slice(0, 1024)))
  }

  /**
   * Admit one request frame, run it through the dispatcher and answer it exactly once.
   *
   * The slot is taken before the dispatcher runs and released when the answer is sent. The limit
   * counts *unanswered* requests, not running work: a request answered `timeout` frees its slot at
   * once, and the dispatcher keeps running unless it honours `context.signal`. So the limit bounds
   * the work a connection can have running only for dispatchers that stop on abort. A refusal itself
   * takes no slot.
   */
  #receiveRequest(connection: Connection, message: ClientRequestMessage): void {
    const requestId = message.id
    if (connection.inFlight.has(requestId)) {
      this.#deliver(
        connection,
        createError(requestId, "bad_request", "request id is already in flight"),
      )
      return
    }
    if (connection.inFlight.size >= this.#maxInFlightRequests) {
      this.#deliver(
        connection,
        createError(
          requestId,
          "rate_limited",
          `too many requests in flight (max ${this.#maxInFlightRequests})`,
        ),
      )
      return
    }
    const dispatcher = this.#requestDispatcher
    if (!dispatcher) {
      this.#deliver(connection, createError(requestId, "not_found", "no request handler"))
      return
    }

    const abort = new AbortController()
    const timer = this.#clock.setTimeout(
      () =>
        this.#answer(connection, requestId, createError(requestId, "timeout", "request timed out")),
      this.#requestTimeoutMs,
    )
    connection.inFlight.set(requestId, { timer, abort })

    const context: RequestContext = {
      socketId: connection.id,
      userId: connection.userId,
      requestId,
      kind: message.kind === "client.command" ? "command" : "query",
      name: message.name,
      payload: message.payload,
      ...(message.kind === "client.command" && message.idempotencyKey !== undefined
        ? { idempotencyKey: message.idempotencyKey }
        : {}),
      signal: abort.signal,
    }
    const fail = (error: unknown) => {
      if (error instanceof RealtimeRequestError) {
        this.#answer(
          connection,
          requestId,
          createError(requestId, error.code, error.message, error.details),
        )
        return
      }
      try {
        this.#onRequestError?.(error, context)
      } catch {
        // A failing error hook must not leave the request unanswered.
      }
      this.#answer(connection, requestId, createError(requestId, "internal", "internal error"))
    }
    let outcome: unknown
    try {
      outcome = dispatcher(context)
    } catch (error) {
      fail(error)
      return
    }
    Promise.resolve(outcome).then(
      (payload) => this.#answer(connection, requestId, createResult(requestId, payload)),
      fail,
    )
  }

  /**
   * Send the answer for a request, once. A request already answered — by the timeout, or because the
   * connection went away — is ignored, so a late dispatcher result never reaches the wire.
   *
   * A result that cannot be encoded (a `BigInt` in the payload, say) is answered `internal` rather
   * than left for the client to time out on.
   */
  #answer(connection: Connection, requestId: string, message: ServerMessage): void {
    const request = connection.inFlight.get(requestId)
    if (request === undefined) return
    this.#clock.clearTimeout(request.timer)
    connection.inFlight.delete(requestId)
    if (message.kind === "server.error" && message.code === "timeout") request.abort.abort()
    if (this.#deliver(connection, message)) return
    // The frame could not be encoded (a message over the limit, a BigInt in the payload or the
    // details). Send the generic answer instead of leaving the client to time out; the generic
    // answer itself is never retried.
    const generic = message.kind === "server.error" && message.code === "internal" &&
      message.message === "internal error"
    if (!generic && connection.socket.state === SocketState.Open) {
      this.#deliver(connection, createError(requestId, "internal", "internal error"))
    }
  }

  /**
   * Encode and send, reaping the socket when the send throws.
   *
   * A send is skipped — not queued — once `bufferedAmount` reports more than `maxBufferedBytes`
   * still waiting to leave the socket (issue #65, finding 5: nothing previously slowed delivery to
   * a client that had stopped reading). This is safe for a hint the same way a dropped frame always
   * is: the client notices the gap itself and pulls, so skipping one delivery costs a redundant
   * pull, never divergence. `bufferedAmount` is optional on the port, so an adapter that cannot
   * report it — `FakeSocket` unless a test calls `setBufferedAmount` — is never throttled here.
   */
  #deliver(connection: Connection, message: ServerMessage): boolean {
    if (connection.socket.state !== SocketState.Open) return false
    const buffered = connection.socket.bufferedAmount
    if (buffered !== undefined && buffered > this.#maxBufferedBytes) return false
    let frame: string
    try {
      frame = this.#codec.encode(message)
    } catch (error) {
      this.#reportMalformed(connection, describeError(error))
      return false
    }
    try {
      connection.socket.send(frame)
      return true
    } catch (error) {
      this.#reap(connection, CloseReason.SendFailed, describeError(error))
      return false
    }
  }

  /** Remove a connection from every index and close the socket. Idempotent. */
  #reap(
    connection: Connection,
    reason: CloseReason,
    detail: string | undefined,
    peerCode?: number,
  ): void {
    if (!this.#connections.delete(connection.id)) return
    const sockets = this.#byUser.get(connection.userId)
    if (sockets) {
      sockets.delete(connection.id)
      if (sockets.size === 0) this.#byUser.delete(connection.userId)
    }

    for (const unsubscribe of connection.unsubscribes) unsubscribe()
    for (const request of connection.inFlight.values()) {
      this.#clock.clearTimeout(request.timer)
      request.abort.abort()
    }
    connection.inFlight.clear()
    try {
      connection.socket.close(closeCodeFor(reason), reasonText(reason))
    } catch {
      // A socket that refuses to close is already gone as far as the registry is concerned.
    }

    const code = peerCode ?? closeCodeFor(reason)
    for (const handler of this.#closeHandlers) {
      handler({ id: connection.id, userId: connection.userId }, {
        reason,
        code,
        ...(detail !== undefined ? { detail } : {}),
      })
    }

    if (this.#connections.size === 0) this.#stopHeartbeat()
  }

  /**
   * The socket's own close event.
   *
   * A connection already reaped by a heartbeat or a failed send is a no-op, and the peer's own
   * close code is what the handler sees: a host deciding whether to re-authenticate needs `1006`
   * to still look abnormal rather than being flattened to a clean close.
   */
  #drop(connection: Connection, code: number, reason: string): void {
    if (!this.#connections.has(connection.id)) return
    this.#reap(connection, CloseReason.Remote, reason || undefined, code)
  }

  #reportMalformed(connection: Connection, reason: string): void {
    const frame: MalformedFrame = {
      socketId: connection.id,
      userId: connection.userId,
      reason,
    }
    for (const handler of this.#malformedHandlers) handler(frame)
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return
    this.#heartbeat = this.#clock.setInterval(
      () => this.#beat(),
      this.#heartbeatIntervalMs,
    )
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return
    this.#clock.clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  /**
   * One liveness sweep.
   *
   * A socket silent for longer than the deadline is closed and reaped before it is pinged again;
   * every other socket gets a ping. Reaping first is what stops a dead socket from being counted in
   * fan-out for the rest of the process's life.
   */
  #beat(): void {
    const now = this.#clock.now()
    for (const connection of [...this.#connections.values()]) {
      if (now - connection.lastSeenAt >= this.#livenessTimeoutMs) {
        this.#reap(
          connection,
          CloseReason.LivenessTimeout,
          `silent for ${now - connection.lastSeenAt}ms`,
        )
        continue
      }
      this.#deliver(connection, { kind: "server.ping" })
    }
  }
}

/** Close code sent when the registry reaps a socket. */
function closeCodeFor(reason: CloseReason): number {
  if (reason === CloseReason.Remote) return 1000
  if (reason === CloseReason.MessageTooLarge) return 1009 // RFC 6455 "Message Too Big"
  return 1001
}

/** Human-readable close reason, small enough to fit in a close frame. */
function reasonText(reason: CloseReason): string {
  const names: Record<CloseReason, string> = {
    [CloseReason.Remote]: "closed",
    [CloseReason.LivenessTimeout]: "liveness timeout",
    [CloseReason.SendFailed]: "send failed",
    [CloseReason.Shutdown]: "server shutdown",
    [CloseReason.MessageTooLarge]: "message too large",
  }
  return names[reason] ?? "closed"
}

/** One-line rendering of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
