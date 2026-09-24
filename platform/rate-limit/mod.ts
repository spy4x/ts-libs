/**
 * `@spy4x/platform/rate-limit` — sliding-window rate limiting with a pluggable store.
 *
 * - {@link createMemoryRateLimiter} — in-process, for one isolate.
 * - {@link createStoreLimiter} + `kv.ts` — shared store, for several instances.
 * - {@link createRateLimitMiddleware} — Hono middleware emitting draft-6 `RateLimit-*` headers.
 * - {@link clientIp} — proxy-header extraction, with the trust boundary documented there.
 *
 * See `README.md` for the eviction policy and the sliding-vs-fixed decision.
 */

export {
  type Clock,
  createMemoryRateLimiter,
  createStoreLimiter,
  DEFAULT_IDLE_MS,
  MemoryRateLimiter,
  type MemoryRateLimiterOptions,
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
  userThenIp,
} from "./hono.ts"

export { clientIp, humanRetry, type TrustedProxyHeader, UNKNOWN_CLIENT_IP } from "./client-ip.ts"
