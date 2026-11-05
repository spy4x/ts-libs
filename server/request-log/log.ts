/**
 * Request-logging middleware for Hono: one line when a request comes in, one line when the
 * response goes out.
 *
 * The app passes the write function — a request-id-tagged logger, a line shipped somewhere, or
 * nothing — and the paths to leave out, such as a health check, as `skipPaths`.
 *
 * **What this logs, and what it does not.** Every line carries only the HTTP method, the request
 * pathname, and — on the outgoing line — the response status and elapsed time. The pathname comes
 * from Hono's own `c.req.path`, which never includes the query string, so a token or password
 * passed as `?key=…` cannot reach a log line through this middleware. No header is read and no
 * request or response body is read.
 *
 * **One request, one line each way.** Hono decodes the pathname, so `%0A` arrives as a real line
 * break. A line break or any other control character in the path is written escaped, as `\n` or
 * `\x1b`, so a caller cannot start a second, forged log line.
 *
 * `requestLog`, `RequestLogOptions`, `RequestLogWriter`.
 *
 * `write` defaults to `console.log`, and `skipPaths` lists paths not to log, because which path is
 * a health check is the app's decision, not this middleware's.
 *
 * **What is logged, checked.** Every line carries only the HTTP method, the request pathname, and —
 * on the outgoing line — the response status and elapsed time. The pathname comes from Hono's own
 * `c.req.path`, which stops at the first `?`, so a token or password passed as a query parameter
 * never reaches a log line through this middleware; no header and no request or response body is
 * read at all. `log.test.ts` asserts it (`never logs the query string`, `does not read or log any
 * request header`).
 *
 * **One request, one line each way.** Hono decodes the pathname, so `%0A` arrives as a real line
 * break. A line break or any other control character in the method or the path is written escaped
 * (`\n`, `\r`, `\t`, `\x1b`, `\u2028`), so a caller cannot start a second, forged log line or send a
 * terminal an escape sequence. The `error: unhandled exception on …` line of `applyBaseMiddleware`
 * is escaped the same way. A backslash is kept as it is.
 *
 * **Arrows: `<--` on the way in, `-->` on the way out**, matching Hono's own built-in `hono/logger`.
 * `log.test.ts` pins the direction instead of only checking each line's other fields.
 *
 * **The color table's reach: checked, not assumed.** `c.res.status` is read as a plain property,
 * never checked against `instanceof Response`, so two paths reach the color table's edges without
 * needing a status the `Response` constructor itself would refuse: a handler that returns
 * `Response.error()` produces the network-error status `0` (checked: `app.get("/err", () =>
 * Response.error())` logs `<-- GET /err` then `--> GET /err 0 0ms`), and a handler that bypasses
 * Hono's own return type and hands back a plain object is logged by whatever `.status` that object
 * carries — `700`, in a check that returned `{ status: 700 } as unknown as Response`. Both are
 * asserted in `log.test.ts`. The color table carries entries for classes `0` and `7` for exactly this
 * reason, and falls back to the plain, uncolored status number for any class it does not carry, so
 * nothing here throws or prints the literal text `undefined` regardless of what a handler returns.
 *
 * **Decisions.** `hono/utils/color` is not the internal it looks like: `./utils/*` is part of the
 * published `hono` package's own `exports` map (checked against the pinned `hono@4.13.8`'s
 * `package.json`), so this middleware is layered on hono's public surface, not reaching past it —
 * consistent with hono staying a kept dependency. It reads Hono's own public `c.req.path`, not
 * `getPath(c.req.raw)`, so it imports `hono/utils/color` only — never `hono/utils/url`. Color output
 * stays: `getColorEnabled()` already turns it off for a non-TTY or `NO_COLOR` environment.
 *
 * @module
 */
import { getColorEnabled } from "hono/utils/color"
import type { Env, MiddlewareHandler } from "hono/types"
import { escapeControlCharacters } from "./escape.ts"

/** Called once per logged line. The line carries no newline of its own. */
export type RequestLogWriter = (line: string) => void

/** Options for {@link requestLog}. */
export interface RequestLogOptions {
  /**
   * Called once per line: `<-- GET /users` on the way in, `--> GET /users 200 12ms` on the way
   * out — the same direction as Hono's own built-in `hono/logger`. Defaults to
   * `console.log`. This is the one thing the app wires in — a logger that tags every line with a
   * request id, ships it somewhere, or both.
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
  Incoming = "<--",
  Outgoing = "-->",
}

/**
 * HTTP status classes (`status / 100`, truncated) mapped to an ANSI color code. Keyed defensively
 * beyond the real 1xx-5xx classes: `c.res.status` is read as a plain property, not checked against
 * `instanceof Response`, so a handler that hands back `Response.error()` (status `0`) or, bypassing
 * Hono's own types, a plain object carrying any number at all reaches this table verbatim — logged
 * directly (checked: `Response.error()` logs status `0`, and a handler returning `{ status: 700 }`
 * logs `700`). A class the table does not carry falls back to the plain, uncolored status number
 * below rather than throwing or printing `undefined`.
 */
const STATUS_COLOR_BY_CLASS: Readonly<Record<number, string>> = {
  0: "33", // Response.error(), or a handler that returned an object with no real status at all
  1: "32",
  2: "32",
  3: "36",
  4: "33",
  5: "31",
  7: "35", // e.g. a handler that bypassed Hono's types and returned an object with status 700
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
  // Hono decodes the path, so `%0A` arrives here as a real line break.
  const request = `${escapeControlCharacters(method)} ${escapeControlCharacters(path)}`
  return prefix === RequestLogPrefix.Incoming
    ? `${prefix} ${request}`
    : `${prefix} ${request} ${colorStatus(status ?? 0)} ${elapsed}`
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
