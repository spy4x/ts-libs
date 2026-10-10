/**
 * A small "this device was signed in" hint kept in `localStorage`, so an installed app can open
 * offline to its last view instead of showing the sign-in page.
 *
 * The hint is **never a credential and must never hold a secret**: no password, token, session id
 * or cookie value. It only says what the app may show before the server can be asked; every request
 * still needs the real session, which the server checks. Store a flag (`true`) or the little the
 * screen needs (a user's id and name), nothing that would matter if another script read it.
 *
 * Every call is safe where storage is missing, blocked or full: nothing is remembered and
 * {@link SignedInHint.recall} answers `null`. Nothing here touches a global at import time.
 *
 * @module
 */

import type { KeyValueStore } from "../universal/key-value-store.ts"

/** Options for {@link createSignedInHint}. */
export interface SignedInHintOptions<T> {
  /**
   * Decides whether a stored value is the shape this app keeps. A value that fails it, like one that
   * is not valid JSON, counts as absent. Omit it to accept any JSON value except `null`.
   */
  validate?: (value: unknown) => value is T
  /**
   * Where to keep the hint. Defaults to `globalThis.localStorage`, looked up on every call and
   * treated as missing when the lookup throws. `null` means no storage at all.
   */
  storage?: KeyValueStore | null
}

/** A handle over one hint key. */
export interface SignedInHint<T> {
  /** The `localStorage` key the app chose. */
  readonly key: string
  /** Keeps `value` as JSON. Does nothing when storage is missing or throws. */
  remember(value: T): void
  /** The kept value, or `null` when none was kept, storage failed or the value is not valid. */
  recall(): T | null
  /** Drops the hint: sign-out, or a server that says the session ended. */
  forget(): void
}

/**
 * Creates the hint for one `key`. The key is the app's: pick one no other code writes.
 *
 * `T` is the kept value, written as JSON. A flag app uses `createSignedInHint<true>(key)`; an app
 * that keeps a user passes a `validate` that checks the user's shape. An existing flag written as
 * `1` is read by `validate: (v): v is 1 => v === 1`.
 *
 * @example
 * ```ts
 * const hint = createSignedInHint<{ id: number }>("offline:session", {
 *   validate: (v): v is { id: number } => typeof (v as { id?: unknown })?.id === "number",
 * })
 * hint.remember({ id: 7 })
 * hint.recall() // { id: 7 }, or null on a device with blocked storage
 * hint.forget()
 * ```
 */
export function createSignedInHint<T = true>(
  key: string,
  options: SignedInHintOptions<T> = {},
): SignedInHint<T> {
  const { validate, storage } = options

  function resolve(): KeyValueStore | null {
    if (storage !== undefined) return storage
    try {
      return globalThis.localStorage ?? null
    } catch (_blocked) {
      return null
    }
  }

  return {
    key,
    remember(value: T): void {
      try {
        resolve()?.setItem(key, JSON.stringify(value))
      } catch (_unavailable) {
        // No storage, or it is full: an offline start shows the sign-in page.
      }
    },
    recall(): T | null {
      try {
        const raw = resolve()?.getItem(key)
        if (raw === null || raw === undefined) return null
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null) return null
        if (validate && !validate(parsed)) return null
        return parsed as T
      } catch (_unavailable) {
        return null
      }
    },
    forget(): void {
      try {
        resolve()?.removeItem(key)
      } catch (_unavailable) {
        // Nothing stored, nothing to remove.
      }
    },
  }
}
