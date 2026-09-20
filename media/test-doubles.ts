/**
 * Test doubles for this package.
 *
 * Deliberately **not** an `exports` entry point: a JSR publish ships the graph
 * reachable from `exports`, so these stay out of the published package while
 * every colocated `*.test.ts` imports them relatively.
 *
 * Nothing here touches a real process, a real timer, the real `PATH` or the
 * real filesystem, which is what lets the suite run under the repository's
 * `deno test --allow-read --allow-env` with no `--allow-run`, `--allow-write`
 * or `--allow-net`.
 */

import {
  createLineSplitter,
  type ProcessLineHandlers,
  type ProcessOutput,
  type ProcessRunner,
} from "./process-runner.ts"
import type { Timers } from "./timers.ts"
import type { RewriteFileSystem } from "./atomic-rewrite.ts"

/** One canned process response. */
export interface FakeProcessResponse {
  /** Exit code; `0` unless set. */
  code?: number
  /** Complete stdout, delivered as one chunk. */
  stdout?: string
  stderr?: string
  /**
   * Stdout split into chunks, to exercise chunk boundaries: a caller can hand
   * over a `key=value` line that straddles two chunks.
   */
  chunks?: string[]
  /** Thrown instead of returning a result, for a spawn that fails. */
  spawnError?: Error
}

/** One recorded invocation. */
export interface FakeProcessCall {
  argv: readonly string[]
  /** Whether the call came through the line-streaming method. */
  streamed: boolean
}

/**
 * `ProcessRunner` over canned responses.
 *
 * `respond` receives the argv, so a test can answer by inspecting the command —
 * which is also how argv-shape assertions are made.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly calls: FakeProcessCall[] = []
  readonly #respond: (argv: readonly string[]) => FakeProcessResponse

  constructor(respond: (argv: readonly string[]) => FakeProcessResponse) {
    this.#respond = respond
  }

  /** Number of processes this fake was asked to run. */
  get callCount(): number {
    return this.calls.length
  }

  /** The argv of the nth call, or `null` when there was none. */
  argvOf(index: number): readonly string[] | null {
    return this.calls[index]?.argv ?? null
  }

  run(argv: readonly string[]): Promise<ProcessOutput> {
    this.calls.push({ argv, streamed: false })
    const response = this.#respond(argv)
    if (response.spawnError) {
      return Promise.reject(response.spawnError)
    }
    return Promise.resolve(this.#output(response))
  }

  stream(argv: readonly string[], handlers: ProcessLineHandlers): Promise<ProcessOutput> {
    this.calls.push({ argv, streamed: true })
    const response = this.#respond(argv)
    if (response.spawnError) {
      return Promise.reject(response.spawnError)
    }
    const output = this.#output(response)
    // The real runner splits lines as chunks arrive, so the fake does too:
    // partial lines stay buffered, exactly as in production.
    const stdoutSplitter = createLineSplitter((line) => handlers.onStdoutLine?.(line))
    for (const chunk of response.chunks ?? [output.stdout]) {
      stdoutSplitter.push(new TextEncoder().encode(chunk))
    }
    stdoutSplitter.flush()
    const stderrSplitter = createLineSplitter((line) => handlers.onStderrLine?.(line))
    stderrSplitter.push(new TextEncoder().encode(output.stderr))
    stderrSplitter.flush()
    return Promise.resolve(output)
  }

  #output(response: FakeProcessResponse): ProcessOutput {
    const code = response.code ?? 0
    return {
      code,
      success: code === 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    }
  }
}

/**
 * `Timers` under test control.
 *
 * `runAll` fires the currently pending handlers once each and clears them; a
 * handler that schedules a new timer leaves it pending, which is asserted where
 * a cleared timer matters.
 */
export class FakeTimers implements Timers {
  #nextHandle = 1
  readonly #handlers = new Map<number, () => void>()

  setTimeout(handler: () => void, _delayMs: number): number {
    const handle = this.#nextHandle
    this.#nextHandle += 1
    this.#handlers.set(handle, handler)
    return handle
  }

  clearTimeout(handle: number): void {
    this.#handlers.delete(handle)
  }

  /** Number of timers that are still armed. */
  get pending(): number {
    return this.#handlers.size
  }

  /** Fires every pending timer. */
  runAll(): void {
    const handlers = [...this.#handlers.values()]
    this.#handlers.clear()
    for (const handler of handlers) {
      handler()
    }
  }
}

/**
 * `RewriteFileSystem` in memory.
 *
 * `failures` is keyed by `"<operation>:<path>"` — for `rename` the key uses the
 * source path — and carries the error to throw, so a failure path can be driven
 * without a real filesystem.
 */
export class FakeFileSystem implements RewriteFileSystem {
  readonly files = new Map<string, Uint8Array>()
  readonly ops: string[] = []
  readonly failures: Map<string, Error>

  constructor(files: Record<string, string> = {}, failures: Map<string, Error> = new Map()) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, new TextEncoder().encode(content))
    }
    this.failures = failures
  }

  /** The file's content as text, or `null` when it does not exist. */
  textOf(path: string): string | null {
    const bytes = this.files.get(path)
    return bytes === undefined ? null : new TextDecoder().decode(bytes)
  }

  #record(op: string, path: string): void {
    this.ops.push(`${op}:${path}`)
    const failure = this.failures.get(`${op}:${path}`)
    if (failure) {
      throw failure
    }
  }

  copyFile(from: string, to: string): Promise<void> {
    this.#record("copyFile", from)
    const bytes = this.files.get(from)
    if (bytes === undefined) {
      return Promise.reject(new Error(`no such file: ${from}`))
    }
    this.files.set(to, new Uint8Array(bytes))
    return Promise.resolve()
  }

  writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.#record("writeFile", path)
    this.files.set(path, new Uint8Array(bytes))
    return Promise.resolve()
  }

  rename(from: string, to: string): Promise<void> {
    this.#record("rename", from)
    const bytes = this.files.get(from)
    if (bytes === undefined) {
      return Promise.reject(new Error(`no such file: ${from}`))
    }
    this.files.delete(from)
    this.files.set(to, bytes)
    return Promise.resolve()
  }

  remove(path: string): Promise<void> {
    this.#record("remove", path)
    this.files.delete(path)
    return Promise.resolve()
  }

  size(path: string): Promise<number> {
    this.#record("size", path)
    const bytes = this.files.get(path)
    if (bytes === undefined) {
      return Promise.reject(new Error(`no such file: ${path}`))
    }
    return Promise.resolve(bytes.length)
  }

  exists(path: string): Promise<boolean> {
    this.#record("exists", path)
    return Promise.resolve(this.files.has(path))
  }
}

/**
 * A real `AbortSignal` behind a proxy that reports how many `abort` listeners
 * are attached to it.
 *
 * Nothing in the platform answers "is this target still listening": `Deno.inspect`
 * on a signal prints only `aborted`/`reason`/`onabort`, there is no
 * `listenerCount` method, and `node:events`' `getEventListeners` does read the
 * registry but importing any `node:` builtin drags Node's `setTimeout` typings
 * into the repo-wide compilation, which fails `deno task ts:check` in
 * `mcp/http.ts`, `media/timers.ts` and `server/healthcheck.ts`.
 *
 * The proxy registers the caller's own listener — identity and `{ once: true }`
 * included — on the real signal through `AbortSignal.prototype`, so aborts arrive
 * on the platform's dispatch path and `aborted`/`reason` stay the platform's
 * values. Only the attachment bookkeeping is local, and that is what makes an
 * otherwise invisible detach observable.
 *
 * The count tracks listeners added and explicitly removed through the returned
 * signal; an automatic `{ once: true }` removal after a fired abort is the
 * platform's business and is not reflected here.
 */
export function countedAbortSignal(signal: AbortSignal): {
  /** Drop-in replacement for `signal`; pass this one to the code under test. */
  signal: AbortSignal
  /** `abort` listeners attached through the proxy and not yet detached. */
  listenerCount(): number
} {
  const attached = new Set<EventListenerOrEventListenerObject>()
  const add = AbortSignal.prototype.addEventListener
  const remove = AbortSignal.prototype.removeEventListener

  const proxied = new Proxy(signal, {
    get(target, property) {
      if (property === "addEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ): void => {
          attached.add(listener)
          add.call(target, type, listener, options)
        }
      }
      if (property === "removeEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ): void => {
          attached.delete(listener)
          remove.call(target, type, listener, options)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  return { signal: proxied, listenerCount: () => attached.size }
}

/** An environment reader backed by a plain record. */
export function fakeEnvironment(values: Record<string, string>): {
  get(name: string): string | undefined
} {
  return {
    get: (name: string): string | undefined => values[name],
  }
}
