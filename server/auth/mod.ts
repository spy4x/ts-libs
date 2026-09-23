/**
 * `@ts-libs/server/auth` — the sign-in account model and its store: a minimal user, the keys a user
 * signs in with (proven or unproven), guess-counted challenges, and the `AuthStore` interface the
 * sign-in providers build on. See the `server/auth` section of `server/README.md`.
 *
 * The Postgres implementation is `@ts-libs/server/auth/postgres`; the in-memory one for unit tests
 * is `@ts-libs/server/auth/memory-store`.
 *
 * @module
 */

export {
  AuthConflictError,
  type AuthConflictReason,
  type AuthKey,
  type AuthSessionRecord,
  type AuthUser,
  ChallengeOutcome,
  MAX_EMAIL_LENGTH,
  type NewAuthKey,
  normalizeEmail,
} from "./model.ts"
export {
  type AttemptChallengeInput,
  AUTH_STORE_METHODS,
  type AuthStore,
  type IssueChallengeInput,
} from "./store.ts"
export { type ProviderDeps, type SignInResult } from "./provider.ts"
