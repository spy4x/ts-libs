/**
 * Typed `localStorage` / `sessionStorage` wrapper.
 *
 * Two deliberate changes from the source (`financy/libs/shared/local-storage/+index.ts`):
 *
 * 1. **No global at import time.** The source constructed `new StorageHelper(localStorage)` at
 *    module scope, which throws under SSR (Deno, a worker without storage, a prerender pass) and
 *    makes the module untestable without a global stub. Here the `Storage`-shaped object is a
 *    parameter, so this works against a real `localStorage`, a `Map`-backed fake, or a namespaced
 *    adapter.
 * 2. **Validation through `@spy4x/validation`.** The written value is checked against the schema
 *    before it is stored, not only on read — an invalid writer is a bug, and a test is where it
 *    should surface. A read that fails validation evicts the entry, because a stored value that no
 *    longer matches its schema is stale, not merely missing.
 */

import type { Type } from "arktype"

import type { InferSchema } from "../universal/schema.ts"
import type { KeyValueStore } from "../universal/key-value-store.ts"
import { validate } from "@spy4x/validation"

/**
 * The subset of the DOM `Storage` interface this module uses.
 *
 * @deprecated Use `KeyValueStore` from `@spy4x/platform/universal/key-value-store` — the same
 * three methods, in a file with no import of its own.
 */
export type StorageLike = KeyValueStore

/** Outcome of a write or a read, so a caller can tell "absent" from "present but rejected". */
export type StorageRead<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "invalid"; reason: string }

/** A namespaced handle over one key. */
export interface TypedStorage<T> {
  /** Parse and, when a schema was given, validate the stored value. */
  get(): StorageRead<T>
  /** Serialise and, when a schema was given, validate before writing. */
  set(value: T): StorageRead<T>
  /** Remove the key. */
  del(): void
  /** The key this handle owns. */
  readonly key: string
}

/** Options for {@link makeStorage}. */
export interface MakeStorageOptions<S extends Type> {
  /** Validation schema. Omit for a raw JSON store. */
  schema?: S
  /**
   * Called when a value fails to parse or validate, before it is evicted. Defaults to a no-op — a
   * storage helper must not decide that a product's error surface exists.
   */
  onReject?: (key: string, reason: string) => void
}

/**
 * Bind a {@link StorageLike} to one key.
 *
 * Overloads rather than one signature: with a schema the value type is inferred from it, without
 * one the caller names the type. Both return a store whose `set` argument is checked.
 */
export function makeStorage<S extends Type>(
  storage: StorageLike,
  key: string,
  options: MakeStorageOptions<S> & { schema: S },
): TypedStorage<InferSchema<S>>
export function makeStorage<T>(
  storage: StorageLike,
  key: string,
  options?: MakeStorageOptions<Type> & { schema?: undefined },
): TypedStorage<T>
export function makeStorage<T>(
  storage: StorageLike,
  key: string,
  options: MakeStorageOptions<Type> = {},
): TypedStorage<T> {
  const onReject = options.onReject ?? (() => {})

  /** A value already in storage failed to parse or validate: evict it, so a read never re-rejects. */
  const rejectRead = (reason: string): StorageRead<T> => {
    onReject(key, reason)
    // A stored value that cannot satisfy its own schema is never readable again; keeping it would
    // silently re-reject on every read.
    storage.removeItem(key)
    return { status: "invalid", reason }
  }

  /**
   * A caller's new value failed validation: report it, without touching whatever is already
   * stored. The value being written was never persisted, so there is nothing stale to evict — the
   * key still holds the last value that *did* pass, and a bad write must not erase it.
   */
  const rejectWrite = (reason: string): StorageRead<T> => {
    onReject(key, reason)
    return { status: "invalid", reason }
  }

  return {
    key,

    get(): StorageRead<T> {
      const raw = storage.getItem(key)
      if (raw === null) return { status: "missing" }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return rejectRead(error instanceof Error ? error.message : "unparseable JSON")
      }

      if (!options.schema) return { status: "ok", value: parsed as T }

      const result = validate(options.schema, parsed)
      if (result.error) return rejectRead(result.error.description)
      return { status: "ok", value: result.data as unknown as T }
    },

    set(value: T): StorageRead<T> {
      if (!options.schema) {
        storage.setItem(key, JSON.stringify(value))
        return { status: "ok", value }
      }
      const result = validate(options.schema, value)
      if (result.error) return rejectWrite(result.error.description)
      storage.setItem(key, JSON.stringify(result.data))
      return { status: "ok", value: result.data as unknown as T }
    },

    del(): void {
      storage.removeItem(key)
    },
  }
}

/** A `Map`-backed {@link StorageLike}. Handy in tests and as a server-side fallback. */
export function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { readonly size: number } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get size() {
      return map.size
    },
  }
}

/**
 * `localStorage` that keeps working when the browser blocks it: a private window, blocked site
 * data, a full quota, or no `localStorage` at all (a prerender pass, a worker).
 *
 * A write goes to a memory copy first and then to the browser, so the value survives until the
 * page closes even when the browser refuses it. A read asks the browser and trusts its answer, a
 * missing key included, so a key another tab removed stays removed; only when the browser cannot be
 * asked (it throws, or there is none) does the memory copy answer. A removal clears both. Nothing here
 * throws, so a caller never needs its own `try`.
 *
 * @param area Where the browser keeps the data, looked up on every call because merely reading
 * `localStorage` throws when it is blocked. Defaults to `globalThis.localStorage`.
 */
export function browserStorage(
  area: () => KeyValueStore | null | undefined = () => globalThis.localStorage,
): KeyValueStore {
  const memory = new Map<string, string>()
  return {
    getItem(key) {
      try {
        const browser = area()
        if (browser) return browser.getItem(key)
      } catch (_blocked) {
        // Answer from memory.
      }
      return memory.get(key) ?? null
    },
    setItem(key, value) {
      memory.set(key, value)
      try {
        area()?.setItem(key, value)
      } catch (_blocked) {
        // Kept in memory until the page closes.
      }
    },
    removeItem(key) {
      memory.delete(key)
      try {
        area()?.removeItem(key)
      } catch (_blocked) {
        // Nothing stored, nothing to remove.
      }
    },
  }
}
