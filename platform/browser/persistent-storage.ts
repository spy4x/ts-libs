/**
 * Asks the browser not to evict this site's storage (IndexedDB, caches) when space runs low.
 *
 * It matters for queued offline writes: Safari clears the storage of a site that is not installed
 * as an app after seven days without a visit, which would lose edits that were never sent. A
 * browser grants the request on its own rules (an installed app, a bookmark, engagement), so the
 * answer is data for the UI, not an error: when it is `false`, tell the person to install the app
 * and to open it before a week passes.
 *
 * @module
 */

import type { KeyValueStore } from "../universal/key-value-store.ts"

/** The part of a browser's `StorageManager` this module uses. `navigator.storage` fits it. */
export interface PersistentStorageManager {
  persisted(): Promise<boolean>
  persist(): Promise<boolean>
}

/**
 * Where {@link requestPersistentStorage} remembers that it has asked, so it asks once per device.
 */
export interface AskOnce {
  /** The `localStorage` key the app chose. */
  key: string
  /**
   * Where to remember. Defaults to `globalThis.localStorage`, treated as missing when the lookup
   * throws.
   */
  store?: KeyValueStore | null
}

/**
 * Resolves `true` when this site's storage is persistent, asking the browser if it is not yet.
 * Resolves `false` when the browser refuses, has no support (`storage` is missing, as under SSR
 * or in an old browser) or throws. Never rejects. Safe to call on every start: an answer already
 * granted is returned without asking again. `storage` defaults to `navigator.storage`.
 *
 * With `askOnce`, a browser that has been asked once is not asked again, however the person
 * answered: some browsers (Firefox) show a prompt, and asking on every start would nag. The note
 * is written before the request, so a request that never returns is not repeated either. When the
 * note cannot be read or written (blocked storage), the browser is asked anyway, as without
 * `askOnce`. Without `askOnce` the behaviour is unchanged.
 */
export async function requestPersistentStorage(
  storage: PersistentStorageManager | undefined = globalThis.navigator?.storage,
  askOnce?: AskOnce,
): Promise<boolean> {
  if (!storage || typeof storage.persist !== "function") return false
  try {
    if (typeof storage.persisted === "function" && await storage.persisted()) return true
    if (askOnce && !markAsked(askOnce)) return false
    return await storage.persist()
  } catch (_unsupported) {
    return false
  }
}

/** True when the browser may be asked now; records that it was. */
function markAsked({ key, store }: AskOnce): boolean {
  let notes: KeyValueStore | null
  try {
    notes = store === undefined ? globalThis.localStorage ?? null : store
  } catch (_blocked) {
    notes = null
  }
  try {
    const seen = notes?.getItem(key)
    if (seen !== null && seen !== undefined) return false
    notes?.setItem(key, "1")
  } catch (_blocked) {
    // The note cannot be kept: ask anyway.
  }
  return true
}
