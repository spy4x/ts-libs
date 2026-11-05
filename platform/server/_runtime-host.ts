/**
 * The runtime lookups behind `./process.ts` and `./runtime-fs.ts`, written over an injected host
 * object so a unit test can drive the Deno, Node and Bun branches without the runtime it is
 * running on.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

import type { FileSystemPort } from "./ports.ts"
import type { EnvReader, OsSignal, StandardInput } from "./process.ts"

/** Node's standard input stream: the members {@link standardInputOver} reads. */
export interface NodeStdin {
  isTTY?: boolean
  setRawMode?(raw: boolean): unknown
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown
  on(event: "end", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  pause(): unknown
  resume(): unknown
  /** Let the stream keep the process alive again (Node; Bun may lack it). */
  ref?(): unknown
  /** Stop the stream keeping the process alive (Node; Bun may lack it). */
  unref?(): unknown
}

/**
 * The globals the lookups read: `Deno` on Deno, `process` on Node and Bun (Bun implements Node's
 * `process`, so the two share a branch).
 */
export interface RuntimeHost {
  Deno?: {
    env?: { get(name: string): string | undefined }
    pid?: number
    args?: readonly string[]
    exit?(code: number): never
    stderr?: { writeSync(data: Uint8Array): number }
    stdin?: {
      isTerminal(): boolean
      setRaw(raw: boolean): void
      read(buffer: Uint8Array): Promise<number | null>
      readonly readable: ReadableStream<Uint8Array>
    }
    addSignalListener?(signal: OsSignal, handler: () => void): void
    removeSignalListener?(signal: OsSignal, handler: () => void): void
    cwd?(): string
    errors?: Partial<Record<FsErrorKind, new (message: string) => Error>>
  }
  process?: {
    env?: Record<string, string | undefined>
    pid?: number
    argv?: readonly string[]
    exit?(code: number): never
    stderr?: { write(text: string): unknown }
    stdin?: NodeStdin
    on?(event: string, listener: () => void): unknown
    off?(event: string, listener: () => void): unknown
    cwd?(): string
  }
}

/** The running process's globals, read on every call so nothing is captured at import time. */
export function currentHost(): RuntimeHost {
  return globalThis as unknown as RuntimeHost
}

/** Which branch a host takes: Deno first, since Deno 2 also defines `process`. */
export function runtimeOf(host: RuntimeHost): "deno" | "node" {
  if (host.Deno) return "deno"
  if (host.process) return "node"
  throw new Error("unsupported runtime: neither Deno nor process is defined")
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value
}

/**
 * An {@link EnvReader} over `host`. Deno is asked first: Deno 2 also defines `process`, and its own
 * API is the one its permission flags document.
 *
 * @throws {Error} From `get`, when the host has neither `Deno.env` nor `process.env`.
 */
export function envReaderOver(host: () => RuntimeHost): EnvReader {
  return {
    get(name) {
      const { Deno, process } = host()
      if (Deno?.env) return blankToUndefined(Deno.env.get(name))
      if (process?.env) return blankToUndefined(process.env[name])
      throw new Error("no environment: this runtime has neither Deno.env nor process.env")
    },
  }
}

/**
 * The working directory from `host`: `Deno.cwd()`, or `process.cwd()` on Node and Bun.
 *
 * @throws {Error} When the host has neither.
 */
export function workingDirectoryOf(host: RuntimeHost): string {
  if (host.Deno?.cwd) return host.Deno.cwd()
  if (host.process?.cwd) return host.process.cwd()
  throw new Error("no working directory: this runtime has neither Deno.cwd nor process.cwd")
}

/** A file-system failure that `fsError` makes and `isFsError` recognises on every runtime. */
export type FsErrorKind =
  | "NotFound"
  | "AlreadyExists"
  | "WriteZero"
  | "IsADirectory"
  | "NotADirectory"

/** Node's `code` for each kind that has one. Node has no code for a write that made no progress. */
export const FS_ERROR_CODES: Record<FsErrorKind, string | undefined> = {
  NotFound: "ENOENT",
  AlreadyExists: "EEXIST",
  WriteZero: undefined,
  IsADirectory: "EISDIR",
  NotADirectory: "ENOTDIR",
}

/**
 * A `kind` error for `host`: `Deno.errors[kind]` on Deno, so `instanceof` checks keep working
 * there; elsewhere a plain `Error` named `kind`, with Node's `code` when the kind has one.
 */
export function fsErrorOver(host: RuntimeHost, kind: FsErrorKind, message: string): Error {
  const DenoError = host.Deno?.errors?.[kind]
  if (DenoError) return new DenoError(message)
  const error = new Error(message) as Error & { code?: string }
  error.name = kind
  const code = FS_ERROR_CODES[kind]
  if (code !== undefined) error.code = code
  return error
}

/** The process id from `host`, or `undefined` on a runtime that has none (a browser, a worker). */
export function processIdOf(host: RuntimeHost): number | undefined {
  return host.Deno?.pid ?? host.process?.pid
}

/**
 * The command-line arguments after the script: `Deno.args`, or `process.argv` without the runtime
 * and the script path on Node and Bun.
 *
 * @throws {Error} When the host has neither.
 */
export function argsOf(host: RuntimeHost): string[] {
  if (host.Deno?.args) return [...host.Deno.args]
  if (host.process?.argv) return host.process.argv.slice(2)
  throw new Error("no arguments: this runtime has neither Deno.args nor process.argv")
}

/**
 * End the process with `code` through `Deno.exit` or `process.exit`.
 *
 * @throws {Error} When the host has neither, so a caller never carries on as if it had exited.
 */
export function exitOver(host: RuntimeHost, code: number): never {
  if (host.Deno?.exit) return host.Deno.exit(code)
  if (host.process?.exit) return host.process.exit(code)
  throw new Error("cannot exit: this runtime has neither Deno.exit nor process.exit")
}

/**
 * Write `text` to standard error. On Deno the write is synchronous and repeated until every byte is
 * out, since one `writeSync` may write only part of them.
 *
 * @throws {Error} When the host has no standard error.
 */
export function writeStderrOver(host: RuntimeHost, text: string): void {
  const stderr = host.Deno?.stderr
  if (stderr) {
    let rest = new TextEncoder().encode(text)
    while (rest.byteLength > 0) {
      const count = stderr.writeSync(rest)
      // A write that takes nothing would repeat forever.
      if (count === 0) throw new Error("standard error accepted no bytes")
      rest = rest.subarray(count)
    }
    return
  }
  if (host.process?.stderr) {
    host.process.stderr.write(text)
    return
  }
  throw new Error("no standard error: this runtime has neither Deno.stderr nor process.stderr")
}

/**
 * {@link StandardInput} over `host`'s standard input.
 *
 * On Node and Bun, `read` takes one chunk at a time from `process.stdin`, then pauses and unrefs
 * the stream again, so a finished prompt does not keep the process alive; the part of a chunk that
 * did not fit the buffer is returned by the next `read`. Node emits `end` on its own tick, even
 * while the stream is paused between reads, so one listener watches for it for the stream's whole
 * life. Reads that overlap run one after another, so no chunk is handed to two of them.
 */
export function standardInputOver(host: () => RuntimeHost): StandardInput {
  /** Bytes of a Node chunk that did not fit the last buffer. */
  let leftover: Uint8Array = new Uint8Array()
  let ended = false
  /** The stream whose `end` is being watched. */
  let watched: NodeStdin | undefined
  /** The last read on Node, which the next one waits for. */
  let queue: Promise<unknown> = Promise.resolve()

  const denoStdin = () => host().Deno?.stdin
  const nodeStdin = (): NodeStdin => {
    const stdin = host().process?.stdin
    if (!stdin) {
      throw new Error("no standard input: this runtime has neither Deno.stdin nor process.stdin")
    }
    return stdin
  }

  /** The next chunk from Node's stdin, or `null` at its end. */
  const nextChunk = (stdin: NodeStdin): Promise<Uint8Array | null> => {
    if (watched !== stdin) {
      watched = stdin
      stdin.on("end", () => ended = true)
    }
    if (ended) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const onData = (chunk: Uint8Array | string) => {
        stop()
        resolve(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      }
      const onEnd = () => {
        ended = true
        stop()
        resolve(null)
      }
      const onError = (error: Error) => {
        stop()
        reject(error)
      }
      const stop = () => {
        // Node keeps reading a paused pipe, and an active read keeps the process alive: `unref`
        // lets a script that has its answer end without closing standard input first.
        stdin.pause()
        stdin.unref?.()
        stdin.off("data", onData)
        stdin.off("end", onEnd)
        stdin.off("error", onError)
      }
      stdin.on("data", onData)
      stdin.on("end", onEnd)
      stdin.on("error", onError)
      stdin.ref?.()
      stdin.resume()
    })
  }

  const readNode = async (buffer: Uint8Array): Promise<number | null> => {
    if (leftover.byteLength === 0) {
      const chunk = await nextChunk(nodeStdin())
      if (chunk === null) return null
      leftover = chunk
    }
    const count = Math.min(buffer.byteLength, leftover.byteLength)
    buffer.set(leftover.subarray(0, count))
    leftover = leftover.subarray(count)
    return count
  }

  const read = (buffer: Uint8Array): Promise<number | null> => {
    const deno = denoStdin()
    if (deno) return deno.read(buffer)
    const next = queue.then(() => readNode(buffer))
    queue = next.catch(() => {})
    return next
  }

  return {
    isTerminal() {
      const deno = denoStdin()
      return deno ? deno.isTerminal() : nodeStdin().isTTY === true
    },
    setRaw(raw) {
      const deno = denoStdin()
      if (deno) return deno.setRaw(raw)
      const stdin = nodeStdin()
      if (!stdin.setRawMode) throw new Error("standard input is not a terminal")
      stdin.setRawMode(raw)
    },
    read,
    async text() {
      const deno = denoStdin()
      if (deno) return await new Response(deno.readable).text()
      const parts: Uint8Array<ArrayBuffer>[] = []
      const buffer = new Uint8Array(64 * 1024)
      for (let count = await read(buffer); count !== null; count = await read(buffer)) {
        parts.push(buffer.slice(0, count))
      }
      return await new Blob(parts).text()
    },
  }
}

/**
 * A {@link FileSystemPort} that hands each call to `ports.deno` or `ports.node`, by `host`'s
 * runtime, chosen again on every call.
 *
 * @throws {Error} From each method, on a runtime with neither `Deno` nor `process` (a browser).
 */
export function fileSystemOver(
  host: () => RuntimeHost,
  ports: { deno: FileSystemPort; node: FileSystemPort },
): FileSystemPort {
  const pick = () => ports[runtimeOf(host())]
  return {
    exists: (path) => pick().exists(path),
    readText: (path) => pick().readText(path),
    writeText: (path, content, options) => pick().writeText(path, content, options),
    appendText: (path, content) => pick().appendText(path, content),
    rename: (from, to) => pick().rename(from, to),
    remove: (path) => pick().remove(path),
    mkdirp: (path) => pick().mkdirp(path),
    readDir: (path) => pick().readDir(path),
    lock: (path) => pick().lock(path),
    readBytes: (path) => pick().readBytes!(path),
    writeBytes: (path, data, options) => pick().writeBytes!(path, data, options),
    readStream: (path) => pick().readStream!(path),
    writeStream: (path, source, options) => pick().writeStream!(path, source, options),
    makeTempDir: (parent) => pick().makeTempDir!(parent),
    removeTree: (path) => pick().removeTree!(path),
  }
}

/** Registers and removes operating-system signal listeners. */
export interface SignalListeners {
  add(signal: OsSignal, handler: () => void): void
  remove(signal: OsSignal, handler: () => void): void
}

/**
 * Signal listeners over `host`: `Deno.addSignalListener` and `Deno.removeSignalListener` on Deno,
 * `process.on` and `process.off` on Node and Bun.
 *
 * @throws {Error} On a runtime with neither (a browser).
 */
export function signalListenersOver(host: RuntimeHost): SignalListeners {
  const { Deno, process } = host
  if (Deno?.addSignalListener && Deno.removeSignalListener) {
    return {
      add: (signal, handler) => Deno.addSignalListener!(signal, handler),
      remove: (signal, handler) => Deno.removeSignalListener!(signal, handler),
    }
  }
  if (process?.on && process.off) {
    return {
      add: (signal, handler) => void process.on!(signal, handler),
      remove: (signal, handler) => void process.off!(signal, handler),
    }
  }
  throw new Error("no signals: this runtime has neither Deno.addSignalListener nor process.on")
}
