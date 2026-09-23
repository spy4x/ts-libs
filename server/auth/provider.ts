/**
 * The shared shape every sign-in provider (password, email code, OAuth) returns and depends on.
 * Additive to `@ts-libs/server/auth`: it names no new store method and changes no existing export.
 *
 * @module
 */

import type { Clock } from "@ts-libs/platform/universal/time"
import type { CreatedSession, SecondFactorStatus, SessionManager } from "@ts-libs/server/sign-in"

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
 * {@link SecondFactorStatus}; a provider that omits it starts every session `NotRequired`, the
 * same default `SessionManager.create` applies when the field is left out.
 */
export interface ProviderDeps {
  store: AuthStore
  sessions: SessionManager<AuthSessionRecord>
  clock?: Clock
  secondFactorFor?(user: AuthUser): Promise<SecondFactorStatus>
}
