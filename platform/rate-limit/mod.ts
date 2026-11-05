/**
 * `@spy4x/platform/rate-limit` — sliding-window rate limiting with a pluggable store.
 *
 * - {@link createMemoryRateLimiter} — in-process, for one isolate.
 * - {@link createStoreLimiter} + `kv.ts` — shared store, for several instances.
 * - {@link createRateLimitMiddleware} — Hono middleware emitting draft-6 `RateLimit-*` headers.
 * - {@link clientIp} — proxy-header extraction, with the trust boundary documented there.
 *
 * The eviction policy and the sliding-vs-fixed decision are in `memory.ts`'s module doc.
 *
 * ```ts
 * import { Hono } from "hono"
 * import {
 *   createMemoryRateLimiter,
 *   createRateLimitMiddleware,
 *   userThenIp,
 * } from "@spy4x/platform/rate-limit"
 *
 * const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 10 })
 * const app = new Hono<{ Bindings: { remoteAddr?: string } }>()
 *
 * // `remoteAddr` reads the connection's own peer address from whatever the runtime exposes —
 * // `Deno.serve`'s `server.requestIP(req)`, `Bun.serve`'s `server.requestIP(req)`, or a value an
 * // earlier middleware stored. It reaches the resolver as `context.remoteAddr`. Under `deno serve`,
 * // pass `denoServeRemoteAddr`, which reads the address Deno hands to Hono.
 * app.use(createRateLimitMiddleware(limiter, {
 *   remoteAddr: ({ env }) => env?.remoteAddr,
 *   keyResolver: userThenIp((req) => userIdFrom(req)),
 * }))
 * ```
 *
 * `limit` must be at least 1; a fractional limit is rounded down (`limit: 2.9` allows 2 requests).
 *
 * Leave `trustedProxy` off (the default) unless a proxy in front strips and rewrites the forwarding
 * headers; with it on and no proxy, the limiter is trivially defeated — see the trust boundary below.
 * `trustedProxy` also accepts a single header name (`"x-real-ip"`, `"x-forwarded-for"` or
 * `"cf-connecting-ip"`) instead of `true`, for a proxy — Traefik's default settings, for one — that
 * rewrites only some of the three.
 *
 * Several instances share one store:
 *
 * ```ts
 * import { createKvStore, createStoreLimiter, denoKvBackend } from "@spy4x/platform/rate-limit"
 *
 * const kv = await Deno.openKv() // caller owns the handle and must close() it
 * const store = createKvStore({ backend: denoKvBackend(kv) })
 * const limiter = createStoreLimiter(store, { windowMs: 60_000, limit: 10 })
 * ```
 *
 * Redis or Postgres reach the same limiter by implementing `RateLimitStore` (`read`, `write`,
 * `delete`, and optionally the atomic `consume`) — `createStoreLimiter` is the only thing the core
 * needs. For several instances use an atomic store (see below).
 *
 * **Same semantics as the in-process limiter**, asserted by a parity test that drives both with one
 * multi-event sequence and compares `allowed` and `remaining` decision for decision. The entry's TTL
 * comes from the bucket's **newest** event (`newest + windowMs − now`) on both branches of
 * `StoreRateLimiter`: a TTL from the oldest event would expire the bucket early and restart the window.
 *
 * **Read-modify-write is not atomic across instances, and it loses writes.** Two instances can read the
 * same window and both accept; the later `write` then overwrites the earlier one, so an accepted request
 * is never recorded. That repeats while requests overlap, so when a client's requests reach every
 * instance in lockstep bursts the effective limit approaches `limit × instances` (4 instances at limit
 * 10 accepted 40 in a measured burst), not `limit + instances - 1`. The 3-method port forecloses a Deno
 * KV `atomic().check()` compare-and-swap on purpose. **Several instances that must hold the limit need
 * an atomic store:** a store may implement the optional `RateLimitStore.consume(key, now, windowMs,
 * limit)`, which trims, counts and records in one backend step, and `StoreRateLimiter.check` then uses
 * it instead of `read` plus `write`. `createRedisRateLimitStore` in `@spy4x/server/kv` does this with
 * one Lua script, and implements the optional `RateLimitStore.release` for an atomic `refund` as well.
 * Over a store without `release`, `refund` is read-modify-write and a refund that overlaps other
 * instances' checks can erase their events.
 *
 * **When the store goes down.** A store-backed limiter throws when its store does, and the request
 * fails. That is right for a limit that stops guessing a password or a one-time code. For a limit that
 * only shields capacity, wrap the limiter so an outage lets requests through and is reported:
 *
 * ```ts
 * import { createStoreLimiter, failOpenLimiter } from "@spy4x/platform/rate-limit"
 *
 * const limiter = failOpenLimiter(createStoreLimiter(store, { windowMs: 60_000, limit: 100 }), {
 *   limit: 100,
 *   onError: (error, key) => console.error(`rate limit store failed for ${key}`, error),
 * })
 * ```
 *
 * A fail-open decision records nothing and carries no `at`, and the wrapper's `refund` ignores a call
 * without `at`, so `skipSuccessful` cannot remove another request's event after an outage. An `onError`
 * that throws or rejects is ignored, so a failing reporter cannot fail the request it reports on.
 *
 * ## Notes
 *
 * - **Not here:** quota and usage accounting (`server/quota`) — metering
 *   is a separate concern with a different lifetime.
 * - **Not installed:** `hono-rate-limiter` and `rate-limit-redis`. The first is this middleware; the
 *   second would make a Redis client a hard dependency of the limiter core, which is what the
 *   `RateLimitStore` port avoids.
 * - `Deno.openKv()` is the one call with no test: it needs `--unstable-kv` (plus a writable path), and
 *   the repo's `deno test` grants only `--allow-read --allow-env`. Everything around it is covered —
 *   `denoKvBackend` consumes a `DenoKvLike` port, so it is tested against a fake handle (namespace key
 *   shape, `{ value }` unwrapping, `{ value: null }` treated as absent, `expireIn` pass-through
 *   including no-TTL ≠ TTL 0, `delete`, and a limiter driven end to end through it), and the store
 *   logic on top is covered too, including cross-store parity.
 *
 * @module
 */

export {
  type Clock,
  createMemoryRateLimiter,
  createStoreLimiter,
  DEFAULT_IDLE_MS,
  failOpenLimiter,
  type FailOpenLimiterOptions,
  MemoryRateLimiter,
  type MemoryRateLimiterOptions,
  type RateLimitConsumeResult,
  type RateLimitDecision,
  type RateLimiter,
  rateLimitKey,
  RateLimitKind,
  type RateLimitOptions,
  type RateLimitStore,
  StoreRateLimiter,
  SWEEP_EVERY_CHECKS,
  systemClock,
} from "./memory.ts"

export {
  createKvStore,
  denoKvBackend,
  type DenoKvLike,
  type KvStoreOptions,
  type RateLimitKv,
  type RateLimitKvEntry,
  RateLimitStoreOverKv,
} from "./kv.ts"

export {
  createRateLimitMiddleware,
  decisionHeaders,
  denoServeRemoteAddr,
  type KeyResolver,
  RATE_LIMIT_HEADERS,
  type RateLimitContext,
  type RateLimitErrorBody,
  type RateLimitHeaderNames,
  type RateLimitHonoContext,
  type RateLimitMiddleware,
  type RateLimitMiddlewareOptions,
  REJECTION_STATUSES,
  type RejectionStatus,
  type RemoteAddrResolver,
  serveRemoteAddr,
  userThenIp,
  type UserThenIpOptions,
} from "./hono.ts"

export {
  clientIp,
  clientIpBucket,
  type ClientIpBucketOptions,
  type ClientIpOptions,
  FORWARDED_HEADERS,
  humanRetry,
  type TrustedProxyHeader,
  UNKNOWN_CLIENT_IP,
} from "./client-ip.ts"
