/**
 * Client transport: acks, heartbeat, backoff and the sync handshake — hint-only, no mutations.
 *
 * Ported in behaviour from `financy/apps/web/src/state/ws.ts` and rebuilt without signals, without
 * Preact and without a module-level mutable singleton, so it is testable in Deno with a fake socket
 * and a fake clock. A signals binding is a thin wrapper over this class and belongs in the
 * component library, not here.
 *
 * The ADR 002 invariant shows up in three places:
 *
 * - The transport sends no application mutation. Its outbound vocabulary is liveness and a sync
 *   handshake; {@link ClientTransport.send} is typed to {@link ClientMessage}, which has no
 *   mutation frame.
 * - A hint carries no payload — only a sequence — so arrival alone can never mean the client has
 *   the data. Every hint that is not a duplicate, contiguous or not, is pulled from the cursor the
 *   client already holds before anything moves; a gap and a merely-contiguous hint cost exactly
 *   the same one REST pull, and the durable cursor advances only once that pull has succeeded.
 * - A failed handshake is reported as degraded, not fatal: the socket is an optimisation and the
 *   REST pull path stays correct without it.
 *
 * What changed from the source, and why:
 *
 * - The sync handshake sends the persisted cursor. Financy sent a hardcoded `0` with a TODO, so
 *   every connect re-downloaded every model.
 * - `syncedAt` is no longer a signal that dies with the tab: cursors and the last successful sync
 *   live in an injected {@link KeyValueStore}, read lazily, never at import time.
 * - Reconnect is exponential with jitter and a cap instead of a fixed random interval forever.
 * - Every timer is injected, so nothing here sleeps and every deadline below is asserted.
 * - A failed reconnect gate stops the loop instead of being ignored; a gate that throws is retried
 *   on the next backoff step rather than treated as consent.
 * - A hint's sequence is no longer trusted as "received" on arrival (issue #65, finding 1): the
 *   position now moves forward only once the pull it triggers has actually succeeded.
 * - A reconnect always pulls every group the client holds a cursor for (issue #65, finding 2): a
 *   quiet group's gap used to surface only when a later hint happened to reveal it, which in a
 *   quiet group could be never.
 * - The reconnect backoff counter resets only once the connection has proven itself — its first
 *   inbound message — rather than at the moment the socket merely opens (issue #65, finding 3): a
 *   server that accepts and immediately drops every attempt no longer causes a reconnect storm.
 */

import { type BackoffConfig, DEFAULT_BACKOFF, nextBackoffDelay } from "./backoff.ts"
import type { Clock, TimerHandle } from "./clock.ts"
import {
  type ClientMessage,
  createJsonCodec,
  type MessageCodec,
  type ServerMessage,
  toWireCursors,
} from "./codec.ts"
import type { ApplyOutcome, GapReport, SequenceChange, SyncRequest } from "./cursor.ts"
import { ApplyStatus } from "./cursor.ts"
import {
  type ManagedSocket,
  type SocketCloseInfo,
  type SocketFactory,
  SocketState,
  type Unsubscribe,
} from "./socket-port.ts"

/** Where the transport is in its lifecycle. */
export enum TransportStatus {
  /** Not connected and not trying. */
  Idle = 1,
  /** A socket exists and has not opened yet. */
  Connecting = 2,
  /** Connected. */
  Open = 3,
  /** Waiting out a backoff delay before the next attempt. */
  Reconnecting = 4,
  /** Terminal: `stop()` was called, or the reconnect gate refused. */
  Stopped = 5,
}

/** A `change.hint` that was contiguous with the cursor and therefore applied. */
export interface AppliedHint {
  groupId: string
  /** Present when the server named the aggregate; the cursor rule never depends on it. */
  aggregate?: string
  sequence: number
}

/** Snapshot of transport state, delivered to `onStatus` listeners. */
export interface TransportStatusSnapshot {
  status: TransportStatus
  /**
   * Reconnect attempts since the connection last proved itself healthy — its first inbound
   * message, not merely the socket opening. A peer that accepts and immediately drops every
   * attempt keeps this climbing instead of resetting to zero on each open.
   */
  attempt: number
  /** Ack-tracked requests still waiting for a response. */
  pendingRequests: number
  /** Message of the last error reported, or `null`. */
  lastError: string | null
}

/** Options for one ack-tracked {@link ClientTransport.request}. */
export interface RequestOptions {
  /** Milliseconds to wait for the matching `server.ack`. Defaults to the transport's ack timeout. */
  timeoutMs?: number
  /** Total send attempts including the first. Defaults to `1`: no retry. */
  maxAttempts?: number
}

/** Outcome of the reconnect gate — typically `GET /api/auth/me`. */
export interface GateResult {
  allowed: boolean
  reason?: string
}

/** Durable cursors: what to advertise on connect, and where a hint lands. */
export interface CursorPort {
  /** The handshake payload: the real cursors, or an explicit cold start. */
  syncRequest(): SyncRequest | Promise<SyncRequest>
  /**
   * Current cursor for one group, read-only. Used to decide whether a hint is new — and, if so,
   * what range to fetch — before anything is persisted. `PersistentCursorStore.cursorFor` and
   * `CursorTracker.cursorFor` already satisfy this; it is a read the transport did not previously
   * have a way to ask for without also committing.
   */
  cursorFor(groupId: string): number | Promise<number>
  /** Apply a pushed sequence. `PersistentCursorStore` satisfies this port. */
  apply(change: SequenceChange): ApplyOutcome | Promise<ApplyOutcome>
  /**
   * Record that a pull reached the server, so the sync time survives a reload.
   *
   * Optional so a stateless cursor source stays valid; `PersistentCursorStore` implements it over
   * its injected storage and clock.
   */
  markSynced?(at?: number): number | void
}

/** Options for {@link ClientTransport}. */
export interface ClientTransportOptions {
  /** Socket URL. The transport never builds one from `location`. */
  url: string
  socketFactory: SocketFactory
  clock: Clock
  cursors: CursorPort
  /**
   * The REST pull that confirms a change and is the only thing that may move the cursor.
   *
   * Called for every hint that is not a duplicate — a genuine gap and a merely-contiguous hint
   * both go through it, with the range the client still needs — and once after every reconnect,
   * for each group the client already holds a cursor for. Hints tell the transport *when* to
   * pull; this is what confirms the client actually has the data.
   */
  pull: (gap: GapReport) => void | Promise<void>
  /** Checked before every reconnect attempt. A refusal stops reconnecting. */
  gate?: () => GateResult | Promise<GateResult>
  codec?: MessageCodec
  /** Interval between client pings. */
  heartbeatIntervalMs?: number
  /** Time a ping may go unanswered before the socket is presumed dead. */
  pongTimeoutMs?: number
  /** Time a socket may stay unopened before the attempt is abandoned. */
  connectTimeoutMs?: number
  /** Default ack timeout. */
  ackTimeoutMs?: number
  /** Ack timeout for the sync handshake. */
  handshakeAckTimeoutMs?: number
  /** Send attempts for the sync handshake, including the first. */
  handshakeAttempts?: number
  /** Backoff schedule for reconnects. */
  backoff?: Partial<BackoffConfig>
  /** Uniform source in `[0, 1)` for jitter. Injected so tests are deterministic. */
  random?: () => number
  /** Called for every error the transport surfaces. Errors are never swallowed. */
  onError?: (error: Error) => void
}

/** Timed out waiting for an acknowledgement. */
export class AckTimeoutError extends Error {
  readonly frameId: string
  readonly attempts: number
  readonly timeoutMs: number

  constructor(frameId: string, attempts: number, timeoutMs: number) {
    super(
      `no acknowledgement for frame "${frameId}" after ${attempts} attempt(s)`,
    )
    this.name = "AckTimeoutError"
    this.frameId = frameId
    this.attempts = attempts
    this.timeoutMs = timeoutMs
  }
}

/** The socket closed while a request was outstanding, or a send was attempted while closed. */
export class ConnectionLostError extends Error {
  constructor(detail: string) {
    super(`connection is not usable: ${detail}`)
    this.name = "ConnectionLostError"
  }
}

/** The peer stopped answering pings. */
export class PongTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no pong within ${timeoutMs}ms; closing the socket`)
    this.name = "PongTimeoutError"
  }
}

/** A socket did not open inside the connect-attempt timeout. */
export class ConnectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`socket did not open within ${timeoutMs}ms`)
    this.name = "ConnectTimeoutError"
  }
}

/** The reconnect gate refused. Reconnecting stops until `connect()` is called again. */
export class AuthGateError extends Error {
  constructor(reason: string) {
    super(`reconnect refused by the auth gate: ${reason}`)
    this.name = "AuthGateError"
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

interface PendingRequest {
  readonly id: string
  readonly frame: ClientMessage & { id: string }
  readonly deferred: Deferred<ServerMessage>
  readonly timeoutMs: number
  readonly maxAttempts: number
  attempts: number
  timer: TimerHandle | null
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_PONG_TIMEOUT_MS = 7_500
const DEFAULT_CONNECT_TIMEOUT_MS = 7_500
const DEFAULT_ACK_TIMEOUT_MS = 5_000
const DEFAULT_HANDSHAKE_ATTEMPTS = 2

/**
 * A reconnecting client transport over an injected socket factory.
 *
 * One instance per client. `connect()` starts the state machine; `stop()` ends it and leaves no
 * pending timer. Listeners are registered per concern (`onFrame`, `onChange`, `onStatus`,
 * `onError`, `onSyncDegraded`) and each registration returns its own unsubscribe, so no listener
 * set can outlive the component that added it.
 */
export class ClientTransport {
  readonly #options: ClientTransportOptions
  readonly #clock: Clock
  readonly #codec: MessageCodec
  readonly #heartbeatIntervalMs: number
  readonly #pongTimeoutMs: number
  readonly #connectTimeoutMs: number
  readonly #ackTimeoutMs: number
  readonly #handshakeAckTimeoutMs: number
  readonly #handshakeAttempts: number
  readonly #backoff: BackoffConfig
  readonly #random: () => number
  readonly #pending = new Map<string, PendingRequest>()
  readonly #frameHandlers = new Set<(message: ServerMessage) => void>()
  readonly #changeHandlers = new Set<
    (hint: AppliedHint, outcome: ApplyOutcome) => void
  >()
  readonly #statusHandlers = new Set<
    (snapshot: TransportStatusSnapshot) => void
  >()
  readonly #errorHandlers = new Set<(error: Error) => void>()
  readonly #degradedHandlers = new Set<(error: Error) => void>()

  #socket: ManagedSocket | null = null
  #unsubscribes: Unsubscribe[] = []
  #status: TransportStatus = TransportStatus.Idle
  #lastError: Error | null = null
  #attempt = 0
  #stopped = false
  #frameCounter = 0
  /** Whether the current socket has produced any inbound message yet; gates the backoff reset. */
  #connectionProven = false
  #heartbeatTimer: TimerHandle | null = null
  #pongTimer: TimerHandle | null = null
  #connectTimer: TimerHandle | null = null
  #reconnectTimer: TimerHandle | null = null
  #hintChain: Promise<void> = Promise.resolve()

  constructor(options: ClientTransportOptions) {
    this.#options = options
    this.#clock = options.clock
    this.#codec = options.codec ?? createJsonCodec()
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ??
      DEFAULT_HEARTBEAT_INTERVAL_MS
    this.#pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS
    this.#connectTimeoutMs = options.connectTimeoutMs ??
      DEFAULT_CONNECT_TIMEOUT_MS
    this.#ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.#handshakeAckTimeoutMs = options.handshakeAckTimeoutMs ??
      this.#ackTimeoutMs
    this.#handshakeAttempts = Math.max(
      1,
      options.handshakeAttempts ?? DEFAULT_HANDSHAKE_ATTEMPTS,
    )
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff }
    this.#random = options.random ?? Math.random
  }

  /** Current lifecycle state. */
  get status(): TransportStatus {
    return this.#status
  }

  /** Current state plus counters, for a status listener or a debug read. */
  get statusSnapshot(): TransportStatusSnapshot {
    return {
      status: this.#status,
      attempt: this.#attempt,
      pendingRequests: this.#pending.size,
      lastError: this.#lastError?.message ?? null,
    }
  }

  /** Requests still waiting for an acknowledgement. Zero means nothing was dropped. */
  get pendingRequests(): number {
    return this.#pending.size
  }

  /** Start connecting. A no-op while connecting or open. */
  connect(): void {
    if (
      this.#status === TransportStatus.Connecting ||
      this.#status === TransportStatus.Open
    ) {
      return
    }
    this.#stopped = false
    this.#attempt = 0
    this.#clearReconnectTimer()
    this.#openSocket()
  }

  /** Stop for good: clear every timer, close the socket, fail outstanding requests. */
  stop(): void {
    this.#stopped = true
    this.#clearTimers()
    const socket = this.#socket
    this.#rejectAllPending(new ConnectionLostError("transport stopped"))
    if (socket) {
      socket.close(1000, "client stop")
      if (this.#socket === socket) this.#forgetSocket()
    }
    this.#setStatus(TransportStatus.Stopped)
  }

  /** Send one frame if the socket is open. Returns whether it was handed to the socket. */
  send(message: ClientMessage): boolean {
    return this.#send(message)
  }

  /**
   * Send a frame and resolve with the `server.ack` that answers it.
   *
   * On timeout the frame is re-sent while attempts remain; when they are exhausted the returned
   * promise rejects with {@link AckTimeoutError}. An unacknowledged frame is therefore never
   * dropped quietly — it is either retried or surfaced.
   */
  request(
    message: ClientMessage,
    options: RequestOptions = {},
  ): Promise<ServerMessage> {
    const socket = this.#socket
    if (!socket || socket.state !== SocketState.Open) {
      return Promise.reject(
        new ConnectionLostError("no open socket to send on"),
      )
    }

    const frame = { ...message, id: message.id ?? this.#nextFrameId() } as
      & ClientMessage
      & {
        id: string
      }
    const deferred = createDeferred<ServerMessage>()
    // The caller's await still receives the rejection; this handler only stops an ignored
    // rejection from becoming an unhandled one and taking the process down.
    void deferred.promise.catch(() => {})

    const pending: PendingRequest = {
      id: frame.id,
      frame,
      deferred,
      timeoutMs: options.timeoutMs ?? this.#ackTimeoutMs,
      maxAttempts: Math.max(1, options.maxAttempts ?? 1),
      attempts: 0,
      timer: null,
    }
    this.#pending.set(pending.id, pending)
    this.#attemptSend(pending)
    return deferred.promise
  }

  /** Every decoded server frame except liveness. Returns an unsubscribe. */
  onFrame(handler: (message: ServerMessage) => void): Unsubscribe {
    this.#frameHandlers.add(handler)
    return () => this.#frameHandlers.delete(handler)
  }

  /** Hints that were contiguous with the cursor and applied. Returns an unsubscribe. */
  onChange(
    handler: (hint: AppliedHint, outcome: ApplyOutcome) => void,
  ): Unsubscribe {
    this.#changeHandlers.add(handler)
    return () => this.#changeHandlers.delete(handler)
  }

  /** Status changes, including the attempt counter and the last error message. */
  onStatus(handler: (snapshot: TransportStatusSnapshot) => void): Unsubscribe {
    this.#statusHandlers.add(handler)
    return () => this.#statusHandlers.delete(handler)
  }

  /** Every error the transport surfaces. Returns an unsubscribe. */
  onError(handler: (error: Error) => void): Unsubscribe {
    this.#errorHandlers.add(handler)
    return () => this.#errorHandlers.delete(handler)
  }

  /**
   * The sync handshake failed.
   *
   * A host that keeps a polling pull loop running against REST needs this signal to know the hint
   * lane is down. It is not an error the transport recovers from by itself: the socket stays
   * connected, because a socket that cannot handshake can still deliver hints and liveness.
   */
  onSyncDegraded(handler: (error: Error) => void): Unsubscribe {
    this.#degradedHandlers.add(handler)
    return () => this.#degradedHandlers.delete(handler)
  }

  /** Open one socket and wire its handlers. */
  #openSocket(): void {
    if (this.#socket && this.#socket.state !== SocketState.Closed) return
    this.#setStatus(TransportStatus.Connecting)

    let socket: ManagedSocket
    try {
      socket = this.#options.socketFactory(this.#options.url)
    } catch (error) {
      this.#report(toError(error))
      this.#scheduleReconnect()
      return
    }

    this.#attachSocket(socket)
    if (socket.state === SocketState.Open) {
      this.#handleOpen(socket)
      return
    }
    this.#connectTimer = this.#clock.setTimeout(
      () => this.#handleConnectTimeout(socket),
      this.#connectTimeoutMs,
    )
  }

  /** Register handlers for one socket, replacing any previous socket's registrations. */
  #attachSocket(socket: ManagedSocket): void {
    this.#forgetSocket()
    this.#socket = socket
    this.#connectionProven = false
    this.#unsubscribes = [
      socket.onOpen(() => this.#handleOpen(socket)),
      socket.onMessage((data) => this.#handleMessage(socket, data)),
      socket.onClose((info) => this.#handleClose(socket, info)),
    ]
  }

  /** Drop handlers and state for the current socket. */
  #forgetSocket(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    this.#socket = null
  }

  /**
   * The socket opened: start the heartbeat, handshake, and — on a reconnect — pull every group the
   * client already holds a cursor for.
   *
   * The attempt counter is deliberately *not* reset here (issue #65, finding 3): a socket that
   * merely opened has not been proven healthy yet, only {@link #handleMessage}'s first inbound
   * frame does that. Resetting on open is what let a server that accepts and immediately drops
   * every attempt keep every reconnect delay at the base value forever.
   *
   * A reconnect — as opposed to the transport's first ever connect — also pulls every group the
   * client holds a cursor for (issue #65, finding 2): a gap opened while the socket was down would
   * otherwise surface only if a later hint happened to reveal it, which in a quiet group may never
   * happen. `attempt > 0` at this point is exactly "a reconnect": `connect()` starts it at zero and
   * only `#scheduleReconnect` ever increments it, always before the attempt that follows.
   *
   * The handshake is *not* put on {@link #enqueue}'s chain. That chain serialises cursor decisions so
   * hints are applied in arrival order; a handshake touches no cursor, and chaining it would delay
   * every inbound hint until the server acknowledged the handshake — up to
   * `handshakeAttempts × handshakeAckTimeout`, ten seconds by default. A hint that arrives while the
   * handshake is unanswered is decided immediately.
   *
   * The cursor snapshot is therefore taken at whatever moment the handshake runs, so it may be
   * fresher or staler than the cursors were when the socket opened. A stale floor is safe: the server
   * replays changes the client has already applied, and those land in {@link ApplyStatus.Duplicate},
   * never in a gap. This is a resume hint, not an authorization decision — auth happens at the
   * upgrade, and the reconnect gate runs before a socket is opened at all.
   */
  #handleOpen(socket: ManagedSocket): void {
    if (this.#socket !== socket) return
    this.#clearConnectTimer()
    const isReconnect = this.#attempt > 0
    this.#setStatus(TransportStatus.Open)
    this.#startHeartbeat()
    void this.#handshake().catch((error: unknown) => this.#report(toError(error)))
    if (isReconnect) this.#enqueue(() => this.#pullAfterReconnect())
  }

  /** The socket never opened in time. Abandon the attempt and let the close path reconnect. */
  #handleConnectTimeout(socket: ManagedSocket): void {
    this.#connectTimer = null
    if (this.#socket !== socket || socket.state === SocketState.Open) return
    this.#report(new ConnectTimeoutError(this.#connectTimeoutMs))
    try {
      socket.close(1001, "connect timeout")
    } catch {
      // A transport that cannot even close is treated as already gone.
    }
    if (this.#socket === socket) {
      this.#forgetSocket()
      this.#scheduleReconnect()
    }
  }

  /**
   * One inbound frame.
   *
   * Everything decoded here is one of: liveness, an acknowledgement, or a change hint. The first
   * two are handled locally; a hint goes through the cursor and the serialised apply chain, so
   * hints are decided in arrival order even when the cursor store is asynchronous.
   *
   * The first frame on a socket is also what proves the connection healthy and resets the backoff
   * counter (issue #65, finding 3). Any frame counts, decodable or not: bytes arriving at all is
   * what a socket that opened and was immediately dropped never produces.
   */
  #handleMessage(socket: ManagedSocket, data: string): void {
    if (this.#socket !== socket) return
    if (!this.#connectionProven) {
      this.#connectionProven = true
      this.#attempt = 0
    }
    const result = this.#codec.decode(data)
    if (!result.ok) {
      this.#report(new Error(`dropped a malformed frame: ${result.reason}`))
      return
    }

    switch (result.message.kind) {
      case "server.ping":
        this.#send({
          kind: "client.pong",
          ...(result.message.id ? { id: result.message.id } : {}),
        })
        return
      case "server.pong":
        this.#clearPongTimer()
        return
      case "server.ack":
        this.#settleAck(result.message.ackId, result.message)
        this.#emitFrame(result.message)
        return
      case "change.hint": {
        const hint: AppliedHint = {
          groupId: result.message.groupId,
          ...(result.message.aggregate !== undefined
            ? { aggregate: result.message.aggregate }
            : {}),
          sequence: result.message.sequence,
        }
        this.#emitFrame(result.message)
        this.#enqueue(() => this.#applyHint(hint))
        return
      }
      default:
        this.#report(
          new Error(
            `dropped a frame sent in the wrong direction: ${result.message.kind}`,
          ),
        )
    }
  }

  /**
   * Decide one hint against the durable cursor, then fetch before the position moves.
   *
   * A hint carries no payload — only a sequence — so its arrival is never proof the client holds
   * the data (issue #65, finding 1). Duplicate or older than the cursor → nothing new arrived,
   * ignored, no pull. Anything else — a genuine gap or a hint that is merely the next sequence — is
   * pulled first, with the range the client still needs; only once that pull has actually succeeded
   * is `cursors.apply` called, which is the one place the durable position moves. A failed pull
   * leaves the cursor exactly where it was, and a hint that turns out to still be a gap after the
   * pull (the app's own pull handler did not catch it up) is left for the next one, exactly as
   * before.
   */
  async #applyHint(hint: AppliedHint): Promise<void> {
    const cursor = await this.#options.cursors.cursorFor(hint.groupId)
    if (hint.sequence <= cursor) return

    const ok = await this.#runPull({
      groupId: hint.groupId,
      since: cursor,
      received: hint.sequence,
    })
    if (!ok) return

    const outcome = await this.#options.cursors.apply(hint)
    this.#options.cursors.markSynced?.()
    if (outcome.status === ApplyStatus.Applied) {
      for (const handler of this.#changeHandlers) handler(hint, outcome)
    }
  }

  /**
   * After a reconnect, pull every group the client already holds a cursor for (issue #65, finding
   * 2). A cold client — no cursors yet — has nothing to pull; its first fetch is the app's own
   * bootstrap, which this package does not own (see README, "Explicitly not implemented").
   */
  async #pullAfterReconnect(): Promise<void> {
    const request = await this.#options.cursors.syncRequest()
    for (const cursor of request.cursors) {
      const ok = await this.#runPull({
        groupId: cursor.groupId,
        since: cursor.sequence,
        received: cursor.sequence,
      })
      if (ok) this.#options.cursors.markSynced?.()
    }
  }

  /**
   * Run the app's REST pull, surfacing a failure instead of swallowing it. Returns whether it
   * succeeded; the caller decides what — if anything — may be persisted as a result.
   */
  async #runPull(gap: GapReport): Promise<boolean> {
    try {
      await this.#options.pull(gap)
      return true
    } catch (error) {
      this.#report(toError(error))
      return false
    }
  }

  /**
   * Announce the client's real cursors on connect.
   *
   * A handshake that fails is reported as degraded, never retried forever and never allowed to
   * throw into the void: a socket that cannot handshake can still receive hints, and the REST pull
   * path is correct on its own.
   */
  async #handshake(): Promise<void> {
    const request = await this.#options.cursors.syncRequest()
    const frame: ClientMessage = {
      kind: "client.sync",
      cursors: toWireCursors(request.cursors),
      fromStart: request.fromStart,
    }
    try {
      await this.request(frame, {
        timeoutMs: this.#handshakeAckTimeoutMs,
        maxAttempts: this.#handshakeAttempts,
      })
    } catch (error) {
      const failure = toError(error)
      this.#report(failure)
      for (const handler of this.#degradedHandlers) handler(failure)
    }
  }

  /** The socket closed. Reconnect unless the transport was stopped or a gate refused. */
  #handleClose(socket: ManagedSocket, info: SocketCloseInfo): void {
    if (this.#socket !== socket) return
    this.#clearTimers()
    this.#forgetSocket()
    this.#rejectAllPending(
      new ConnectionLostError(`closed with code ${info.code}`),
    )
    if (this.#stopped) {
      this.#setStatus(TransportStatus.Stopped)
      return
    }
    this.#scheduleReconnect()
  }

  /** Back off, then try again through the gate. */
  #scheduleReconnect(): void {
    if (this.#stopped) {
      this.#setStatus(TransportStatus.Stopped)
      return
    }
    this.#clearReconnectTimer()
    const delay = nextBackoffDelay({
      ...this.#backoff,
      attempt: this.#attempt,
      random: this.#random,
    })
    this.#attempt += 1
    this.#setStatus(TransportStatus.Reconnecting)
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = null
      this.#enqueue(() => this.#attemptReconnect())
    }, delay)
  }

  /**
   * One reconnect attempt.
   *
   * The gate is asked first. A refusal stops the loop — a signed-out client retrying forever is how
   * a server ends up with a reconnect storm. A gate that *throws* has not answered, so the attempt
   * is deferred to the next backoff step rather than being treated as permission.
   */
  async #attemptReconnect(): Promise<void> {
    if (this.#stopped) return
    const gate = this.#options.gate
    if (gate) {
      let result: GateResult
      try {
        result = await gate()
      } catch (error) {
        this.#report(toError(error))
        this.#scheduleReconnect()
        return
      }
      if (!result.allowed) {
        this.#stopped = true
        this.#report(new AuthGateError(result.reason ?? "not authenticated"))
        this.#setStatus(TransportStatus.Stopped)
        return
      }
    }
    this.#openSocket()
  }

  #startHeartbeat(): void {
    this.#clearHeartbeatTimer()
    this.#heartbeatTimer = this.#clock.setInterval(
      () => this.#ping(),
      this.#heartbeatIntervalMs,
    )
  }

  /** Ping the peer, and arm a deadline for the pong. */
  #ping(): void {
    if (this.#status !== TransportStatus.Open) return
    this.#send({ kind: "client.ping" })
    if (this.#pongTimer) return
    this.#pongTimer = this.#clock.setTimeout(
      () => this.#handlePongTimeout(),
      this.#pongTimeoutMs,
    )
  }

  /** The peer stopped answering. Surface it, then close so the reconnect path takes over. */
  #handlePongTimeout(): void {
    this.#pongTimer = null
    this.#report(new PongTimeoutError(this.#pongTimeoutMs))
    const socket = this.#socket
    if (!socket) return
    try {
      socket.close(1001, "pong timeout")
    } catch {
      // Already gone; the reconnect path below still runs.
    }
    if (this.#socket === socket) {
      this.#forgetSocket()
      this.#clearTimers()
      this.#scheduleReconnect()
    }
  }

  #attemptSend(pending: PendingRequest): void {
    if (!this.#send(pending.frame)) {
      this.#settleError(pending, new ConnectionLostError("socket is not open"))
      return
    }
    pending.attempts += 1
    pending.timer = this.#clock.setTimeout(
      () => this.#handleAckTimeout(pending),
      pending.timeoutMs,
    )
  }

  /** No ack in time: retry while attempts remain, otherwise fail loudly. */
  #handleAckTimeout(pending: PendingRequest): void {
    if (!this.#pending.has(pending.id)) return
    pending.timer = null
    if (pending.attempts < pending.maxAttempts) {
      this.#attemptSend(pending)
      return
    }
    this.#settleError(
      pending,
      new AckTimeoutError(pending.id, pending.attempts, pending.timeoutMs),
    )
  }

  #settleAck(ackId: string, message: ServerMessage): void {
    const pending = this.#pending.get(ackId)
    if (!pending) return
    if (pending.timer) this.#clock.clearTimeout(pending.timer)
    this.#pending.delete(pending.id)
    pending.deferred.resolve(message)
  }

  #settleError(pending: PendingRequest, error: Error): void {
    if (!this.#pending.delete(pending.id)) return
    if (pending.timer) this.#clock.clearTimeout(pending.timer)
    this.#report(error)
    pending.deferred.reject(error)
  }

  #rejectAllPending(error: Error): void {
    for (const pending of [...this.#pending.values()]) {
      this.#settleError(pending, error)
    }
  }

  /** Encode and hand one frame to the socket. Requires an open socket. */
  #send(message: ClientMessage): boolean {
    const socket = this.#socket
    if (!socket || socket.state !== SocketState.Open) return false
    let frame: string
    try {
      frame = this.#codec.encode(message)
    } catch (error) {
      this.#report(toError(error))
      return false
    }
    try {
      socket.send(frame)
      return true
    } catch (error) {
      this.#report(toError(error))
      return false
    }
  }

  /** Serialise cursor work so hints are decided in arrival order. */
  #enqueue(task: () => Promise<void>): void {
    this.#hintChain = this.#hintChain.then(task).catch((error: unknown) => {
      this.#report(toError(error))
    })
  }

  #emitFrame(message: ServerMessage): void {
    for (const handler of this.#frameHandlers) handler(message)
  }

  #report(error: Error): void {
    this.#lastError = error
    for (const handler of this.#errorHandlers) handler(error)
    this.#options.onError?.(error)
    this.#emitStatus()
  }

  #setStatus(status: TransportStatus): void {
    this.#status = status
    this.#emitStatus()
  }

  #emitStatus(): void {
    const snapshot = this.statusSnapshot
    for (const handler of this.#statusHandlers) handler(snapshot)
  }

  #nextFrameId(): string {
    this.#frameCounter += 1
    return `frame-${this.#frameCounter}`
  }

  #clearHeartbeatTimer(): void {
    if (!this.#heartbeatTimer) return
    this.#clock.clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = null
  }

  #clearPongTimer(): void {
    if (!this.#pongTimer) return
    this.#clock.clearTimeout(this.#pongTimer)
    this.#pongTimer = null
  }

  #clearConnectTimer(): void {
    if (!this.#connectTimer) return
    this.#clock.clearTimeout(this.#connectTimer)
    this.#connectTimer = null
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) return
    this.#clock.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  #clearTimers(): void {
    this.#clearHeartbeatTimer()
    this.#clearPongTimer()
    this.#clearConnectTimer()
    this.#clearReconnectTimer()
  }
}

/** A promise whose settlement is controlled from outside. */
function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null
  let rejectFn: ((error: Error) => void) | null = null
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (error) => rejectFn?.(error),
  }
}

/** Normalize an unknown thrown value. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
