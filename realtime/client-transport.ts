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
 * - A pushed hint is applied only when its sequence is contiguous with the stored cursor. On a gap
 *   the hint is discarded and `pull` is called with the cursor the client actually holds, so a
 *   missed frame costs one redundant REST pull instead of silently divergent local state.
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
  aggregate: string
  sequence: number
}

/** Snapshot of transport state, delivered to `onStatus` listeners. */
export interface TransportStatusSnapshot {
  status: TransportStatus
  /** Reconnect attempts since the last successful open. */
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
  /** The REST pull a gap falls back to. Hints are an optimisation; this is the authority. */
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

  /** The socket opened: reset the attempt counter, start the heartbeat, handshake. */
  #handleOpen(socket: ManagedSocket): void {
    if (this.#socket !== socket) return
    this.#clearConnectTimer()
    this.#attempt = 0
    this.#setStatus(TransportStatus.Open)
    this.#startHeartbeat()
    this.#enqueue(() => this.#handshake())
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
   */
  #handleMessage(socket: ManagedSocket, data: string): void {
    if (this.#socket !== socket) return
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
          aggregate: result.message.aggregate,
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
   * Decide one hint against the durable cursor.
   *
   * Applied → fan out to `onChange`. Duplicate or old → ignored without touching the cursor. Gap →
   * discarded, and the pull is called with the cursor the client holds, which is what makes a
   * missed frame cost one redundant pull instead of divergent state.
   */
  async #applyHint(hint: AppliedHint): Promise<void> {
    const outcome = await this.#options.cursors.apply(hint)
    if (outcome.status === ApplyStatus.Gap) {
      await this.#pull(outcome.gap)
      return
    }
    if (outcome.status === ApplyStatus.Applied) {
      for (const handler of this.#changeHandlers) handler(hint, outcome)
    }
  }

  /**
   * Run the authoritative REST pull, surfacing a failure instead of swallowing it.
   *
   * A pull that succeeds is also the moment the client is genuinely in sync, so the time is
   * recorded through the cursor port — durably, which is what the source's in-memory signal was not.
   */
  async #pull(gap: GapReport): Promise<void> {
    try {
      await this.#options.pull(gap)
    } catch (error) {
      this.#report(toError(error))
      return
    }
    this.#options.cursors.markSynced?.()
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
