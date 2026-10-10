/**
 * The middleware every Hono API passes first: a request id, `contextStorage`, a request log line,
 * an optional auth parser, and a report for every error answered with 500 or more.
 *
 * Reports carry the request id, the method and the path, never the query, a header or a body.
 *
 * @module
 */

import type { Env, Hono, MiddlewareHandler } from "hono"
import { contextStorage } from "hono/context-storage"
import { HTTPException } from "hono/http-exception"
import { requestId } from "hono/request-id"
import type { ReportContext } from "@spy4x/platform"
import { randomBase64Url } from "@spy4x/platform/tokens"
import { requestLog } from "./log.ts"

/** Longest `X-Request-Id` kept when {@link BaseMiddlewareOptions.requestIdMaxLength} is unset. */
export const DEFAULT_REQUEST_ID_MAX_LENGTH = 128

/** Smallest `requestIdMaxLength` allowed: the length of a generated id. */
export const MIN_REQUEST_ID_MAX_LENGTH = 8

/** What {@link applyBaseMiddleware} needs. */
export interface BaseMiddlewareOptions {
  /** Receives the request log lines and the one `error: unhandled exception on …` line. */
  write: (...data: unknown[]) => void
  /** Runs last, after the log line; an app's session parser. Omitted, nothing runs. */
  parseAuth?: MiddlewareHandler
  /**
   * Receives every error answered with 500 or more, including one a route's own `onError`
   * answered. A throw from it, and a promise it returns that rejects, are swallowed: reporting
   * never changes the answer.
   */
  reportError?: (error: unknown, context: ReportContext) => unknown
  /**
   * Longest `X-Request-Id` the caller may send. A longer one is replaced by a generated id, so it
   * cannot reach a database column. An integer of at least {@link MIN_REQUEST_ID_MAX_LENGTH}, so
   * a generated id always fits; anything else makes {@link applyBaseMiddleware} throw a
   * `RangeError`. Defaults to {@link DEFAULT_REQUEST_ID_MAX_LENGTH}.
   */
  requestIdMaxLength?: number
  /** Paths left out of the request log, such as a health check. Defaults to none. */
  skipLogPaths?: readonly string[]
}

/**
 * Installs the base middleware on `app`, in this order: `contextStorage`, the request id (the
 * caller's up to the length cap, otherwise 8 random base64url characters), failure reporting, the
 * request log, then `parseAuth`.
 *
 * It also sets `app.onError`: an `HTTPException` is answered as it asks, anything else with a
 * plain 500. Every error answered with 500 or more is logged through `write` and handed to
 * `reportError`, whichever handler answered it; an `HTTPException` below 500 is an answer, not a
 * failure, and is not reported.
 *
 * @example
 * ```ts
 * const app = new Hono().basePath("/api")
 * applyBaseMiddleware(app, { write: console.log, skipLogPaths: ["/api/health"] })
 * ```
 */
export function applyBaseMiddleware<E extends Env>(
  app: Hono<E>,
  { write, parseAuth, reportError, requestIdMaxLength, skipLogPaths }: BaseMiddlewareOptions,
): void {
  if (
    requestIdMaxLength !== undefined &&
    (!Number.isInteger(requestIdMaxLength) || requestIdMaxLength < MIN_REQUEST_ID_MAX_LENGTH)
  ) {
    throw new RangeError(
      `requestIdMaxLength must be an integer of at least ${MIN_REQUEST_ID_MAX_LENGTH}, got ${requestIdMaxLength}`,
    )
  }
  // A route may answer an error in its own `onError`, so the failure is read after the answer:
  // `c.error` is set whichever handler answered, and a 5xx status means it was not the caller's.
  const reportFailures: MiddlewareHandler = async (c, next) => {
    await next()
    const error = c.error
    if (!error || c.res.status < 500) return
    write(`error: unhandled exception on ${c.req.method} ${c.req.path}`, error)
    try {
      const reported = reportError?.(error, {
        tags: { request_id: c.get("requestId") ?? "" },
        request: { method: c.req.method, path: c.req.path },
      })
      // An async reporter that rejects would otherwise be an unhandled rejection.
      Promise.resolve(reported).catch(() => {})
    } catch {
      // Reporting never changes the answer.
    }
  }
  app.onError((error, c) =>
    error instanceof HTTPException ? error.getResponse() : c.text("Internal Server Error", 500)
  )
  app.use(
    contextStorage(),
    requestId({
      generator: () => randomBase64Url(6),
      limitLength: requestIdMaxLength ?? DEFAULT_REQUEST_ID_MAX_LENGTH,
    }),
    reportFailures,
    requestLog({ write, skipPaths: skipLogPaths }),
    ...(parseAuth ? [parseAuth] : []),
  )
}
