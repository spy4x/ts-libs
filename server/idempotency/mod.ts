/**
 * `@spy4x/server/idempotency` — commands that are safe to send twice: a CQRS middleware that
 * replays the stored result of a command retried with the same key, and the stores behind it.
 * Extracted from `template/libs/server/idempotency/` (#313).
 *
 * `createIdempotencyMiddleware`, `fingerprint`, `isIdempotencyKey`, `IdempotencyError`,
 * `IdempotencyStore`, `PostgresIdempotencyStore`, `IDEMPOTENCY_POSTGRES_SCHEMA`,
 * `IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT`, `IDEMPOTENCY_POSTGRES_USER_ID_TEXT`, `IdempotencyUserId`,
 * `MemoryIdempotencyStore`, `IDEMPOTENCY_LEASE_SECONDS`, `IDEMPOTENCY_RETENTION_DAYS`. Extracted from
 * `template/libs/server/idempotency/` (#313).
 *
 * A command whose data carries an `idempotencyKey` and an `actor.userId` runs once per (user, key).
 * The user id is a number or a non-empty string, such as a version 7 UUID.
 * A repeat returns the first run's result as JSON and changes nothing. Register the middleware on the
 * `CommandBus` from `@spy4x/platform/cqrs`:
 *
 * ```ts
 * bus.use(createIdempotencyMiddleware({ store: new PostgresIdempotencyStore(sql) }))
 * ```
 *
 * - A command without a key passes through.
 * - A repeat that arrives while the first run is in flight waits (`waitMs`, default 8 s, polling every
 *   `pollMs`, default 100 ms), then fails with `IdempotencyError` code `IN_PROGRESS`. It never runs
 *   the command beside the first.
 * - The same key with a different command name or different input fails with `KEY_REUSED`; a malformed
 *   key (1 to 128 printable ASCII characters) or one without a signed-in user fails with
 *   `INVALID_KEY`. The input is fingerprinted by SHA-256 over the sorted-key JSON of the data, minus
 *   `actor`, `idempotencyKey`, a `requestId` that is a string or `null`, and a `request` shaped like
 *   a `RequestInfo` (only `requestId`, `ip` and `userAgent`, each a string or unset). A `request` or
 *   `requestId` of any other shape is the command's own input and counts. Do not give a command's
 *   own string input the name `requestId`: two sends that differ only there share a fingerprint.
 * - A run that throws releases its claim, so the retry runs again.
 *
 * **Options.** Both stores take `leaseSeconds` (default 30: how long an unfinished claim holds before
 * a retry may take it over, so set it above your slowest command) and `retentionDays` (default 7: how
 * long the longest-offline client may still retry). `MemoryIdempotencyStore` also takes `now`. The
 * Postgres store compares against the database clock. Call `store.sweep()` from a periodic job to
 * delete expired rows; `begin` also forgets an expired row for its own key. The retention counts from
 * the claim, or from the last takeover of a dead run's claim, so a retry that took over a claim keeps
 * it, and its result, for the full retention.
 *
 * **The table.** `IDEMPOTENCY_POSTGRES_SCHEMA` is the SQL for `idempotency_keys`; run it as one of
 * your migrations. It has no foreign key on `user_id`, because this library does not own your users
 * table; add `REFERENCES users (id) ON DELETE CASCADE` if you want rows to go with the user.
 * `user_id` is an `integer`. An app whose user ids are strings also runs
 * `IDEMPOTENCY_POSTGRES_USER_ID_TEXT`, which widens it to `text`, before it opens the store's pool.
 *
 * **Fencing.** `begin` returns `{ status: "claimed", token }`; `complete` and `release` take that token
 * and change nothing when it is not the key's current one. A run that outlives its lease and loses its
 * claim to a retry therefore can neither free the new owner's claim nor store its own result over it.
 * The token is a version 7 UUID from `uuidV7()` of `@spy4x/platform/universal/uuid`. It never leaves
 * the server. Treat it as an opaque string.
 *
 * **Upgrading from 1.64.0 or earlier.** Nothing to migrate. `claim_token` is a `uuid` column, as it
 * was until 1.63.0, and the store works on a `text` column too.
 *
 * - Release 1.64.0 made the token a random string that did not fit a `uuid` column, so that one
 *   release needed `IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT`, a migration that widens the column to
 *   `text`. Since 1.64.1 the token is a UUID again and no app needs the migration.
 * - An app that ran the migration keeps working on its `text` column, with no second migration. A
 *   claim made by 1.64.0 that is still in the table is completed or released by its own token, and
 *   taken over after its lease, like any other.
 * - An app still on a `uuid` column needs nothing. Skip 1.64.0 and take 1.64.1 or later.
 *
 * `IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT` stays exported and unchanged, marked deprecated, so an app
 * that lists it among its migrations still builds.
 *
 * **What it does not do.** The claim and the command are not one transaction. A process that dies
 * after the command committed and before its result was stored leaves a claim that expires after the
 * lease, and a retry then runs the command again. So does a run that outlives its lease: the retry
 * takes the claim over and runs the command a second time (at most one extra run per expired lease).
 * Keep the lease above your slowest command. If the store fails after the command ran, the caller
 * still gets the command's result and the failure goes to `onStoreFailure`.
 *
 * **Input rules.** The fingerprint counts a value with `toJSON` (a `Date`) as what it returns, leaves
 * out `undefined` properties like `JSON.stringify`, and throws a `TypeError` for a `Map`, `Set` or
 * other non-plain object without `toJSON`, because it would hash like `{}`. A command class name over
 * 100 characters fails with `INVALID_COMMAND`. `leaseSeconds` and `retentionDays` must be finite and
 * above zero, or the constructor throws a `RangeError`.
 *
 * @module
 */
export {
  type BeginOutcome,
  createIdempotencyMiddleware,
  fingerprint,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  IdempotencyError,
  type IdempotencyErrorCode,
  type IdempotencyOptions,
  type IdempotencyStore,
  type IdempotencyUserId,
  isIdempotencyKey,
  MAX_IDEMPOTENCY_COMMAND_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./idempotency.ts"
export { MemoryIdempotencyStore, type MemoryIdempotencyStoreOptions } from "./memory.ts"
export {
  IDEMPOTENCY_POSTGRES_CLAIM_TOKEN_TEXT,
  IDEMPOTENCY_POSTGRES_SCHEMA,
  IDEMPOTENCY_POSTGRES_USER_ID_TEXT,
  PostgresIdempotencyStore,
  type PostgresIdempotencyStoreOptions,
} from "./postgres.ts"
