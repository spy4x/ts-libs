/**
 * Minimal synchronous key/value port: the subset of the DOM `Storage` interface a caller needs to
 * persist a small value, and the one shape `@spy4x/platform/browser/storage`'s `StorageLike` and
 * `@spy4x/realtime`'s `KeyValueStore` both alias (#71). No import here on purpose — a package with
 * a KeyValueStore-shaped dependency (browser storage, a realtime cursor, a server-side fallback)
 * pulls in nothing but this file.
 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
