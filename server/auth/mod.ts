/**
 * `@spy4x/server/auth` — the sign-in account model and its store: a minimal user, the keys a user
 * signs in with (proven or unproven), guess-counted challenges, and the `AuthStore` interface the
 * sign-in providers build on. See the `server/auth` section of `server/README.md`.
 *
 * The Postgres implementation is `@spy4x/server/auth/postgres`; the in-memory one for unit tests
 * is `@spy4x/server/auth/memory-store`.
 *
 * Sessions, the session cookie, guards and password hashing are in `@spy4x/server/sign-in`.
 *
 * The sign-in account model and its store: a minimal user, the keys a user signs in with, and
 * guess-counted challenges. The sign-in providers (password, a one-time code by email, OAuth2 and
 * OpenID Connect) are built on it; sessions, the cookie and password hashing come from
 * `server/sign-in`.
 *
 * | Export                            | What it is                                                                   |
 * | --------------------------------- | ---------------------------------------------------------------------------- |
 * | `@spy4x/server/auth`              | `AuthUser`, `AuthKey`, `normalizeEmail`, `ChallengeOutcome`, the `AuthStore` |
 * | `@spy4x/server/auth/postgres`     | `AUTH_POSTGRES_SCHEMA`, `createPostgresAuthStore`, the session store         |
 * | `@spy4x/server/auth/memory-store` | `MemoryAuthStore`: the same rules in memory, for unit tests                  |
 *
 * `@spy4x/server/auth` also exports `ProviderDeps` and `SignInResult`, the shape every provider
 * takes and returns: the store, the `SessionManager`, an optional clock and an optional
 * `secondFactorFor(user)`. When the app leaves `secondFactorFor` out, a provider creates the session
 * with `SecondFactorStatus.NotRequired`. The providers themselves are separate entry points, each with
 * its own section below.
 *
 * ```ts
 * import { createSqlFromEnv } from "@spy4x/server/db"
 * import { SessionManager } from "@spy4x/server/sign-in"
 * import type { AuthSessionRecord } from "@spy4x/server/auth"
 * import {
 *   AUTH_POSTGRES_SCHEMA,
 *   createPostgresAuthStore,
 *   createPostgresSessionStore,
 * } from "@spy4x/server/auth/postgres"
 *
 * const sql = createSqlFromEnv(Deno.env.toObject())
 * if (!sql) throw new Error("DB_HOST is not set")
 *
 * // Once, as a migration: await sql.unsafe(AUTH_POSTGRES_SCHEMA)
 * const store = createPostgresAuthStore(sql)
 * const sessions = new SessionManager<AuthSessionRecord>({
 *   store: createPostgresSessionStore(sql),
 *   pepper: Deno.env.get("SESSION_PEPPER") ?? "",
 *   durationMinutes: 60 * 24 * 30,
 * })
 * ```
 *
 * ## The model
 *
 * **A user is an id.** `AuthUser` has an id, `createdAt` and `deletedAt`, nothing else. The app keeps
 * its profile in its own table keyed by that id.
 *
 * **The stores join the caller's transaction.** Both stores take either the pool or a transaction
 * handle — the `tx` inside the app's own `sql.begin`. On a handle, a store write that needs several
 * statements runs in a savepoint of the app's transaction instead of a transaction of its own, so the
 * auth user, its key, its session and the app's profile row commit or roll back together:
 *
 * ```ts
 * await sql.begin(async (tx) => {
 *   const { user, key } = await createPostgresAuthStore(tx).createUserWithKey(newKey)
 *   await tx`INSERT INTO profiles (user_id, name) VALUES (${user.id}, ${name})`
 *   // Throwing here leaves no auth user, no key and no profile.
 * })
 * ```
 *
 * A write the store refuses (`AuthConflictError`) rolls back only its own savepoint: the app may catch
 * it and still commit the rest. A single-statement method runs on the handle as given, so a statement
 * Postgres rejects aborts the app's transaction, and the row locks a method takes last until the app
 * commits. The store tells a pool from a handle by shape (`begin` or `savepoint`), so no option is
 * needed; a `sql.reserve()` connection has neither and is refused with a `TypeError`.
 *
 * **A key is one way of signing in.** `method` is a free string (`"password"`, `"email-code"`,
 * `"oauth:google"`), so a provider is added by configuration. `subject` identifies the person within
 * the method: the normalised address for password and email code, the provider's own user id for
 * OAuth. The store refuses a second key with the same `(method, subject)`.
 *
 * **A key's address is proven or it is not.** `provenAt` is set once the person showed they receive
 * mail at `email` (a code they typed, or a provider that vouches for the address). At most one user
 * owns a proven address. Proving a key makes its user the owner and, in the same transaction, deletes
 * every other user's unproven key for that address, so someone who registered an address they do not
 * own loses it to the person who proves it. A key created already proven (a code the person typed
 * before signing up, or a provider that vouches for the address) claims the address the same way
 * before it is written, so another user's unproven key with the same method and subject that carries
 * the address does not block it. A key that carries a different address or none still answers
 * `AuthConflictError("key-exists")`, and so does one committed while the proven insert runs; that last
 * case succeeds when retried. Proving an address another user owns is refused with
 * `AuthConflictError("email-owned")`. Deleting a user's last proven key for an address releases the
 * address. `releaseKeyEmail` does the same without deleting the key: it takes the address off the key
 * (both `email` and `provenAt` become null), so a provider identity linked before an address change
 * keeps signing in, by its `subject`, while the old address stops naming the account. An unproven
 * address is dropped too, since the next person to prove it would otherwise delete the key.
 *
 * **Addresses are compared in one form.** `normalizeEmail` is `parseBareAddress` of `@spy4x/email`:
 * it trims, checks the shape (a local part of at most 64 characters, no look-alike such as the Kelvin
 * sign), then lower-cases, so it accepts only what `@spy4x/email` will send to. The store refuses a
 * key whose `email` is not already in that form.
 *
 * **A challenge counts guesses.** `issueChallenge` stores the hash of a code for a
 * `(purpose, subject)`. Asking for a new code replaces the hash and the expiry but keeps the guess
 * counter while the earlier challenge is live, so a new code never buys more guesses.
 * `attemptChallenge` checks one guess and counts it in one statement: parallel guesses queue on the
 * row lock, only the first `maxAttempts` are compared, and a match consumes the challenge. Expired
 * rows are harmless; delete them whenever convenient.
 *
 * ## The tables
 *
 * `AUTH_POSTGRES_SCHEMA` creates `auth_users`, `auth_keys`, `auth_email_owners`, `auth_sessions` and
 * `auth_challenges`. Run it once, as a migration, in the schema the store's client resolves to (set
 * `search_path` to place them in a schema of their own). The database enforces the rules itself:
 *
 * - `UNIQUE (method, subject)` on `auth_keys`;
 * - the address is the primary key of `auth_email_owners`, and a proven key's address and user must
 *   match an owner row, so a key is never proven for an address someone else owns;
 * - every key references its user, and every session references a key of its own user with
 *   `ON DELETE CASCADE`: disconnecting a sign-in method ends the sessions it created.
 *
 * Ids are Postgres `integer`s, so every id fits in a JavaScript number.
 *
 * **A database created before session devices** lacks three columns of `auth_sessions`:
 * `device_name`, `ip_hint` and `last_used_at`. `AUTH_POSTGRES_SCHEMA` creates them on a new database;
 * on an existing one run `AUTH_POSTGRES_SESSION_DEVICES_UPGRADE` once, as a migration:
 *
 * ```ts
 * import { AUTH_POSTGRES_SESSION_DEVICES_UPGRADE } from "@spy4x/server/auth/postgres"
 *
 * await sql.unsafe(AUTH_POSTGRES_SESSION_DEVICES_UPGRADE)
 * ```
 *
 * It adds what is missing and keeps what is there, so it is safe on a table that already has some or
 * all of the columns, and safe to run twice. A session that existed before shows as last used when it
 * was created, with an empty device name. Until it has run, creating a session without a device,
 * validating and signing out work as before; `listForUser`, `touch` and creating a session with a
 * device need the columns.
 *
 * ## What it does not do
 *
 * - **It does not sign anyone in.** The providers decide when to create a user, add a key, prove it or
 *   issue a challenge. The store only keeps the rules that must hold whichever provider runs.
 * - **It does not limit how often a code is asked for.** A challenge that has used up its guesses
 *   stays locked until it expires, and every new code moves the expiry. Put
 *   `@spy4x/platform/rate-limit` in front of the route that sends codes.
 * - **It does not stop an unproven key for an owned address.** A provider that signs people up checks
 *   `findUserIdByProvenEmail` first. The owner's next proof or proven insert deletes such a key.
 * - **It does not release addresses when a user is soft-deleted.** `deletedAt` stops sign-in; the app
 *   deletes the user's keys (or the user row) to release the addresses.
 * - **It does not delete a user who has no keys left.** A user whose last key was evicted or deleted
 *   keeps their user row; the app treats a user with no keys as unable to sign in.
 * - **It does not have an anonymous provider.** Guest accounts were not rebuilt.
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
