/**
 * The calls port: how a page asks the server to do something (`command`) or to answer something
 * (`query`), whatever carries the request.
 *
 * Three pieces fill and compose the port:
 *
 * - {@link createSocketCallPort} adapts a {@link ClientTransport}, so a call travels over the
 *   WebSocket while it is open.
 * - {@link createHttpCallPort} fills the port with `fetch`: `POST <baseUrl>/<name>`.
 * - {@link createComposedCallPort} prefers the socket while it is open and falls back to HTTP.
 *
 * Every module throws the same errors: {@link RealtimeRequestError} (the server answered with a
 * code) and {@link ConnectionLostError} (the server could not be reached, so the outcome is
 * unknown). {@link sendCommand} and {@link sendQuery} send a call again over any port when that
 * is worth it, a command with one idempotency key across every try.
 *
 * The wire contract of the HTTP module (the server half is `createCallHandler`):
 *
 * - Request: `POST <baseUrl>/<name>`, `Content-Type: application/json`, the body is the payload as
 *   JSON (no body at all when there is none), header `Idempotency-Key` on commands, header
 *   `X-Realtime-User` with the id of the user the page was started for.
 * - Success: every 2xx carries the JSON body `{ "result": <value> }`.
 * - Failure: a non-2xx with the JSON body `{ "error": { "code", "message", "details"? } }`, where
 *   `code` is one of {@link REALTIME_ERROR_CODES}, the same code the socket uses.
 *
 * @module
 */

import { backoffDelay, sleep } from "@spy4x/platform/universal/async"
import {
  type CallOptions,
  type CommandOptions,
  ConnectionLostError,
  RequestTimeoutError,
  TransportStatus,
} from "./client-transport.ts"
import { isRealtimeErrorCode, type RealtimeErrorCode, RealtimeRequestError } from "./errors.ts"

/** Options for one {@link CallPort.query}. */
export interface CallPortOptions {
  /** Aborts the call. The call then rejects with the signal's reason, and is not retried. */
  signal?: AbortSignal
}

/** Options for one {@link CallPort.command}. */
export interface CallPortCommandOptions extends CallPortOptions {
  /**
   * Lets the server recognise a repeat of this command: it runs a command once per key and answers
   * a repeat with the first result. Send the same key on every try of one command.
   */
  idempotencyKey?: string
}

/**
 * The two calls a page makes. A store written against this port works over the socket, over HTTP
 * and over the composed port alike.
 */
export interface CallPort {
  /**
   * Asks the server to change something and resolves with its result. Rejects with
   * {@link RealtimeRequestError} (the server's answer) or {@link ConnectionLostError} (no answer:
   * the command may or may not have run).
   *
   * Pass an `idempotencyKey`: the HTTP handler refuses a command without one with `bad_request`,
   * so a keyless command only works over the socket.
   */
  command(name: string, payload?: unknown, options?: CallPortCommandOptions): Promise<unknown>
  /** Asks the server for data and resolves with the answer. Failures as {@link command}. */
  query(name: string, payload?: unknown, options?: CallPortOptions): Promise<unknown>
}

/** A {@link CallPort} that can say whether it can carry a call right now. */
export interface AvailableCallPort extends CallPort {
  /** Whether a call sent now has a connection to travel on. */
  isAvailable(): boolean
}

/** Rejects with the signal's reason when it aborts first; otherwise passes `promise` through. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/** The part of {@link ClientTransport} the socket port needs. */
export interface SocketCallTransport {
  readonly status: TransportStatus
  command(name: string, payload?: unknown, options?: CommandOptions): Promise<unknown>
  query(name: string, payload?: unknown, options?: CallOptions): Promise<unknown>
}

/**
 * Fills the port with a client transport. {@link AvailableCallPort.isAvailable} is true while the
 * socket is open. A call whose `signal` aborts rejects with the reason at once; the frame, if
 * sent, is still answered by the server and the answer is dropped.
 */
export function createSocketCallPort(transport: SocketCallTransport): AvailableCallPort {
  return {
    isAvailable: () => transport.status === TransportStatus.Open,
    command: (name, payload, options = {}) =>
      raceAbort(
        transport.command(
          name,
          payload,
          options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey },
        ),
        options.signal,
      ),
    query: (name, payload, options = {}) =>
      raceAbort(transport.query(name, payload), options.signal),
  }
}

/** Options of {@link createHttpCallPort}. */
export interface HttpCallPortOptions {
  /** Where the calls go: a call named `note.create` is `POST <baseUrl>/note.create`. */
  baseUrl: string
  /** The id of the user the page was started for; sent with every call as `X-Realtime-User`. */
  userId: string
  /** Called once per call that the server answered with `unauthorized`. */
  onUnauthorized?: () => void
  /** Milliseconds to wait for an answer before giving up with `ConnectionLostError`. Default 15 s. */
  timeoutMs?: number
  /** Replaces `globalThis.fetch`, looked up at call time. Tests inject a fake. */
  fetch?: typeof fetch
  /** `fetch`'s `credentials`. Default `same-origin`: the session cookie goes to the same site. */
  credentials?: RequestCredentials
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000

/**
 * The code a status stands for when the body names none. `undefined`: the status says nothing
 * about the server's answer. A bare 404 or 429 is that too: a proxy answers them while a container
 * is replaced, and a real not-found or rate limit of ours carries the error body.
 */
function codeForStatus(status: number): RealtimeErrorCode | undefined {
  switch (status) {
    case 401:
      return "unauthorized"
    case 403:
      return "forbidden"
    case 408:
      return "timeout"
    case 409:
      return "conflict"
  }
  return status >= 400 && status < 500 && status !== 404 && status !== 429
    ? "bad_request"
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Reads the nested `{ error: { code, message, details? } }` body. `null` when it is not one. */
function readErrorBody(body: unknown): RealtimeRequestError | null {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const { code, message, details } = body.error
  if (!isRealtimeErrorCode(code)) return null
  return new RealtimeRequestError(code, typeof message === "string" ? message : code, details)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Fills the port with `fetch`: `POST <baseUrl>/<name>` with the payload as JSON. See the module
 * documentation for the wire contract.
 *
 * Failures: the server's `{ error: { code, message, details } }` becomes a
 * {@link RealtimeRequestError} with that code. A `fetch` that fails, a timeout, a 5xx without a
 * readable error body and a 2xx without a `{ result }` body (a proxy's page) are
 * {@link ConnectionLostError}: the outcome is unknown. A 4xx without a readable error body gets
 * the code its status stands for (401 `unauthorized`, 403 `forbidden`, 408 `timeout`,
 * 409 `conflict`, any other `bad_request`), except a bare 404 or 429, which a proxy answers while a
 * container is replaced and which are a {@link ConnectionLostError}. A call aborted by
 * its `signal` rejects with the signal's reason.
 */
export function createHttpCallPort(options: HttpCallPortOptions): CallPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS

  async function send(
    name: string,
    payload: unknown,
    extraHeaders: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      let response: Response
      try {
        response = await (options.fetch ?? globalThis.fetch)(
          `${baseUrl}/${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Realtime-User": options.userId,
              ...extraHeaders,
            },
            body: payload === undefined ? undefined : JSON.stringify(payload),
            credentials: options.credentials ?? "same-origin",
            signal: controller.signal,
          },
        )
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new ConnectionLostError(
          timedOut
            ? `no answer to ${name} within ${timeoutMs} ms`
            : `${name} could not be sent (${
              error instanceof Error ? error.message : "fetch failed"
            })`,
        )
      }
      let body: unknown
      try {
        body = await raceAbort(readJson(response), signal)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw error
      }
      if (timedOut) throw new ConnectionLostError(`no answer to ${name} within ${timeoutMs} ms`)
      if (response.ok) {
        if (isRecord(body) && "result" in body) return body.result
        throw new ConnectionLostError(`${name} was answered with something other than a result`)
      }
      const typed = readErrorBody(body)
      if (typed !== null) throw typed
      const code = codeForStatus(response.status)
      if (code === undefined) {
        throw new ConnectionLostError(`${name} failed with status ${response.status}`)
      }
      throw new RealtimeRequestError(code, `${name} failed with status ${response.status}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  const port: CallPort = {
    command: (name, payload, callOptions = {}) =>
      send(
        name,
        payload,
        callOptions.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": callOptions.idempotencyKey },
        callOptions.signal,
      ),
    query: (name, payload, callOptions = {}) => send(name, payload, {}, callOptions.signal),
  }
  return options.onUnauthorized === undefined
    ? port
    : withUnauthorizedHook(port, options.onUnauthorized)
}

/**
 * Wraps any port so that a call answered with `unauthorized` calls `onUnauthorized` once, then
 * rejects with the same error. It does not retry: {@link isRetryable} is false for the code. Use
 * it on a socket port, whose own module has no such hook; {@link createHttpCallPort} applies it
 * for you.
 */
export function withUnauthorizedHook<P extends CallPort>(port: P, onUnauthorized: () => void): P {
  const watch = async (call: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await call()
    } catch (error) {
      if (error instanceof RealtimeRequestError && error.code === "unauthorized") onUnauthorized()
      throw error
    }
  }
  return {
    ...port,
    command: (name, payload, options) => watch(() => port.command(name, payload, options)),
    query: (name, payload, options) => watch(() => port.query(name, payload, options)),
  }
}

/** Options of {@link createComposedCallPort}. */
export interface ComposedCallPortOptions {
  /** Preferred while {@link AvailableCallPort.isAvailable} says so. */
  socket: AvailableCallPort
  /** Used while the socket is not available, and when a socket call loses its connection. */
  http: CallPort
}

/**
 * Prefers the socket while it is open and uses HTTP otherwise. A socket call that fails with
 * {@link ConnectionLostError} is sent again over HTTP, with the same idempotency key, when that is
 * safe: a query, or a command that carries a key. A command without a key is not sent again,
 * since the socket may have delivered it before it dropped.
 *
 * Any other error is the server's answer and is thrown as it is: an `unauthorized` or `conflict`
 * over the socket is not asked again over HTTP.
 */
export function createComposedCallPort(options: ComposedCallPortOptions): CallPort {
  const { socket, http } = options
  return {
    async command(name, payload, callOptions = {}) {
      if (!socket.isAvailable()) return await http.command(name, payload, callOptions)
      try {
        return await socket.command(name, payload, callOptions)
      } catch (error) {
        if (!(error instanceof ConnectionLostError) || callOptions.idempotencyKey === undefined) {
          throw error
        }
        return await http.command(name, payload, callOptions)
      }
    },
    async query(name, payload, callOptions = {}) {
      if (!socket.isAvailable()) return await http.query(name, payload, callOptions)
      try {
        return await socket.query(name, payload, callOptions)
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) throw error
        return await http.query(name, payload, callOptions)
      }
    },
  }
}

/** Options of {@link sendCommand} and {@link sendQuery}. */
export interface RetryOptions {
  /** Total tries, including the first. Default 4. */
  attempts?: number
  /** Wait before the first repeat, in milliseconds; each further wait doubles. Default 1 000. */
  delayMs?: number
  /** Ceiling of one wait, in milliseconds. Default 30 000. */
  maxDelayMs?: number
  /** Fraction of each wait that jitter may remove, in `[0, 1)`. Default 0.5. */
  jitterRatio?: number
  /** Uniform source in `[0, 1)` for the jitter. Injected so tests are deterministic. */
  random?: () => number
  /** Waits `ms`. Defaults to the platform's `sleep`; a test passes a fake. */
  sleep?: (ms: number) => Promise<void>
  /** Makes the key a command is sent with; called once per command, never per try. */
  newKey?: () => string
  /** Aborts the call and any wait between tries. The call rejects with the signal's reason. */
  signal?: AbortSignal
}

/** Waits `ms`; an abort of `signal` ends the wait at once and clears its timer. */
function cancellableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep(ms)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const DEFAULT_ATTEMPTS = 4
const DEFAULT_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_JITTER_RATIO = 0.5

/**
 * Whether the outcome of a call is unknown or the server was busy, so trying again can help: the
 * answer did not arrive in time, the connection dropped, the server gave up, or it is still
 * running the first try of the same command.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof RequestTimeoutError || error instanceof ConnectionLostError) return true
  if (error instanceof RealtimeRequestError) {
    if (error.code === "timeout") return true
    const details = error.details as { code?: unknown } | undefined
    return error.code === "conflict" && details?.code === "IN_PROGRESS"
  }
  return false
}

async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const wait = options.sleep ?? ((ms: number) => cancellableSleep(ms, options.signal))
  for (let attempt = 1;; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error) || options.signal?.aborted) throw error
      await raceAbort(
        wait(backoffDelay({
          rawMs: (options.delayMs ?? DEFAULT_DELAY_MS) * 2 ** (attempt - 1),
          maxMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
          jitterRatio: options.jitterRatio ?? DEFAULT_JITTER_RATIO,
          mode: "downward",
          ...(options.random === undefined ? {} : { random: options.random }),
        })),
        options.signal,
      )
    }
  }
}

/**
 * Sends a command with a fresh idempotency key and, when the outcome is unknown, sends it again
 * with the same key. The server runs a command once per key and answers a repeat with the first
 * result, so a repeat cannot do the work twice. Waits between tries grow from `delayMs` through
 * `backoffDelay`.
 */
export function sendCommand<T>(
  port: CallPort,
  name: string,
  payload: unknown,
  options: RetryOptions = {},
): Promise<T> {
  const idempotencyKey = (options.newKey ?? (() => crypto.randomUUID()))()
  return withRetry(
    async () =>
      await port.command(name, payload, {
        idempotencyKey,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }) as T,
    options,
  )
}

/** Sends a query, trying again when the connection is down or the answer is late. */
export function sendQuery<T>(
  port: CallPort,
  name: string,
  payload?: unknown,
  options: RetryOptions = {},
): Promise<T> {
  return withRetry(
    async () =>
      await port.query(
        name,
        payload,
        options.signal === undefined ? {} : { signal: options.signal },
      ) as T,
    options,
  )
}
