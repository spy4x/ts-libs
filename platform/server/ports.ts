/**
 * The I/O ports every server helper in this package talks through.
 *
 * The root `test` task grants `--allow-read --allow-env` and nothing else: no `--allow-write`, no
 * `--allow-run`. A helper that writes files therefore cannot be tested against the real
 * filesystem here. None of these modules call `Deno.*` directly — each takes a port, so the
 * decision logic (what to write, when to flush, which entry is skipped) is tested against an
 * in-memory fake, and {@link denoFileSystem} is a thin adapter whose individual calls are the
 * only untested lines. They are three-line bodies around documented `Deno` APIs.
 *
 * This is also what keeps the module usable from an in-memory harness or a test double without
 * monkey-patching a global.
 */

import { type Clock, systemClock } from "../universal/time.ts"

/** A single directory entry, as returned by a directory listing. */
export interface WalkEntry {
  /** Base name, not a path. */
  name: string
  isDirectory: boolean
  isFile: boolean
  /** Size in bytes; required only for files. */
  size?: number
}

/**
 * Clock injection point, so throttling is testable without sleeping.
 *
 * @deprecated Identical shape to `../universal/time.ts`'s `Clock` (`#71`), which is now the one
 * home for this shape. Use that instead in new code.
 */
export type ClockPort = Clock

/**
 * The host clock.
 *
 * @deprecated Use `../universal/time.ts`'s `systemClock`.
 */
export const systemClockPort: ClockPort = systemClock

/** Storage primitives a server helper needs. No method here reads `Deno.*` by itself. */
export interface FileSystemPort {
  /** `false` rather than a throw when the path is absent. */
  exists(path: string): Promise<boolean>
  /** Raw text, or `null` when the path is absent. */
  readText(path: string): Promise<string | null>
  /** Write text, replacing any existing content. */
  writeText(path: string, content: string): Promise<void>
  /**
   * Append text to the end of the file, creating it first if it does not exist. One call is one
   * write at the filesystem level — never a read-modify-write of the whole file — so a caller
   * appending one line at a time never re-touches an earlier line.
   */
  appendText(path: string, content: string): Promise<void>
  /** Rename over an existing path. Atomic on the same filesystem. */
  rename(from: string, to: string): Promise<void>
  /** Remove a file; a missing file is not an error. */
  remove(path: string): Promise<void>
  /** Create the directory and any missing parents. */
  mkdirp(path: string): Promise<void>
  /** One directory level, entry order unspecified. */
  readDir(path: string): Promise<WalkEntry[]>
  /** Exclusive advisory lock on `path`. `null` when another holder owns it. */
  lock(path: string): Promise<LockHandle | null>
}

/** A held file lock. Releasing twice is a no-op. */
export interface LockHandle {
  release(): Promise<void>
}

/** Chunked byte source for streaming hashing. */
export interface ByteReader {
  /** Yield the file's bytes in order. Chunk boundaries carry no meaning. */
  chunks(): AsyncIterable<Uint8Array>
}
