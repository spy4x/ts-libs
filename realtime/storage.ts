/**
 * Durable storage port for cursors and sync timestamps.
 *
 * The port is synchronous and key/value shaped on purpose: it is structurally satisfied by the
 * Web Storage `Storage` interface, which is where a browser client keeps a cursor across reloads.
 * Nothing here reaches for `localStorage` — a host application passes its storage in, so the
 * library never grabs a global at import time and never assumes a browser.
 */

import type { KeyValueStore as PlatformKeyValueStore } from "@spy4x/platform/universal/key-value-store"

/**
 * Minimal synchronous key/value store. `Storage` satisfies it structurally.
 *
 * @deprecated Use `KeyValueStore` from `@spy4x/platform/universal/key-value-store` — the same
 * three methods, homed there (#71) since this package has no dependency of its own to protect
 * either way and `@spy4x/platform` cannot depend on `@spy4x/realtime` without a publish-time
 * dependency cycle (see #181's `realtime/backoff.ts` importing `@spy4x/platform/universal/async`).
 */
export type KeyValueStore = PlatformKeyValueStore

/**
 * In-memory {@link KeyValueStore}.
 *
 * Used by tests and by a non-browser host that has no durable storage at hand. State does not
 * survive the instance, which is exactly why a durable store has to be injected where it matters.
 */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly #items = new Map<string, string>()

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value)
  }

  removeItem(key: string): void {
    this.#items.delete(key)
  }

  /** Keys currently held, sorted. Test and debug affordance. */
  keys(): string[] {
    return [...this.#items.keys()].sort()
  }
}
