/**
 * `@spy4x/platform/cache` — a JSON cache in front of a pluggable {@link ICacheStorage}.
 *
 * - {@link CacheService} — `get`/`set`/`delete`/`wrap`/`reset` over one `ICacheStorage`.
 * - {@link buildMethods} — a namespaced, optionally schema-validated view for one record type.
 * - {@link ICacheStorage} — the storage contract `server/kv` implements over Redis.
 * - {@link failOpen} — wraps a storage so an outage never fails a request and a stale row is never
 *   served after one.
 * - {@link reviveIsoDatesEndingInAt} — opt-in `JSON.parse` reviver; see `cache.ts` for why it is
 *   opt-in rather than the default.
 *
 * Its rules, because this package ships to consumers it does not control:
 *
 * - The date-reviving reviver (a property named `...At` holding an ISO string becomes a `Date`) is
 *   opt-in (`reviveIsoDatesEndingInAt`, passed via `CacheServiceOptions.reviver`), not applied to
 *   every cached value unconditionally. The unconditional version also fires on any field that merely
 *   ends in "At" without meaning a date.
 * - `set`/`wrap`'s TTL is named and typed as seconds throughout, the unit `ICacheStorage.set`
 *   expects.
 * - A TTL is validated and rounded up to a whole second before it reaches storage. Redis refuses a
 *   fractional or zero expiry — `SET … EX 0.2` and `SET … EX 0` are both errors, and `EXPIRE key 0`
 *   deletes the key immediately — so this is done here, once, rather than in every `ICacheStorage`.
 * - `wrap` coalesces an in-flight `fn()` call for a key: a caller that reads the cache while another
 *   caller's `fn()` for the same key is still running awaits that same call instead of starting its
 *   own. Two different keys never share a call.
 *
 * `failOpen(storage, onError, retryMs?, now?)` wraps any `ICacheStorage` so an outage of the cache
 * server never fails a request. Reads are misses and writes are skipped while the cache server is
 * down. The wrapper starts untrusted, and the first failed operation makes it untrusted again,
 * because a skipped write or delete would otherwise let a restarted server serve a stale row. Trust
 * returns only after `reset()` of the real storage succeeds, tried at most once per `retryMs` (5 s),
 * on the next operation, with no timer. `CacheService.wrap` has no such mode.
 *
 * No in-memory `ICacheStorage` ships from this package: a test keeps its own fake, and the
 * published implementation is `server/kv`'s.
 *
 * @module
 */

export {
  buildMethods,
  CacheService,
  type CacheServiceOptions,
  type CacheWrapOptions,
  type ICacheService,
  type ICacheStorage,
  type PublicAPICacheModel,
  reviveIsoDatesEndingInAt,
} from "./cache.ts"

export {
  type CacheErrorReporter,
  type CacheOperation,
  DEFAULT_CACHE_RECOVERY_MS,
  failOpen,
} from "./fail-open.ts"
