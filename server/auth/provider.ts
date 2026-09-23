/**
 * The shared shape every sign-in provider (password, email code, OAuth) returns and depends on.
 * Additive to `@spy4x/server/auth`: it names no new store method and changes no existing export.
 *
 * @module
 */

import type { Clock } from "@spy4x/platform/universal/time"
import type { CreatedSession, SecondFactorStatus, SessionManager } from "@spy4x/server/sign-in"

import type { AuthKey, AuthSessionRecord, AuthUser } from "./model.ts"
import type { AuthStore } from "./store.ts"

/** What a provider returns after a successful sign-up or sign-in. */
export interface SignInResult {
  user: AuthUser
  key: AuthKey
  session: CreatedSession<AuthSessionRecord>
}

/**
 * What every provider needs, injected by the app. `secondFactorFor` decides the session's
 * {@link SecondFactorStatus}. When the app leaves `secondFactorFor` out, a provider passes
 * `SecondFactorStatus.NotRequired` itself. `SessionManager.create` has no default for this field:
 * it requires it and throws a `TypeError` without it.
 */
export interface ProviderDeps {
  store: AuthStore
  sessions: SessionManager<AuthSessionRecord>
  clock?: Clock
  secondFactorFor?(user: AuthUser): Promise<SecondFactorStatus>
}
