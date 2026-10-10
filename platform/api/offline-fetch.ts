/**
 * An offline-aware wrapper around {@link apiFetch}: it tells "the server answered with an error"
 * from "nothing answered", checks a reply against an arktype schema, and keeps a
 * "last request failed" flag an app can combine with the browser's online status.
 *
 * There are no signals here. The flag is a plain getter with a `subscribe` callback, so
 * `@spy4x/preact-signals` or any app can wrap it.
 *
 * @module
 */

import { type ArkErrors, type } from "arktype"
import { type ApiError, apiFetch } from "./api.ts"

/** The `code` of the error result for a reply that does not match the schema. */
export const INVALID_REPLY_CODE = "invalid_reply"

/** Outcome of {@link OfflineFetch.fetch}. */
export type OfflineApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
    ok: false
    /** The HTTP status of the answer, or `0` when nothing answered. */
    status: number
    error: ApiError
    /** True when the request got no answer, so the app is offline for now. */
    offline: boolean
  }

/** Options for {@link createOfflineFetch}. */
export interface OfflineFetchOptions {
  /** The function that sends the request. Defaults to {@link apiFetch}; a test passes a fake. */
  send?: typeof apiFetch
}

/** What {@link createOfflineFetch} returns. */
export interface OfflineFetch {
  /**
   * Sends one request and reports the outcome instead of throwing.
   *
   * - **Sets** the "last request failed" flag: the request got no answer, that is `fetch` threw
   *   (no connection, DNS, CORS, a blocked request). The result is `ok: false`, `status: 0`,
   *   `offline: true`.
   * - **Clears** the flag: an answer of any status, including 4xx and 5xx, a reply that is not
   *   JSON and a reply that fails `schema`. The server was reached.
   * - **Leaves the flag alone** and rejects with the signal's reason: the caller aborted through
   *   `init.signal`, `AbortSignal.timeout()` included (it rejects with `TimeoutError`). An abort
   *   says nothing about the network; an app that counts a timeout as lost connection passes its
   *   own timer and calls `report(true)`.
   *
   * `schema` is an arktype type (or any function that returns the value or `ArkErrors`); `data` has
   * the type the schema returns, so a schema that converts a date string to a `Date` types it as
   * a `Date`. With `schema`, a success body is checked and returned parsed. One that does not match is
   * `ok: false` with the answer's status, `offline: false` and `error.code` {@link INVALID_REPLY_CODE}. A server may send that code itself, so an app that must tell
   * the two apart also checks `status < 300`.
   * Without a schema the body is returned as `apiFetch` read it.
   */
  fetch<T = unknown>(
    path: string,
    init?: RequestInit,
    schema?: (data: unknown) => T | ArkErrors,
  ): Promise<OfflineApiResult<T>>
  /** True while the last request got no answer. Starts `false`. */
  readonly requestFailed: boolean
  /**
   * Calls `listener` with the new value whenever {@link requestFailed} changes, never when a
   * request leaves it as it was. Returns the function that stops listening. A listener that throws
   * makes the call that triggered it reject, so keep listeners from throwing.
   */
  subscribe(listener: (requestFailed: boolean) => void): () => void
  /**
   * Sets the flag by hand, for a transport that does not use this `fetch` but means the same by
   * "no answer" (for example a call port that throws `ConnectionLostError`). Notifies on change only.
   */
  report(requestFailed: boolean): void
}

/**
 * Creates one offline-aware fetch with its own "last request failed" flag. An app makes one and
 * routes its API requests through it.
 *
 * @example
 * ```ts
 * const api = createOfflineFetch()
 * const result = await api.fetch("/api/me", {}, type({ id: "number" }))
 * if (!result.ok && result.offline) showOfflineNotice()
 * const offline = !navigator.onLine || api.requestFailed
 * const stop = api.subscribe((failed) => render(failed))
 * ```
 */
export function createOfflineFetch(options: OfflineFetchOptions = {}): OfflineFetch {
  const send = options.send ?? apiFetch
  const listeners = new Set<(requestFailed: boolean) => void>()
  let failed = false

  function set(next: boolean): void {
    if (next === failed) return
    failed = next
    for (const listener of [...listeners]) listener(next)
  }

  return {
    async fetch<T = unknown>(
      path: string,
      init: RequestInit = {},
      schema?: (data: unknown) => T | ArkErrors,
    ): Promise<OfflineApiResult<T>> {
      let result
      try {
        result = await send<unknown>(path, init)
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason ?? error
        set(true)
        return {
          ok: false,
          status: 0,
          error: { status: 0, message: "The server did not answer" },
          offline: true,
        }
      }
      set(false)
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.error, offline: false }
      }
      if (!schema) return { ok: true, status: result.status, data: result.data as T }
      const parsed = schema(result.data)
      if (parsed instanceof type.errors) {
        return {
          ok: false,
          status: result.status,
          error: {
            status: result.status,
            message: "The server sent an unusable reply",
            code: INVALID_REPLY_CODE,
          },
          offline: false,
        }
      }
      return { ok: true, status: result.status, data: parsed }
    },
    get requestFailed() {
      return failed
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    report: set,
  }
}
