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
 * No in-memory `ICacheStorage` ships from this package: the source this was ported from kept its
 * fake local to its test file, and the real, published implementation is `server/kv`'s.
 *
 * A JSON cache in front of a pluggable `ICacheStorage`, ported from `template/libs/platform/cache`
 * (cross-checked against `financy/libs/shared/cache`, which differs from the template only in using a
 * hardcoded `number` id instead of `string | number`, and lacking the date-reviving `JSON.parse`
 * reviver — template's is kept, made opt-in). `ICacheStorage`'s method names and meaning are unchanged
 * from the source: `server/kv`, a later unit of the same wave, implements it over Redis.
 *
 * Four behaviour changes, all because this package ships to consumers it does not control, unlike an
 * app's own `libs/`:
 *
 * - The date-reviving reviver (a property named `...At` holding an ISO string becomes a `Date`) is
 *   opt-in (`reviveIsoDatesEndingInAt`, passed via `CacheServiceOptions.reviver`), not applied to
 *   every cached value unconditionally. The unconditional version also fires on any field that merely
 *   ends in "At" without meaning a date.
 * - `set`/`wrap`'s TTL is named and typed as seconds throughout. The source's `ICacheService`
 *   interface named the parameter `ttlMs` while every implementation and caller treated it as seconds
 *   with no conversion — a caller trusting the interface's name and passing milliseconds would get a
 *   cache entry roughly 1000x longer-lived than intended.
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
 * No in-memory `ICacheStorage` ships from this package, matching the source: its own fake
 * (`MemoryCacheStorage`) lived in its test file, not as a library export, and stays that way here too.
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
