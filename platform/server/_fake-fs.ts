/**
 * In-memory {@link FileSystemPort}, plus clock and timer fakes.
 *
 * Not a test file — the name deliberately does not match Deno's test discovery patterns. Every
 * server module is tested through this fake, because the root `test` task grants `--allow-read` and
 * `--allow-env` only: a helper that writes files cannot touch the real filesystem here.
 *
 * The fake records every operation, so a test can assert *what* was written and *in what order*
 * rather than only what the final state looks like.
 */

import type { ByteReader, ClockPort, FileSystemPort, LockHandle, WalkEntry } from "./ports.ts"
import type { TimerPort } from "./throttled-saver.ts"

/** One recorded call on the fake filesystem. */
export type FsCall = { op: string; path: string; extra?: string }

/** The fake, plus the assertions hooks a test needs. */
export interface FakeFs extends FileSystemPort {
  /** Current file contents, keyed by path. Directories are tracked separately. */
  readonly files: Map<string, string>
  /** Paths known to be directories. */
  readonly dirs: Set<string>
  /** Every call, in order. */
  readonly calls: FsCall[]
  /** Paths whose write should reject, to exercise failure paths. */
  failWrites: Set<string>
  /** Paths whose rename should reject. */
  failRenames: Set<string>
  /** Locks currently held, keyed by path. */
  readonly locks: Set<string>
}

/** Create an in-memory filesystem seeded with `files`. */
export function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const calls: FsCall[] = []
  const locks = new Set<string>()
  const fake: FakeFs = {
    files,
    dirs,
    calls,
    locks,
    failWrites: new Set(),
    failRenames: new Set(),

    exists(path) {
      calls.push({ op: "exists", path })
      return Promise.resolve(files.has(path) || dirs.has(path))
    },

    readText(path) {
      calls.push({ op: "readText", path })
      return Promise.resolve(files.get(path) ?? null)
    },

    writeText(path, content) {
      calls.push({ op: "writeText", path, extra: content })
      if (fake.failWrites.has(path)) return Promise.reject(new Error(`write refused: ${path}`))
      files.set(path, content)
      return Promise.resolve()
    },

    rename(from, to) {
      calls.push({ op: "rename", path: from, extra: to })
      if (fake.failRenames.has(from)) return Promise.reject(new Error(`rename refused: ${from}`))
      const content = files.get(from)
      if (content === undefined) return Promise.reject(new Error(`rename source missing: ${from}`))
      files.delete(from)
      files.set(to, content)
      return Promise.resolve()
    },

    remove(path) {
      calls.push({ op: "remove", path })
      files.delete(path)
      return Promise.resolve()
    },

    mkdirp(path) {
      calls.push({ op: "mkdirp", path })
      dirs.add(path)
      return Promise.resolve()
    },

    readDir(path) {
      calls.push({ op: "readDir", path })
      const prefix = path.endsWith("/") ? path : `${path}/`
      const entries: WalkEntry[] = []
      // `childOf` returns the single path segment below `prefix`, or `null` when the path is not a
      // direct child. Depth-1 lookups keep a deep-tree test linear rather than quadratic.
      const childOf = (candidate: string): string | null => {
        if (!candidate.startsWith(prefix)) return null
        const rest = candidate.slice(prefix.length)
        if (rest === "" || rest.includes("/")) return null
        return rest
      }
      for (const name of dirs) {
        const child = childOf(name)
        if (child !== null) entries.push({ name: child, isDirectory: true, isFile: false })
      }
      for (const [name, content] of files) {
        const child = childOf(name)
        if (child === null) continue
        entries.push({
          name: child,
          isDirectory: false,
          isFile: true,
          size: new TextEncoder().encode(content).byteLength,
        })
      }
      return Promise.resolve(entries)
    },

    lock(path) {
      calls.push({ op: "lock", path })
      if (locks.has(path)) return Promise.resolve(null)
      locks.add(path)
      const handle: LockHandle = {
        release: () => {
          locks.delete(path)
          return Promise.resolve()
        },
      }
      return Promise.resolve(handle)
    },
  }
  return fake
}

/** A clock that advances only when a test says so. */
export interface FakeClock extends ClockPort {
  set(ms: number): void
  advance(ms: number): void
}

/** Create a fake clock starting at `startMs`. */
export function fakeClock(startMs = 0): FakeClock {
  let current = startMs
  return {
    now: () => current,
    set: (ms) => {
      current = ms
    },
    advance: (ms) => {
      current += ms
    },
  }
}

/** A timer port whose schedule a test fires by hand. */
export interface FakeTimers extends TimerPort {
  /** Delays that were requested, in order, for callbacks not yet fired. */
  readonly scheduled: number[]
  /** Fire every pending callback that is due at the current fake time. */
  runAll(): void
  /** Number of currently pending callbacks. */
  readonly pending: number
}

/** Create a fake timer port. */
export function fakeTimers(): FakeTimers {
  let next = 1
  const handles = new Map<number, { fn: () => void; ms: number }>()
  const scheduled: number[] = []
  return {
    scheduled,
    get pending() {
      return handles.size
    },
    set(fn, ms) {
      const handle = next++
      handles.set(handle, { fn, ms })
      scheduled.push(ms)
      return handle
    },
    clear(handle) {
      handles.delete(handle)
    },
    runAll() {
      const due = [...handles.entries()]
      handles.clear()
      for (const [, entry] of due) entry.fn()
    },
  }
}

/** A {@link ByteReader} over fixed chunks, so hashing is tested without touching a file. */
export function fakeByteReader(chunks: Uint8Array[]): ByteReader {
  return {
    async *chunks() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Split `bytes` into fixed-size chunks, or one chunk when `size` is not given. */
export function chunkBytes(bytes: Uint8Array, size?: number): Uint8Array[] {
  if (size === undefined) return [bytes]
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size))
  }
  return chunks
}
