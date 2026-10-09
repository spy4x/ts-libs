/**
 * Asks the browser not to evict this site's storage (IndexedDB, caches) when space runs low.
 *
 * It matters for queued offline writes: Safari clears the storage of a site that is not installed
 * as an app after seven days without a visit, which would lose edits that were never sent. A
 * browser grants the request on its own rules (an installed app, a bookmark, engagement), so the
 * answer is data for the UI, not an error: when it is `false`, tell the person to install the app
 * and to open it before a week passes.
 */

/** The part of a browser's `StorageManager` this module uses. `navigator.storage` fits it. */
export interface PersistentStorageManager {
  persisted(): Promise<boolean>
  persist(): Promise<boolean>
}

/**
 * Resolves `true` when this site's storage is persistent, asking the browser if it is not yet.
 * Resolves `false` when the browser refuses, has no support (`storage` is missing, as under SSR
 * or in an old browser) or throws. Never rejects. Safe to call on every start: an answer already
 * granted is returned without asking again. `storage` defaults to `navigator.storage`.
 */
export async function requestPersistentStorage(
  storage: PersistentStorageManager | undefined = globalThis.navigator?.storage,
): Promise<boolean> {
  if (!storage || typeof storage.persist !== "function") return false
  try {
    if (typeof storage.persisted === "function" && await storage.persisted()) return true
    return await storage.persist()
  } catch (_unsupported) {
    return false
  }
}
