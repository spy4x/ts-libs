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
 */

import {
  type ClientMessage,
  createJsonCodec,
  type MessageCodec,
  type ServerMessage,
} from "./codec.ts"
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
}

interface Connection {
  readonly id: string
  readonly userId: string
  readonly socket: ManagedSocket
  lastSeenAt: number
  announced: boolean
  readonly unsubscribes: Unsubscribe[]
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000

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
  }

  /**
   * Adopt an opened socket for a user.
   *
   * The user map is many-to-one by design: a user with a tab and a phone has two sockets and one
   * user id, and both must receive a hint. Returns a {@link ConnectionHandle} the caller keeps for
   * `send`, and registers the socket's own handlers so cleanup cannot be forgotten by the host.
   */
  attach(userId: string, socket: ManagedSocket): ConnectionHandle {
    const connection: Connection = {
      id: `socket-${this.#nextSocketId++}`,
      userId,
      socket,
      lastSeenAt: this.#clock.now(),
      announced: false,
      unsubscribes: [],
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

  /** Remove a socket without closing it. Rarely needed: the close handler does this. */
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
   * Ping is answered here; everything else either goes to the frame handlers or is dropped with a
   * reason. Nothing is dispatched that the registry could not decode.
   */
  #receive(connection: Connection, data: string): void {
    connection.lastSeenAt = this.#clock.now()
    const result = this.#codec.decode(data)
    if (!result.ok) {
      this.#reportMalformed(connection, result.reason)
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
    this.#reportMalformed(
      connection,
      `frame kind "${message.kind}" is server-to-client`,
    )
  }

  /** Encode and send, reaping the socket when the send throws. */
  #deliver(connection: Connection, message: ServerMessage): boolean {
    if (connection.socket.state !== SocketState.Open) return false
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
  return reason === CloseReason.Remote ? 1000 : 1001
}

/** Human-readable close reason, small enough to fit in a close frame. */
function reasonText(reason: CloseReason): string {
  const names: Record<CloseReason, string> = {
    [CloseReason.Remote]: "closed",
    [CloseReason.LivenessTimeout]: "liveness timeout",
    [CloseReason.SendFailed]: "send failed",
    [CloseReason.Shutdown]: "server shutdown",
  }
  return names[reason] ?? "closed"
}

/** One-line rendering of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
