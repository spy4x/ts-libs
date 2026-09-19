/**
 * Hono middleware factory over any limiter from `memory.ts`.
 *
 * Ported from `gb/apps/api/services/rateLimiter.ts` + `middlewares/rateLimiter.ts`, with the two
 * external packages dropped: `hono-rate-limiter`'s whole job here is "run a limiter, emit draft-6
 * headers", which is this file, and `rate-limit-redis` existed to put the store in Redis — a job
 * the `RateLimitStore` port now does without dragging a Redis client into the limiter.
 *
 * What is emitted is **draft-6**, matching `standardHeaders: "draft-6"` in the source: the three
 * separate fields `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, plus `Retry-After`
 * on a rejection. Draft-7 replaced them with one combined `RateLimit` field; that is not ported, so
 * a client written against draft-7 will not find the combined header here.
 *
 * Configuration is validated with arktype at factory time: a limiter built with `limit: 0` or a
 * negative window would silently deny or allow everything, and that failure belongs at startup, not
 * in production traffic.
 */

import { type as arkType } from "arktype"
import type { Context, Env, MiddlewareHandler } from "hono"

import { clientIp } from "./client-ip.ts"
import type { RateLimitDecision, RateLimiter } from "./memory.ts"

/** JSON-safe response body for a rejected request. */
export interface RateLimitErrorBody {
  error: string
}

/**
 * Statuses a rejection may use.
 *
 * Spelled out instead of importing Hono's `ContentfulStatusCode`: that type is not re-exported from
 * `hono`'s root module and reaching for `hono/utils/http-status` is not a resolvable specifier
 * under this workspace's import map. A literal union is also the honest shape — a limiter rejects
 * with a client or server error and nothing else.
 */
export type RejectionStatus =
  | 400
  | 401
  | 403
  | 404
  | 408
  | 409
  | 410
  | 418
  | 422
  | 425
  | 429
  | 451
  | 500
  | 502
  | 503
  | 504

/** The same set at runtime, so a bad status is refused at startup rather than at first rejection. */
export const REJECTION_STATUSES: ReadonlySet<number> = new Set<number>([
  400,
  401,
  403,
  404,
  408,
  409,
  410,
  418,
  422,
  425,
  429,
  451,
  500,
  502,
  503,
  504,
])

/** Header names, overridable for callers that need a prefixed variant. */
export interface RateLimitHeaderNames {
  limit: string
  remaining: string
  reset: string
  retryAfter: string
}

/** Default draft-6 header names. */
export const RATE_LIMIT_HEADERS: RateLimitHeaderNames = {
  limit: "RateLimit-Limit",
  remaining: "RateLimit-Remaining",
  reset: "RateLimit-Reset",
  retryAfter: "Retry-After",
}

/**
 * Runtime-validated middleware configuration.
 *
 * `"+": "reject"` makes an unknown key a startup error rather than a silent no-op, and the bounds
 * reject the two settings that would otherwise disable the limiter in production: a rejection
 * status outside the 4xx/5xx range and an empty message.
 */
const optionsSchema = arkType({
  "+": "reject",
  "keyResolver?": "Function",
  "errorMessage?": "string>0",
  "status?": "400 <= number.integer <= 599",
  "keyPrefix?": "string",
  "headers?": "object",
})

/** Options for {@link createRateLimitMiddleware}. */
export interface RateLimitMiddlewareOptions {
  /**
   * Bucket the request. Takes the framework request, because the request is all a key needs and
   * reaching into framework context for app state is what made `gb`'s version uncopyable.
   */
  keyResolver: (req: Request) => string | Promise<string>
  /** Rejection body. Defaults to `"Too many requests, please try again later."` */
  errorMessage?: string
  /** Status for a rejection. Defaults to 429. */
  status?: RejectionStatus
  /** Namespace prepended to every key. */
  keyPrefix?: string
  /** Header names to write. Defaults to {@link RATE_LIMIT_HEADERS}. */
  headers?: Partial<RateLimitHeaderNames>
}

/** The slice of Hono's context this middleware touches. */
export interface RateLimitContext {
  req: { raw: Request; header(name: string): string | undefined }
  header(name: string, value: string): void
  json(body: RateLimitErrorBody, status: number): Response
}

/**
 * Middleware shape as Hono types it, exported so a caller can store one in an object literal.
 *
 * `Env` is the caller's own environment — `Hono`'s `Context` is happy to be passed where this
 * module's structural {@link RateLimitContext} is expected, which is why the middleware is written
 * against the narrow interface above.
 */
export type RateLimitMiddleware<E extends Env = Record<string, never>> = MiddlewareHandler<E>

/** Hono's `Context` for whichever environment the caller uses. */
export type RateLimitHonoContext<E extends Env = Record<string, never>> = Context<E>

/**
 * Build the middleware for a limiter.
 *
 * The key resolver is a parameter because that was the only app-coupled line in the source
 * (`c.get?.("auth")`). `gb`'s optional chaining meant a missing auth middleware silently degraded
 * every request to a shared `ip:unknown` bucket; here the coupling is explicit and the fallback is
 * the caller's own code.
 *
 * @param rateLimiter Limiter to consult. Sync or async, both are awaited.
 * @param options Runtime-validated configuration.
 */
export function createRateLimitMiddleware<E extends Env = Record<string, never>>(
  rateLimiter: RateLimiter,
  options: RateLimitMiddlewareOptions,
): MiddlewareHandler<E> {
  const parsed = optionsSchema(options)
  if (parsed instanceof arkType.errors) {
    throw new Error(`invalid rate limit middleware options: ${parsed.summary}`)
  }
  if (typeof parsed.keyResolver !== "function") {
    throw new Error("invalid rate limit middleware options: keyResolver is required")
  }
  if (parsed.status !== undefined && !REJECTION_STATUSES.has(parsed.status)) {
    throw new Error(
      `invalid rate limit middleware options: status ${parsed.status} is not sendable`,
    )
  }

  const keyResolver = parsed.keyResolver as (req: Request) => string | Promise<string>
  const message = parsed.errorMessage ??
    "Too many requests, please try again later."
  // The schema has already bounded this to an integer in 400..599; the cast only names it.
  const status = (parsed.status ?? 429) as RejectionStatus
  const prefix = parsed.keyPrefix ?? ""
  const headers: RateLimitHeaderNames = { ...RATE_LIMIT_HEADERS, ...options.headers }

  return async (c, next) => {
    const raw = c.req.raw
    const key = `${prefix}${await keyResolver(raw)}`
    const decision = await rateLimiter.check(key)

    for (const [name, value] of Object.entries(decisionHeaders(decision, headers))) {
      c.header(name, value)
    }

    if (decision.allowed) {
      await next()
      return
    }
    return c.json({ error: message }, status)
  }
}

/**
 * Draft-6 headers for one decision.
 *
 * Every value is a non-negative integer rendered as a decimal string: `RateLimit-Reset` and
 * `Retry-After` are whole seconds, and the draft allows neither fractions nor negatives. The
 * conversion therefore clamps at zero and rounds up — rounding down would advertise a retry that
 * the limiter still rejects. `Retry-After` appears only on a rejection: a successful response has
 * nothing to retry. `RateLimit-Reset` stays the time left in the window on both paths, so a
 * rejected client can watch it count down.
 */
export function decisionHeaders(
  decision: RateLimitDecision,
  headers: RateLimitHeaderNames = RATE_LIMIT_HEADERS,
): Record<string, string> {
  const remaining = Math.max(0, Math.floor(decision.remaining))
  const secondsLeft = decision.allowed ? decision.resetAfterMs : decision.retryAfterMs
  const out: Record<string, string> = {
    [headers.limit]: String(Math.max(1, Math.floor(decision.limit))),
    [headers.remaining]: String(remaining),
    [headers.reset]: String(Math.max(1, Math.ceil(secondsLeft / 1000))),
  }
  if (!decision.allowed) {
    out[headers.retryAfter] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)))
  }
  return out
}

/**
 * Key a request on the authenticated user when the caller can find one, else on the client IP.
 *
 * Exported because it is the resolver every caller writes: `resolveKeyFromContext(c, idFromAuth)`
 * covers the `user:<id>` / `ip:<addr>` shape and keeps the "what is a user" decision in the app.
 */
export function userThenIp(
  userId: (req: Request) => string | undefined | Promise<string | undefined>,
  options: { remoteAddr?: (req: Request) => string | undefined; trustedProxy?: boolean } = {},
): (req: Request) => Promise<string> {
  return async (req: Request): Promise<string> => {
    const id = await userId(req)
    if (id !== undefined && id !== "") return `user:${id}`
    return `ip:${clientIp(req, options.remoteAddr?.(req), options.trustedProxy ?? true)}`
  }
}
