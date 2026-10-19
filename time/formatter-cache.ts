/**
 * The bounded store behind `tz.ts`'s formatter caches. Internal: not in the package's exports.
 *
 * Keys come from callers' text (a zone spelling, a locale tag), and `Intl` accepts endless
 * spellings of one zone (`eUrOpE/bErLiN`), so an unbounded map grows with whatever a stranger
 * sends. Each cache is emptied when it reaches {@link FORMATTER_CACHE_LIMIT}: a formatter is pure,
 * so a cleared cache only costs the time to build it again, never a different result.
 * @module
 */

/** The most formatters one cache holds before it is emptied. */
export const FORMATTER_CACHE_LIMIT = 500

/** Every cache made by {@link formatterCache}, so a test can check that none outgrows the limit. */
export const formatterCaches: Map<string, Intl.DateTimeFormat>[] = []

/**
 * A cache of formatters by key: the returned function hands back the cached formatter for `key`,
 * or builds one with `make`, emptying the cache first when it is full.
 */
export function formatterCache(): (
  key: string,
  make: () => Intl.DateTimeFormat,
) => Intl.DateTimeFormat {
  const cache = new Map<string, Intl.DateTimeFormat>()
  formatterCaches.push(cache)
  return (key, make) => {
    const cached = cache.get(key)
    if (cached) return cached
    if (cache.size >= FORMATTER_CACHE_LIMIT) cache.clear()
    const formatter = make()
    cache.set(key, formatter)
    return formatter
  }
}
