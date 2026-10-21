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

import type { ByteReader, FileSystemPort, LockHandle, WalkEntry } from "./ports.ts"
import type { TimerPort } from "./throttled-saver.ts"
import type { Clock } from "../universal/time.ts"

/** One recorded call on the fake filesystem. */
export type FsCall = { op: string; path: string; extra?: string }

/** The fake, plus the assertions hooks a test needs. */
export interface FakeFs extends FileSystemPort {
  /**
   * Current file contents as text, keyed by path. Directories are tracked separately. A file
   * written as bytes appears here decoded as UTF-8, and its exact bytes are in {@link bytes}.
   */
  readonly files: Map<string, string>
  /** The exact bytes of the files written through `writeBytes` or `writeStream`, keyed by path. */
  readonly bytes: Map<string, Uint8Array>
  /** Permission bits of the files that were created with a `mode`, keyed by path. */
  readonly modes: Map<string, number>
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

/**
 * `path` and every ancestor of it, without a trailing slash: `/a/b` → `/a/b`, `/a`. The filesystem
 * root and a bare relative name's `.` are left out, because they always exist.
 */
function withAncestors(path: string): string[] {
  const chain: string[] = []
  let current = path.replace(/\/+$/, "")
  while (current !== "" && current !== "." && current !== "/") {
    chain.push(current)
    const slash = current.lastIndexOf("/")
    current = slash === -1 ? "" : current.slice(0, slash)
  }
  return chain
}

/** `parts` joined into one array. */
function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

/** The folder holding `path`, or `null` for a path at the root or a bare relative name. */
function parentOf(path: string): string | null {
  return withAncestors(path)[1] ?? null
}

/**
 * Create an in-memory filesystem seeded with `files`.
 *
 * Like the real disk, it refuses to write, append, rename or lock into a folder that does not exist:
 * the folders that hold the seeded files exist, and `mkdirp` creates a folder with its parents.
 * `lock` leaves an empty lock file behind, as `Deno.open` with `create` does.
 */
export function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>(Object.keys(initial).flatMap((path) => withAncestors(path).slice(1)))
  const modes = new Map<string, number>()
  const calls: FsCall[] = []
  const locks = new Set<string>()
  const bytes = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  /** The exact bytes of `path`, or `undefined` when it is absent. */
  const bytesOf = (path: string): Uint8Array | undefined => {
    const raw = bytes.get(path)
    if (raw) return raw.slice()
    const text = files.get(path)
    return text === undefined ? undefined : encoder.encode(text)
  }
  /** Store `data` as the content of `path`, as `writeBytes` would. */
  const storeBytes = (path: string, data: Uint8Array, mode: number | undefined): void => {
    if (!files.has(path) && mode !== undefined) modes.set(path, mode)
    bytes.set(path, data.slice())
    files.set(path, new TextDecoder().decode(data))
  }
  /** A rejection for a write into `path`, or `null` when the write may go ahead. */
  const refuseWrite = (path: string): Promise<never> | null => {
    if (fake.failWrites.has(path)) return Promise.reject(new Error(`write refused: ${path}`))
    return missingParent(path)
  }
  /** A rejection like the real one when the folder for `path` is missing, otherwise `null`. */
  const missingParent = (path: string): Promise<never> | null => {
    const parent = parentOf(path)
    if (parent === null || dirs.has(parent)) return null
    return Promise.reject(new Deno.errors.NotFound(`no such directory: ${parent}`))
  }
  const fake: FakeFs = {
    files,
    bytes,
    modes,
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

    writeText(path, content, options) {
      calls.push({ op: "writeText", path, extra: content })
      if (fake.failWrites.has(path)) return Promise.reject(new Error(`write refused: ${path}`))
      const missing = missingParent(path)
      if (missing) return missing
      // Like the real disk, a mode applies only to a file this call creates.
      if (!files.has(path) && options?.mode !== undefined) modes.set(path, options.mode)
      files.set(path, content)
      bytes.delete(path)
      return Promise.resolve()
    },

    appendText(path, content) {
      calls.push({ op: "appendText", path, extra: content })
      if (fake.failWrites.has(path)) return Promise.reject(new Error(`write refused: ${path}`))
      const missing = missingParent(path)
      if (missing) return missing
      const raw = bytes.get(path)
      if (raw) storeBytes(path, concat([raw, encoder.encode(content)]), undefined)
      else files.set(path, (files.get(path) ?? "") + content)
      return Promise.resolve()
    },

    rename(from, to) {
      calls.push({ op: "rename", path: from, extra: to })
      if (fake.failRenames.has(from)) return Promise.reject(new Error(`rename refused: ${from}`))
      const content = files.get(from)
      if (content === undefined) return Promise.reject(new Error(`rename source missing: ${from}`))
      const missing = missingParent(to)
      if (missing) return missing
      files.delete(from)
      files.set(to, content)
      const raw = bytes.get(from)
      bytes.delete(from)
      if (raw) bytes.set(to, raw)
      else bytes.delete(to)
      // A rename carries the source's permissions over the target's.
      const mode = modes.get(from)
      modes.delete(from)
      if (mode === undefined) modes.delete(to)
      else modes.set(to, mode)
      return Promise.resolve()
    },

    remove(path) {
      calls.push({ op: "remove", path })
      files.delete(path)
      bytes.delete(path)
      modes.delete(path)
      return Promise.resolve()
    },

    mkdirp(path) {
      calls.push({ op: "mkdirp", path })
      for (const folder of withAncestors(path)) dirs.add(folder)
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
          size: bytes.get(name)?.byteLength ?? encoder.encode(content).byteLength,
        })
      }
      return Promise.resolve(entries)
    },

    lock(path) {
      calls.push({ op: "lock", path })
      const missing = missingParent(path)
      if (missing) return missing
      if (!files.has(path)) files.set(path, "")
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

    readBytes(path) {
      calls.push({ op: "readBytes", path })
      return Promise.resolve(bytesOf(path) ?? null)
    },

    writeBytes(path, data, options) {
      calls.push({ op: "writeBytes", path })
      const refused = refuseWrite(path)
      if (refused) return refused
      storeBytes(path, data, options?.mode)
      return Promise.resolve()
    },

    readStream(path) {
      calls.push({ op: "readStream", path })
      const content = bytesOf(path)
      if (content === undefined) return Promise.resolve(null)
      return Promise.resolve(ReadableStream.from([content]))
    },

    async writeStream(path, source, options) {
      calls.push({ op: "writeStream", path })
      const refused = refuseWrite(path)
      if (refused) {
        await source.cancel()
        return refused
      }
      // Like the real file, the old content is gone as soon as the write starts.
      storeBytes(path, new Uint8Array(), options?.mode)
      const chunks: Uint8Array[] = []
      try {
        for await (const chunk of source) chunks.push(chunk)
      } finally {
        storeBytes(path, concat(chunks), undefined)
      }
      return chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    },
  }
  return fake
}

/** A clock that advances only when a test says so. */
export interface FakeClock extends Clock {
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
