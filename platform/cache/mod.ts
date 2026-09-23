/**
 * `@spy4x/platform/cache` — a JSON cache in front of a pluggable {@link ICacheStorage}.
 *
 * - {@link CacheService} — `get`/`set`/`delete`/`wrap`/`reset` over one `ICacheStorage`.
 * - {@link buildMethods} — a namespaced, optionally schema-validated view for one record type.
 * - {@link ICacheStorage} — the storage contract `server/kv` implements over Redis.
 * - {@link reviveIsoDatesEndingInAt} — opt-in `JSON.parse` reviver; see `cache.ts` for why it is
 *   opt-in rather than the default.
 *
 * No in-memory `ICacheStorage` ships from this package: the source this was ported from kept its
 * fake local to its test file, and the real, published implementation is `server/kv`'s.
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
