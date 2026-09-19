/**
 * Durable storage port for cursors and sync timestamps.
 *
 * The port is synchronous and key/value shaped on purpose: it is structurally satisfied by the
 * Web Storage `Storage` interface, which is where a browser client keeps a cursor across reloads.
 * Nothing here reaches for `localStorage` — a host application passes its storage in, so the
 * library never grabs a global at import time and never assumes a browser.
 */

/** Minimal synchronous key/value store. `Storage` satisfies it structurally. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

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
