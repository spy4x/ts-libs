/**
 * The I/O ports every server helper in this package talks through.
 *
 * The root `test` task grants `--allow-read --allow-env` and nothing else: no `--allow-write`, no
 * `--allow-run`. A helper that writes files therefore cannot be tested against the real
 * filesystem here. None of these modules call `Deno.*` directly — each takes a port, so the
 * decision logic (what to write, when to flush, which entry is skipped) is tested against an
 * in-memory fake, and {@link denoFileSystem} is a thin adapter around documented `Deno` APIs. The
 * integration tier holds the adapter and the fake to one shared contract (`fs-contract.test.ts`).
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
 * @deprecated Identical shape to `Clock` from `@spy4x/platform/universal/time` (`#71`), which is
 * now the one home for this shape. Use that instead in new code.
 */
export type ClockPort = Clock

/**
 * The host clock.
 *
 * @deprecated Use `systemClock` from `@spy4x/platform/universal/time`.
 */
export const systemClockPort: ClockPort = systemClock

/** Options of {@link FileSystemPort.writeText}, `writeBytes` and `writeStream`. */
export interface WriteTextOptions {
  /**
   * Permission bits for a file this call creates, such as `0o600` for a file only its owner may
   * read. An existing file keeps the permissions it has, and a platform without POSIX permissions
   * ignores the value.
   */
  mode?: number
}

/** Storage primitives a server helper needs. No method here reads `Deno.*` by itself. */
export interface FileSystemPort {
  /** `false` rather than a throw when the path is absent. */
  exists(path: string): Promise<boolean>
  /** Raw text, or `null` when the path is absent. */
  readText(path: string): Promise<string | null>
  /** Write text, replacing any existing content. `options.mode` applies when the file is new. */
  writeText(path: string, content: string, options?: WriteTextOptions): Promise<void>
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
  /**
   * Raw bytes, or `null` when the path is absent. Optional: an implementer written before it was
   * added may leave it out, so a caller checks for it or documents that it needs it.
   */
  readBytes?(path: string): Promise<Uint8Array | null>
  /**
   * Write bytes, replacing any existing content. `options.mode` applies when the file is new.
   * Optional, as {@link FileSystemPort.readBytes} is.
   */
  writeBytes?(path: string, data: Uint8Array, options?: WriteTextOptions): Promise<void>
  /**
   * The file's bytes as a stream, so a large file never lands in memory at once, or `null` when
   * the path is absent. The caller reads it to the end or cancels it, which closes the file.
   * Optional, as {@link FileSystemPort.readBytes} is.
   */
  readStream?(path: string): Promise<ReadableStream<Uint8Array> | null>
  /**
   * Write everything `source` yields, replacing any existing content, and resolve to the number of
   * bytes written. `options.mode` applies when the file is new. When `source` errors, the call
   * rejects and the file may hold part of it: write to a temporary path and `rename` it into place
   * for an all-or-nothing write. Optional, as {@link FileSystemPort.readBytes} is.
   */
  writeStream?(
    path: string,
    source: ReadableStream<Uint8Array>,
    options?: WriteTextOptions,
  ): Promise<number>
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
