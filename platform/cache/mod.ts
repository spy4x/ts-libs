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
