/**
 * Deterministic test doubles: clock, socket, storage, random source, fan-out.
 *
 * Shipped rather than hidden in `*.test.ts` because a host application needs the same doubles to
 * test its own wiring, and because "testable without a network, a browser or a sleep" is a promise
 * this package makes in its README. Everything here is dependency-free: no fake-timer library, no
 * mocking framework.
 */

import type { Clock, TimerHandle } from "./clock.ts"
import type { ServerMessage } from "./codec.ts"
import type { UserFanout } from "./notify.ts"
import {
  type ManagedSocket,
  type SocketCloseInfo,
  SocketState,
  type Unsubscribe,
} from "./socket-port.ts"

export { MemoryKeyValueStore } from "./storage.ts"
export type { KeyValueStore } from "./storage.ts"

interface FakeTimer {
  readonly id: number
  dueAt: number
  readonly intervalMs: number | null
  readonly callback: () => void
}

/**
 * Clock that only moves when a test moves it.
 *
 * `advance` fires every timer due inside the window in chronological order, lets the microtask
 * queue drain after each firing, and repeats until nothing else is due — so a callback that
 * schedules a follow-up timer (a reconnect, a retry) is exercised in one call. No test in this
 * package sleeps, and `pendingTimers` is how a test asserts a transport leaked nothing.
 */
export class FakeClock implements Clock {
  #now = 0
  readonly #timers = new Map<number, FakeTimer>()
  #nextId = 1

  now(): number {
    return this.#now
  }

  setInterval(callback: () => void, ms: number): TimerHandle {
    return this.#schedule(callback, ms, ms)
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    return this.#schedule(callback, ms, null)
  }

  clearInterval(handle: TimerHandle): void {
    this.#timers.delete(handle.id)
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle.id)
  }

  /** Timers still scheduled. A stopped transport must leave this at zero. */
  get pendingTimers(): number {
    return this.#timers.size
  }

  /** Move the clock forward, firing everything due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + Math.max(0, ms)
    for (let guard = 0; guard < 10_000; guard++) {
      const next = this.#nextDue(target)
      if (!next) {
        this.#now = target
        return
      }
      this.#now = next.dueAt
      if (next.intervalMs === null) this.#timers.delete(next.id)
      else next.dueAt = this.#now + next.intervalMs
      next.callback()
      await drainMicrotasks()
    }
    throw new Error("advance: a timer rescheduled itself without bound")
  }

  #schedule(
    callback: () => void,
    ms: number,
    intervalMs: number | null,
  ): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, {
      id,
      dueAt: this.#now + Math.max(0, ms),
      intervalMs,
      callback,
    })
    return { id }
  }

  #nextDue(target: number): FakeTimer | null {
    let found: FakeTimer | null = null
    for (const timer of this.#timers.values()) {
      if (timer.dueAt > target) continue
      if (
        !found || timer.dueAt < found.dueAt ||
        (timer.dueAt === found.dueAt && timer.id < found.id)
      ) {
        found = timer
      }
    }
    return found
  }
}

/** Options for {@link FakeSocketFactory}. */
export interface FakeSocketFactoryOptions {
  /**
   * Whether a created socket opens immediately.
   *
   * `true` (default) models a healthy server; `false` leaves every socket connecting until a test
   * calls {@link FakeSocket.openFromPeer}, which is how the connect-attempt timeout is exercised.
   */
  autoOpen?: boolean
}

/** In-memory socket: what a test drives, with no network and no WebSocket global. */
export class FakeSocket implements ManagedSocket {
  readonly url: string
  /** Frames handed to `send`, in order. */
  readonly sent: string[] = []
  /** Every `close` call, in order, including reaps the registry performed. */
  readonly closeCalls: { code: number; reason: string }[] = []
  readonly #openHandlers = new Set<() => void>()
  readonly #messageHandlers = new Set<(data: string) => void>()
  readonly #closeHandlers = new Set<(info: SocketCloseInfo) => void>()
  #state: SocketState = SocketState.Connecting
  #sendError: Error | null = null

  constructor(url: string) {
    this.url = url
  }

  get state(): SocketState {
    return this.#state
  }

  /** Frames received, parsed. Throws on a frame that is not JSON, which is itself a test failure. */
  frames(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame))
  }

  send(data: string): void {
    if (this.#sendError) {
      const error = this.#sendError
      this.#sendError = null
      throw error
    }
    if (this.#state !== SocketState.Open) {
      throw new Error(`send while ${SocketState[this.#state]}`)
    }
    this.sent.push(data)
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason })
    this.#shutdown({ code, reason, abnormal: code !== 1000 })
  }

  onOpen(handler: () => void): Unsubscribe {
    this.#openHandlers.add(handler)
    return () => this.#openHandlers.delete(handler)
  }

  onMessage(handler: (data: string) => void): Unsubscribe {
    this.#messageHandlers.add(handler)
    return () => this.#messageHandlers.delete(handler)
  }

  onClose(handler: (info: SocketCloseInfo) => void): Unsubscribe {
    this.#closeHandlers.add(handler)
    return () => this.#closeHandlers.delete(handler)
  }

  /** The peer accepted the connection. Fires the open handlers. */
  openFromPeer(): void {
    if (
      this.#state === SocketState.Open || this.#state === SocketState.Closed
    ) return
    this.#state = SocketState.Open
    for (const handler of [...this.#openHandlers]) handler()
  }

  /** The peer dropped the connection. Fires the close handlers with an abnormal code. */
  dropFromPeer(code = 1006, reason = "connection lost"): void {
    this.#shutdown({ code, reason, abnormal: code !== 1000 })
  }

  /** Deliver one frame from the peer. Ignored once the socket is closed. */
  receive(data: string): void {
    if (this.#state !== SocketState.Open) return
    for (const handler of [...this.#messageHandlers]) handler(data)
  }

  /** Make the next `send` throw, to exercise send-failure handling. */
  failNextSend(error: Error = new Error("send failed")): void {
    this.#sendError = error
  }

  #shutdown(info: SocketCloseInfo): void {
    if (this.#state === SocketState.Closed) return
    this.#state = SocketState.Closed
    for (const handler of [...this.#closeHandlers]) handler(info)
  }
}

/** Creates {@link FakeSocket}s and keeps them, so a test can act as the server. */
export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = []
  readonly #autoOpen: boolean

  constructor(options: FakeSocketFactoryOptions = {}) {
    this.#autoOpen = options.autoOpen ?? true
  }

  open(url: string): FakeSocket {
    const socket = new FakeSocket(url)
    this.sockets.push(socket)
    if (this.#autoOpen) socket.openFromPeer()
    return socket
  }

  /** The most recent socket. Throws when nothing has been created yet. */
  get latest(): FakeSocket {
    const socket = this.sockets.at(-1)
    if (!socket) throw new Error("no socket has been created yet")
    return socket
  }
}

/**
 * Uniform source in `[0, 1)` that replays fixed values.
 *
 * The last value repeats once the list is exhausted, so a test can advance through several
 * reconnect attempts without counting them.
 */
export function sequenceRandom(values: readonly number[]): () => number {
  if (values.length === 0) {
    throw new Error("sequenceRandom needs at least one value")
  }
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value ?? 0
  }
}

/**
 * Fan-out that records what it was asked to deliver.
 *
 * `userIds()` exists so a test can implement the fail-open regression deliberately — the broadcast
 * a naive notifier would reach for — and prove the fail-closed test catches it.
 */
export class RecordingFanout implements UserFanout {
  readonly calls: { userIds: string[]; message: ServerMessage }[] = []
  readonly #socketsPerUser: Map<string, number>

  constructor(socketsPerUser: Record<string, number> = {}) {
    this.#socketsPerUser = new Map(Object.entries(socketsPerUser))
  }

  /** Every user the server could name. Not part of {@link UserFanout}. */
  userIds(): string[] {
    return [...this.#socketsPerUser.keys()].sort()
  }

  sendToUsers(userIds: readonly string[], message: ServerMessage): number {
    this.calls.push({ userIds: [...userIds], message })
    let delivered = 0
    for (const userId of userIds) {
      delivered += this.#socketsPerUser.get(userId) ?? 0
    }
    return delivered
  }
}

/** Let queued microtasks run, so an awaited chain settles inside a test's own tick. */
export async function drainMicrotasks(turns = 16): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}
