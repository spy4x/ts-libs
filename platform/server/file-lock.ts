/**
 * Exclusive file lock built on the port's lock primitive.
 *
 * The primitive is `FsFile.tryLockSync(true)` in the Deno adapter — a non-blocking exclusive
 * advisory lock. Two processes contending for one directory is the case this exists for: the
 * second must fail immediately with a diagnosable error rather than interleave writes.
 *
 * This module owns the *decision* (acquire, re-acquire, release order, error text); the port owns
 * the syscall.
 *
 * @module
 */

import { dirname } from "@std/path"

import { AsyncMutex } from "../universal/concurrency.ts"
import type { FileSystemPort, LockHandle } from "./ports.ts"

/** Lock state, so a check can distinguish "held" from "held by me". */
export enum LockState {
  Free = 1,
  Owned = 2,
}

/** Raised when another holder owns the lock. */
export class LockUnavailableError extends Error {
  override readonly name = "LockUnavailableError"
  /** The path whose lock was contended. */
  readonly path: string

  constructor(path: string, holder = "another process") {
    super(`another instance is running for ${path} (lock held by ${holder})`)
    this.path = path
  }
}

/**
 * Raised when a {@link FileLock.runExclusive} call waited {@link FileLockOptions.waitMs} for an
 * earlier `runExclusive` on the same instance and gave up.
 *
 * Either the earlier call is still running and is slower than the bound, or this is a nested
 * call: a body that calls `runExclusive` on its own lock waits for itself, which would otherwise
 * hang forever.
 */
export class FileLockWaitError extends Error {
  override readonly name = "FileLockWaitError"
  /** The path of the lock that was waited for. */
  readonly path: string

  constructor(path: string, waitMs: number) {
    super(
      `runExclusive on ${path} waited ${waitMs} ms for an earlier runExclusive on the same ` +
        `FileLock: either that call is still running and is slower than the bound, or this is ` +
        `a nested runExclusive from inside its body, which waits for itself`,
    )
    this.path = path
  }
}

/**
 * How long a {@link FileLock.runExclusive} call waits for an earlier one on the same instance.
 *
 * Thirty seconds: a body that holds a directory lock usually does real I/O, so the bound is
 * generous, but a nested call that waits for itself is still reported instead of hanging.
 */
export const DEFAULT_FILE_LOCK_WAIT_MS = 30_000

/** The longest delay `setTimeout` holds; a longer one is cut to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

/** Options for {@link FileLock}. */
export interface FileLockOptions {
  fs: FileSystemPort
  /** Path of the lock file itself, e.g. `<dir>/.job.lock`. */
  path: string
  /**
   * Milliseconds a {@link FileLock.runExclusive} call waits for an earlier one on the same instance
   * before it throws {@link FileLockWaitError}. Defaults to {@link DEFAULT_FILE_LOCK_WAIT_MS}.
   *
   * `Infinity`, and any value above 2 147 483 647 (about 24.8 days, the longest delay a timer can
   * hold), waits without a bound. `0` gives up as soon as a call has to queue. `NaN` and negative
   * values are rejected with a `RangeError` by the constructor.
   */
  waitMs?: number
}

/**
 * One held lock. Single-use: after {@link release} it reports {@link LockState.Free} and a second
 * `release` is a no-op, so a `finally` that runs twice cannot free someone else's lock.
 */
export class FileLock {
  readonly #fs: FileSystemPort
  readonly #path: string
  readonly #waitMs: number
  readonly #queue = new AsyncMutex()
  #handle: LockHandle | null = null

  constructor(options: FileLockOptions) {
    this.#fs = options.fs
    this.#path = options.path
    const waitMs = options.waitMs ?? DEFAULT_FILE_LOCK_WAIT_MS
    if (Number.isNaN(waitMs) || waitMs < 0) {
      throw new RangeError(`FileLock waitMs must be a number of 0 or more, got ${waitMs}`)
    }
    this.#waitMs = waitMs
  }

  get path(): string {
    return this.#path
  }

  get state(): LockState {
    return this.#handle === null ? LockState.Free : LockState.Owned
  }

  /**
   * Take the lock, or throw {@link LockUnavailableError}.
   *
   * The parent directory is created first — a lock file in a directory that does not exist yet is
   * a NotFound, not a contention, and reporting it as contention would be misleading. The
   * descriptor is closed when the port reports the lock is already held, so a failed acquire
   * leaks nothing.
   */
  async acquire(): Promise<void> {
    if (this.#handle !== null) return
    await this.#fs.mkdirp(dirname(this.#path))
    const handle = await this.#fs.lock(this.#path)
    if (handle === null) throw new LockUnavailableError(this.#path)
    this.#handle = handle
  }

  /** Take the lock if free. Never throws for contention. */
  async tryAcquire(): Promise<boolean> {
    if (this.#handle !== null) return true
    await this.#fs.mkdirp(dirname(this.#path))
    const handle = await this.#fs.lock(this.#path)
    if (handle === null) return false
    this.#handle = handle
    return true
  }

  /** Release. Idempotent, and safe to call from a `finally`. */
  async release(): Promise<void> {
    const handle = this.#handle
    this.#handle = null
    if (handle === null) return
    await handle.release()
  }

  /**
   * Run `fn` under the lock.
   *
   * Calls on one instance run one at a time, in arrival order: a second call waits until the
   * first has finished, so two bodies never overlap. The lock is released afterwards only when
   * this call took it — on every path, including a throw. A lock that was already held when the
   * call started, through {@link acquire} or {@link tryAcquire}, stays held.
   *
   * A throw from `acquire` propagates before `fn` is entered, so `fn` never runs unlocked. A call
   * that waits longer than {@link FileLockOptions.waitMs} for an earlier one throws
   * {@link FileLockWaitError}; this is what a nested `runExclusive` from inside `fn` gets, rather
   * than a hang.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const leave = await this.#enter()
    try {
      const heldBefore = this.#handle !== null
      if (!heldBefore) await this.acquire()
      try {
        return await fn()
      } finally {
        if (!heldBefore) await this.release()
      }
    } finally {
      leave()
    }
  }

  /** Wait for the in-process queue, bounded by `waitMs`. Resolves to the function that leaves it. */
  async #enter(): Promise<() => void> {
    const entered = this.#queue.acquire()
    if (this.#waitMs > MAX_TIMER_MS) return await entered
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#waitMs)
    })
    try {
      const leave = await Promise.race([entered, expired])
      if (leave !== null) return leave
    } finally {
      clearTimeout(timer)
    }
    // Gave up: when the turn arrives later, pass it straight on so the queue keeps moving.
    entered.then((leave) => leave())
    throw new FileLockWaitError(this.#path, this.#waitMs)
  }
}
