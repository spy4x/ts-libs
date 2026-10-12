/**
 * Remembers, in this browser, how a person last signed in: the method's name and a masked email
 * address. A sign-in page reads it to put "Continue with Google" or "Continue as j***@example.com"
 * first for a returning visitor.
 *
 * The full address is never kept: {@link LastSignInStore.remember} masks it with `maskEmail`
 * before it is written, and {@link LastSignInStore.read} masks what it finds again, so a value
 * another script wrote in full is not returned in full either. Nothing here is a credential.
 *
 * Every call is safe where storage is missing, blocked or full: it goes through `browserStorage`,
 * which keeps a refused write in memory until the page closes. Nothing touches a global at import
 * time.
 *
 * @module
 */

import type { KeyValueStore } from "../universal/key-value-store.ts"
import { maskEmail } from "../universal/text.ts"
import { browserStorage } from "./storage.ts"

/** Longest method name {@link LastSignInStore.remember} keeps. */
export const MAX_LAST_SIGN_IN_METHOD_LENGTH = 64

/** How a person last signed in on this browser. */
export interface LastSignIn {
  /** The app's name for the method, such as `"password"`, `"google"` or `"oauth:github"`. */
  method: string
  /** The address they signed in with, masked (`j***@example.com`), or null when none was given. */
  email: string | null
}

/** Options for {@link createLastSignIn}. */
export interface LastSignInOptions {
  /**
   * Where to keep the value. Defaults to `localStorage`, looked up on every call. A store given
   * here may throw: a refused write is kept in memory instead.
   */
  storage?: KeyValueStore
}

/** A handle over one storage key. Each call reads storage again, so it holds no state of its own. */
export interface LastSignInStore {
  /** The storage key the app chose. */
  readonly key: string
  /** The remembered sign-in, or null when none was kept or the stored value is not one. */
  read(): LastSignIn | null
  /**
   * Keeps `method` and the masked form of `email`. `email` may be the full address or an already
   * masked one; a value with no `@`, null or nothing keeps no address. A `method` that is empty
   * or longer than {@link MAX_LAST_SIGN_IN_METHOD_LENGTH} keeps nothing and leaves the earlier
   * value in place.
   */
  remember(method: string, email?: string | null): void
  /** Drops the remembered sign-in, for a person who asks the browser to forget them. */
  forget(): void
}

/**
 * Creates the store for one `key`. The key is the app's: pick one no other code writes.
 *
 * To show it reactively, keep `read()` in a signal and set the signal after `remember` or
 * `forget`.
 *
 * @example
 * ```ts
 * const lastSignIn = createLastSignIn("auth:last-sign-in")
 * lastSignIn.remember("google", "jane.doe@example.com")
 * lastSignIn.read() // { method: "google", email: "j***@example.com" }
 * lastSignIn.forget()
 * ```
 */
export function createLastSignIn(key: string, options: LastSignInOptions = {}): LastSignInStore {
  const given = options.storage
  const storage = given ? browserStorage(() => given) : browserStorage()

  return {
    key,
    read(): LastSignIn | null {
      const raw = storage.getItem(key)
      if (raw === null) return null
      try {
        const stored: unknown = JSON.parse(raw)
        if (typeof stored !== "object" || stored === null) return null
        const { method, email } = stored as { method?: unknown; email?: unknown }
        if (!isMethod(method)) return null
        return { method, email: masked(email) }
      } catch (_notJson) {
        return null
      }
    },
    remember(method: string, email?: string | null): void {
      if (!isMethod(method)) return
      const value: LastSignIn = { method, email: masked(email) }
      storage.setItem(key, JSON.stringify(value))
    },
    forget(): void {
      storage.removeItem(key)
    },
  }
}

function isMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_LAST_SIGN_IN_METHOD_LENGTH
}

/** The masked form of an address, or null for anything that is not one. */
function masked(email: unknown): string | null {
  return typeof email === "string" && email.includes("@") ? maskEmail(email) : null
}
