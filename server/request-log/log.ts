/**
 * Request-logging middleware for Hono: one line when a request comes in, one line when the
 * response goes out.
 *
 * Ported from `template/apps/api/middlewares/log.ts` (identical in `financy`; `gb` has no copy of
 * this file to compare — not part of this extraction). The original imported the app's
 * `APIContext` type and its `log` service directly, which a library cannot do. Here the write
 * function is a constructor argument instead — the app wires in whatever it wants (a
 * request-id-tagged logger, a line shipped somewhere, or nothing) — and the hardcoded
 * `/api/health` skip becomes a `skipPaths` option, because a health-check path is the app's
 * choice, not this middleware's.
 *
 * **What this logs, and what it does not.** Every line carries only the HTTP method, the request
 * pathname, and — on the outgoing line — the response status and elapsed time. The pathname comes
 * from Hono's own `c.req.path`, which never includes the query string, so a token or password
 * passed as `?key=…` cannot reach a log line through this middleware. No header is read and no
 * request or response body is read. The original had the same property (it built its path with
 * `getPath(c.req.raw)`, which stops at the first `?`) — nothing was leaking here, and this port
 * keeps that guarantee explicit and tested rather than incidental.
 */
import { getColorEnabled } from "hono/utils/color"
import type { Env, MiddlewareHandler } from "hono/types"

/** Called once per logged line. The line carries no newline of its own. */
export type RequestLogWriter = (line: string) => void

/** Options for {@link requestLog}. */
export interface RequestLogOptions {
  /**
   * Called once per line: `--> GET /users` on the way in, `<-- GET /users 200 12ms` on the way
   * out. Defaults to `console.log`. This is the one thing the app wires in — a logger that tags
   * every line with a request id, ships it somewhere, or both.
   */
  write?: RequestLogWriter
  /**
   * Exact pathnames that are never logged, matched against `c.req.path` (so a query string never
   * has to match). A liveness probe that fires every few seconds adds nothing once it is green;
   * the app names which paths those are for it — this middleware assumes none.
   */
  skipPaths?: readonly string[]
}

enum RequestLogPrefix {
  Incoming = "-->",
  Outgoing = "<--",
}

/** HTTP status classes (`status / 100`, truncated) mapped to an ANSI color code. */
const STATUS_COLOR_BY_CLASS: Readonly<Record<number, string>> = {
  0: "33", // no status yet
  1: "32",
  2: "32",
  3: "36",
  4: "33",
  5: "31",
  7: "35", // defensive: a driver could hand back a status arktype's own routes never produce
}

function colorStatus(status: number): string {
  if (!getColorEnabled()) return String(status)
  const code = STATUS_COLOR_BY_CLASS[Math.trunc(status / 100)]
  return code === undefined ? String(status) : `\x1b[${code}m${status}\x1b[0m`
}

/**
 * `123456` -> `"123,456"`. Only the digits before the unit separator are grouped, matching the
 * original's own `humanize`.
 */
function withThousandsSeparators(digits: string): string {
  return digits.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1,")
}

function elapsedSince(startMs: number): string {
  const delta = Date.now() - startMs
  return delta < 1000
    ? `${withThousandsSeparators(String(delta))}ms`
    : `${withThousandsSeparators(String(Math.round(delta / 1000)))}s`
}

function formatLine(
  prefix: RequestLogPrefix,
  method: string,
  path: string,
  status?: number,
  elapsed?: string,
): string {
  return prefix === RequestLogPrefix.Incoming
    ? `${prefix} ${method} ${path}`
    : `${prefix} ${method} ${path} ${colorStatus(status ?? 0)} ${elapsed}`
}

/**
 * Build the request-log middleware.
 *
 * @example
 * ```ts
 * const app = new Hono()
 * app.use(requestLog({ write: (line) => log(line), skipPaths: ["/api/health"] }))
 * ```
 */
export function requestLog<E extends Env = Env>(
  options: RequestLogOptions = {},
): MiddlewareHandler<E> {
  const write = options.write ?? console.log
  const skip = new Set(options.skipPaths ?? [])
  return async function requestLog(c, next) {
    const { method } = c.req
    const path = c.req.path
    if (skip.has(path)) {
      await next()
      return
    }
    write(formatLine(RequestLogPrefix.Incoming, method, path))
    const start = Date.now()
    await next()
    write(formatLine(RequestLogPrefix.Outgoing, method, path, c.res.status, elapsedSince(start)))
  }
}
