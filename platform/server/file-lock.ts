/**
 * Exclusive file lock built on the port's lock primitive.
 *
 * The primitive is `FsFile.tryLockSync(true)` in the Deno adapter — a non-blocking exclusive
 * advisory lock. Two processes contending for one directory is the case this exists for: the
 * second must fail immediately with a diagnosable error rather than interleave writes.
 *
 * This module owns the *decision* (acquire, re-acquire, release order, error text); the port owns
 * the syscall.
 */

import { dirname } from "@std/path"

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

/** Options for {@link FileLock}. */
export interface FileLockOptions {
  fs: FileSystemPort
  /** Path of the lock file itself, e.g. `<dir>/.job.lock`. */
  path: string
}

/**
 * One held lock. Single-use: after {@link release} it reports {@link LockState.Free} and a second
 * `release` is a no-op, so a `finally` that runs twice cannot free someone else's lock.
 */
export class FileLock {
  readonly #fs: FileSystemPort
  readonly #path: string
  #handle: LockHandle | null = null

  constructor(options: FileLockOptions) {
    this.#fs = options.fs
    this.#path = options.path
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
   * Run `fn` under the lock, releasing on every path including a throw.
   *
   * A throw from `acquire` propagates before `fn` is entered, so `fn` never runs unlocked.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      await this.release()
    }
  }
}
