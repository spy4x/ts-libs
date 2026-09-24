/**
 * The Postgres `AuthStore` and `SessionStore`, and the tables they need.
 *
 * Written from the rules in issue #57, not moved from the earlier `postgres-adapter.ts`. The
 * database enforces the rules itself, so a bug in a provider cannot break them:
 *
 * - `UNIQUE (method, subject)` on `auth_keys`: one key per sign-in identity.
 * - `auth_email_owners` has the address as its primary key: at most one user owns a proven address.
 *   A proven key's `(proven_email, user_id)` references that table, so a key can only be proven for
 *   an address its own user owns.
 * - `auth_keys.user_id` references `auth_users`: no key without a user.
 * - `auth_sessions (key_id, user_id)` references `auth_keys (id, user_id)` with `ON DELETE CASCADE`:
 *   a session belongs to a key of its own user, and deleting the key ends its sessions.
 *
 * Every query names its tables without a schema, so an app that wants them in a schema of their own
 * sets `search_path` on its connections. Every returned column is aliased to its field name, so the
 * row shape does not depend on a row transform the caller may have configured on its client.
 *
 * @module
 */

import type { Sql, Transaction } from "../db/index.ts"
import { SecondFactorStatus, SessionStatus, type SessionStore } from "../sign-in/mod.ts"
import {
  AuthConflictError,
  type AuthKey,
  type AuthSessionRecord,
  type AuthUser,
  ChallengeOutcome,
  type NewAuthKey,
} from "./model.ts"
import type { AttemptChallengeInput, AuthStore, IssueChallengeInput } from "./store.ts"
import {
  checkAttemptChallenge,
  checkDate,
  checkIssueChallenge,
  checkNewKey,
  checkSecret,
  isStoreId,
  isStoreText,
} from "./input.ts"

/**
 * The tables, constraints and indexes, as SQL text the app runs as a migration.
 *
 * Run it once, in its own migration, on the database or schema the store's `Sql` client resolves
 * to. App tables (a profile, a personal group) reference `auth_users (id)`. An app that writes them
 * in the same transaction as the sign-up hands the store its transaction handle; see
 * {@link createPostgresAuthStore}.
 */
export const AUTH_POSTGRES_SCHEMA = `
CREATE TABLE auth_users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- One row per proven address: the user who owns it. The primary key is the one-owner rule.
CREATE TABLE auth_email_owners (
  email text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  CONSTRAINT auth_email_owners_email_user_key UNIQUE (email, user_id)
);

CREATE INDEX auth_email_owners_user_id_idx ON auth_email_owners (user_id);

CREATE TABLE auth_keys (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  method text NOT NULL,
  subject text NOT NULL,
  email text,
  secret text,
  proven_at timestamptz,
  -- The address, only while the key is proven. Referenced below, so a proven key's address is
  -- always owned by the key's own user.
  proven_email text GENERATED ALWAYS AS (CASE WHEN proven_at IS NULL THEN NULL ELSE email END) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_keys_method_subject_key UNIQUE (method, subject),
  CONSTRAINT auth_keys_id_user_key UNIQUE (id, user_id),
  CONSTRAINT auth_keys_proven_email_owner_fkey FOREIGN KEY (proven_email, user_id)
    REFERENCES auth_email_owners (email, user_id),
  CONSTRAINT auth_keys_method_check CHECK (length(method) BETWEEN 1 AND 64),
  CONSTRAINT auth_keys_subject_check CHECK (length(subject) BETWEEN 1 AND 255),
  CONSTRAINT auth_keys_email_check CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  CONSTRAINT auth_keys_secret_check CHECK (length(secret) BETWEEN 1 AND 1024),
  CONSTRAINT auth_keys_proven_email_check CHECK (proven_at IS NULL OR email IS NOT NULL)
);

CREATE INDEX auth_keys_user_id_idx ON auth_keys (user_id);
CREATE INDEX auth_keys_email_idx ON auth_keys (email) WHERE email IS NOT NULL;

-- Status: 1 = active, 2 = expired, 3 = signed out. Second factor: 1 = not required, 2 = pending,
-- 3 = completed. The values of SessionStatus and SecondFactorStatus in @spy4x/server/sign-in.
CREATE TABLE auth_sessions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL,
  key_id integer NOT NULL,
  token_hash text NOT NULL,
  status smallint NOT NULL,
  second_factor smallint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_key_fkey FOREIGN KEY (key_id, user_id)
    REFERENCES auth_keys (id, user_id) ON DELETE CASCADE,
  CONSTRAINT auth_sessions_status_check CHECK (status IN (1, 2, 3)),
  CONSTRAINT auth_sessions_second_factor_check CHECK (second_factor IN (1, 2, 3))
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_key_id_idx ON auth_sessions (key_id);
CREATE INDEX auth_sessions_active_expires_at_idx ON auth_sessions (expires_at) WHERE status = 1;

-- Guess-counted challenges. Expired rows are harmless and may be deleted at any time:
-- DELETE FROM auth_challenges WHERE expires_at <= now()
CREATE TABLE auth_challenges (
  purpose text NOT NULL,
  subject text NOT NULL,
  secret_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (purpose, subject),
  CONSTRAINT auth_challenges_purpose_check CHECK (length(purpose) BETWEEN 1 AND 64),
  CONSTRAINT auth_challenges_subject_check CHECK (length(subject) BETWEEN 1 AND 255),
  CONSTRAINT auth_challenges_secret_hash_check CHECK (length(secret_hash) BETWEEN 1 AND 1024),
  CONSTRAINT auth_challenges_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX auth_challenges_expires_at_idx ON auth_challenges (expires_at);
`

/** The Postgres error code for a unique violation. */
const UNIQUE_VIOLATION = "23505"

interface UserRow {
  id: number
  createdAt: Date
  deletedAt: Date | null
}

type KeyRow = AuthKey

/**
 * Creates an {@link AuthStore} over the `AUTH_POSTGRES_SCHEMA` tables.
 *
 * `sql` is either a pool or a transaction handle — the `tx` a caller's `sql.begin` passes in, which
 * `postgres` types as a `Sql` already. The store tells them apart by shape, not by an option:
 *
 * - **A pool.** Each write that takes more than one statement (`createUserWithKey`, `addKey`,
 *   `proveKey`, `deleteKey`) runs in a transaction of its own and commits when it returns.
 * - **A transaction handle.** Those writes run in a savepoint of the caller's transaction instead,
 *   because the handle has no `begin`. They commit or roll back with the caller's transaction, so a
 *   sign-up that also writes app rows (a profile, a personal group) is atomic: an error after the
 *   store's write rolls the auth rows back too. A write the store refuses —
 *   `AuthConflictError("key-exists")` or `("email-owned")` — rolls back only its own savepoint, so
 *   the caller may catch it and still commit or roll back the rest of its transaction.
 *
 * Every other method is one statement and runs on the handle as given. Inside a caller's
 * transaction that means two things. A statement Postgres rejects (a foreign key violation, say)
 * leaves the caller's transaction aborted, as any statement the caller ran itself would. And the
 * row locks a method takes — `attemptChallenge` locks the challenge row (`FOR UPDATE`), `addKey`
 * the user row (`FOR KEY SHARE`), and every write the rows it writes — are held until the caller
 * commits, not until the method returns, so keep such a transaction short. The store takes no
 * advisory lock and never calls `reserve`.
 *
 * A reserved connection (`sql.reserve()`) has neither `begin` nor `savepoint`; a multi-statement
 * write through one throws a `TypeError`.
 */
export function createPostgresAuthStore(sql: Sql): AuthStore {
  return new PostgresAuthStore(sql)
}

/**
 * A class rather than an object literal so that it has the same shape as `MemoryAuthStore`: the
 * methods on the prototype, no own enumerable keys. The contract suite checks both.
 */
class PostgresAuthStore implements AuthStore {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async findUser(id: number): Promise<AuthUser | null> {
    if (!isStoreId(id)) return null
    const [row] = await this.#sql<UserRow[]>`
      SELECT ${userColumns(this.#sql)} FROM auth_users WHERE id = ${id}
    `
    return row ? toUser(row) : null
  }

  async createUserWithKey(key: NewAuthKey): Promise<{ user: AuthUser; key: AuthKey }> {
    const input = checkNewKey(key)
    return await inTransaction(this.#sql, async (tx) => {
      const [user] = await tx<UserRow[]>`
        INSERT INTO auth_users DEFAULT VALUES RETURNING ${userColumns(tx)}
      `
      const created = await insertKey(tx, user.id, input)
      return { user: toUser(user), key: created }
    })
  }

  async addKey(userId: number, key: NewAuthKey): Promise<AuthKey> {
    const input = checkNewKey(key)
    if (!isStoreId(userId)) throw new RangeError(`no auth user with id ${userId}`)
    return await inTransaction(this.#sql, async (tx) => {
      // FOR KEY SHARE holds off a concurrent delete of the user until this key is written.
      const [user] = await tx`SELECT id FROM auth_users WHERE id = ${userId} FOR KEY SHARE`
      if (!user) throw new RangeError(`no auth user with id ${userId}`)
      return await insertKey(tx, userId, input)
    })
  }

  async findKey(method: string, subject: string): Promise<AuthKey | null> {
    if (!isStoreText(method) || !isStoreText(subject)) return null
    const [row] = await this.#sql<KeyRow[]>`
      SELECT ${keyColumns(this.#sql)} FROM auth_keys
      WHERE method = ${method} AND subject = ${subject}
    `
    return row ? toKey(row) : null
  }

  async findKeyById(id: number): Promise<AuthKey | null> {
    if (!isStoreId(id)) return null
    const [row] = await this.#sql<KeyRow[]>`
      SELECT ${keyColumns(this.#sql)} FROM auth_keys WHERE id = ${id}
    `
    return row ? toKey(row) : null
  }

  async listKeys(userId: number): Promise<AuthKey[]> {
    if (!isStoreId(userId)) return []
    const rows = await this.#sql<KeyRow[]>`
      SELECT ${keyColumns(this.#sql)} FROM auth_keys WHERE user_id = ${userId} ORDER BY id
    `
    return rows.map(toKey)
  }

  async findUserIdByProvenEmail(email: string): Promise<number | null> {
    if (!isStoreText(email)) return null
    const [row] = await this.#sql<{ userId: number }[]>`
      SELECT user_id AS "userId" FROM auth_email_owners WHERE email = ${email}
    `
    return row ? row.userId : null
  }

  async proveKey(keyId: number, now: Date): Promise<AuthKey> {
    checkDate(now, "now")
    if (!isStoreId(keyId)) throw new RangeError(`no auth key with id ${keyId}`)
    return await inTransaction(this.#sql, async (tx) => {
      // Not locked here on purpose. Two users proving one address at once would otherwise each hold
      // their own key's lock while waiting for the other's owner row, and deadlock: the winner's
      // claim deletes the loser's unproven key. The owner row's lock alone orders them.
      const [key] = await tx<{ userId: number; email: string | null }[]>`
        SELECT user_id AS "userId", email FROM auth_keys WHERE id = ${keyId}
      `
      if (!key) throw new RangeError(`no auth key with id ${keyId}`)
      if (key.email === null) throw new TypeError("a key with no email cannot be proven")
      await claimAddress(tx, key.userId, key.email)
      // An already proven key keeps the time it was first proven.
      const [row] = await tx<KeyRow[]>`
        UPDATE auth_keys SET proven_at = COALESCE(proven_at, ${now}), updated_at = ${now}
        WHERE id = ${keyId}
        RETURNING ${keyColumns(tx)}
      `
      // Deleted by a concurrent deleteKey between the read and the update.
      if (!row) throw new RangeError(`no auth key with id ${keyId}`)
      return toKey(row)
    })
  }

  async updateKeySecret(keyId: number, secret: string): Promise<boolean> {
    checkSecret(secret)
    if (!isStoreId(keyId)) return false
    const rows = await this.#sql`
      UPDATE auth_keys SET secret = ${secret}, updated_at = now() WHERE id = ${keyId} RETURNING id
    `
    return rows.length === 1
  }

  async deleteKey(userId: number, keyId: number): Promise<boolean> {
    if (!isStoreId(userId) || !isStoreId(keyId)) return false
    return await inTransaction(this.#sql, async (tx) => {
      const [deleted] = await tx<{ provenEmail: string | null }[]>`
        DELETE FROM auth_keys WHERE id = ${keyId} AND user_id = ${userId}
        RETURNING proven_email AS "provenEmail"
      `
      if (!deleted) return false
      if (deleted.provenEmail !== null) {
        // The user stops owning the address once none of their keys carries it proven.
        await tx`
          DELETE FROM auth_email_owners
          WHERE email = ${deleted.provenEmail} AND user_id = ${userId}
            AND NOT EXISTS (
              SELECT 1 FROM auth_keys
              WHERE user_id = ${userId} AND proven_email = ${deleted.provenEmail}
            )
        `
      }
      return true
    })
  }

  async issueChallenge(input: IssueChallengeInput): Promise<void> {
    const { purpose, subject, secretHash, expiresAt, now } = checkIssueChallenge(input)
    await this.#sql`
      INSERT INTO auth_challenges AS c (purpose, subject, secret_hash, attempts, expires_at)
      VALUES (${purpose}, ${subject}, ${secretHash}, 0, ${expiresAt})
      ON CONFLICT (purpose, subject) DO UPDATE SET
        secret_hash = EXCLUDED.secret_hash,
        expires_at = EXCLUDED.expires_at,
        attempts = CASE WHEN c.expires_at > ${now} THEN c.attempts ELSE 0 END
    `
  }

  /**
   * One statement. `target` locks the challenge row (`FOR UPDATE`), so parallel guesses at the same
   * challenge queue on that lock; each one then sees the counter the previous one left, and only the
   * first `maxAttempts` are compared. A match deletes the row and a miss increments its counter, in
   * two branches with opposite conditions, so no statement touches the row twice.
   *
   * The comparison runs in SQL with `=`. That is not a timing leak: both sides are hashes of a code,
   * and how long it takes to compare two hashes says nothing about the code.
   */
  async attemptChallenge(input: AttemptChallengeInput): Promise<ChallengeOutcome> {
    const { purpose, subject, secretHash, maxAttempts, now } = checkAttemptChallenge(input)
    const [row] = await this.#sql<
      { live: boolean | null; open: boolean | null; consumed: boolean; counted: boolean }[]
    >`
      WITH target AS (
        SELECT purpose, subject,
          expires_at > ${now} AS live,
          attempts < ${maxAttempts} AS open,
          secret_hash = ${secretHash} AS matched
        FROM auth_challenges
        WHERE purpose = ${purpose} AND subject = ${subject}
        FOR UPDATE
      ),
      consumed AS (
        DELETE FROM auth_challenges AS c USING target AS t
        WHERE c.purpose = t.purpose AND c.subject = t.subject AND t.live AND t.open AND t.matched
        RETURNING 1
      ),
      counted AS (
        UPDATE auth_challenges AS c SET attempts = c.attempts + 1
        FROM target AS t
        WHERE c.purpose = t.purpose AND c.subject = t.subject
          AND t.live AND t.open AND NOT t.matched
        RETURNING 1
      )
      SELECT
        (SELECT live FROM target) AS live,
        (SELECT open FROM target) AS open,
        EXISTS (SELECT 1 FROM consumed) AS consumed,
        EXISTS (SELECT 1 FROM counted) AS counted
    `
    if (row.live !== true) return ChallengeOutcome.Missing
    if (row.open !== true) return ChallengeOutcome.LockedOut
    if (row.consumed) return ChallengeOutcome.Matched
    if (row.counted) return ChallengeOutcome.WrongGuess
    throw new Error("attemptChallenge: a live, open challenge was neither consumed nor counted")
  }
}

/**
 * Creates a `SessionStore` over the `auth_sessions` table of `AUTH_POSTGRES_SCHEMA`.
 *
 * `sql` is a pool or a transaction handle (the `tx` a caller's `sql.begin` passes in). Every method
 * is one statement and opens no transaction of its own, so on a transaction handle a session is
 * written, and rolled back, with the caller's transaction. A statement Postgres rejects (a session
 * whose key belongs to another user) leaves the caller's transaction aborted, as any statement the
 * caller ran itself would; a session the store refuses before asking Postgres (an id no store could
 * assign) does not.
 *
 * It implements every optional `SessionStore` method, including `clearPendingSecondFactors`, and
 * its return type says so, so a caller can clear pending second factors through the store it built
 * on its own transaction handle.
 */
export function createPostgresSessionStore(sql: Sql): Required<SessionStore<AuthSessionRecord>> {
  return {
    async create(session: Omit<AuthSessionRecord, "id">): Promise<AuthSessionRecord> {
      if (!isStoreId(session.userId) || !isStoreId(session.keyId)) {
        throw new TypeError("a session needs a userId and a keyId the auth store could assign")
      }
      checkDate(session.expiresAt, "expiresAt")
      const [row] = await sql<AuthSessionRecord[]>`
        INSERT INTO auth_sessions (user_id, key_id, token_hash, status, second_factor, expires_at)
        VALUES (
          ${session.userId}, ${session.keyId}, ${session.tokenHash}, ${session.status},
          ${session.secondFactor}, ${session.expiresAt}
        )
        RETURNING ${sessionColumns(sql)}
      `
      return toSession(row)
    },
    async findById(id: number): Promise<AuthSessionRecord | null> {
      if (!isStoreId(id)) return null
      const [row] = await sql<AuthSessionRecord[]>`
        SELECT ${sessionColumns(sql)} FROM auth_sessions WHERE id = ${id}
      `
      return row ? toSession(row) : null
    },
    async extend(id: number, expiresAt: Date): Promise<boolean> {
      checkDate(expiresAt, "expiresAt")
      if (!isStoreId(id)) return false
      const rows = await sql`
        UPDATE auth_sessions SET expires_at = ${expiresAt}
        WHERE id = ${id} AND status = ${SessionStatus.Active}
        RETURNING id
      `
      return rows.length === 1
    },
    async completeSecondFactor(id: number): Promise<boolean> {
      if (!isStoreId(id)) return false
      const rows = await sql`
        UPDATE auth_sessions SET second_factor = ${SecondFactorStatus.Completed}
        WHERE id = ${id} AND status = ${SessionStatus.Active}
        RETURNING id
      `
      return rows.length === 1
    },
    async clearPendingSecondFactors(userId: number): Promise<void> {
      if (!isStoreId(userId)) return
      await sql`
        UPDATE auth_sessions SET second_factor = ${SecondFactorStatus.NotRequired}
        WHERE user_id = ${userId} AND status = ${SessionStatus.Active}
          AND second_factor = ${SecondFactorStatus.Pending}
      `
    },
    async signOut(id: number): Promise<void> {
      if (!isStoreId(id)) return
      await sql`
        UPDATE auth_sessions SET status = ${SessionStatus.SignedOut}
        WHERE id = ${id} AND status = ${SessionStatus.Active}
      `
    },
    // An `exceptId` no store could have assigned matches no session, so nothing is kept.
    async signOutUser(userId: number, exceptId: number | null): Promise<void> {
      if (!isStoreId(userId)) return
      await sql`
        UPDATE auth_sessions SET status = ${SessionStatus.SignedOut}
        WHERE user_id = ${userId} AND status = ${SessionStatus.Active}
        ${isStoreId(exceptId) ? sql`AND id <> ${exceptId}` : sql``}
      `
    },
    async expire(now: Date): Promise<void> {
      checkDate(now, "now")
      await sql`
        UPDATE auth_sessions SET status = ${SessionStatus.Expired}
        WHERE status = ${SessionStatus.Active} AND expires_at <= ${now}
      `
    },
  } satisfies SessionStore<AuthSessionRecord>
}

/**
 * Runs `body` in a transaction of its own and turns a unique violation on `(method, subject)` into
 * `AuthConflictError("key-exists")`. Anything `body` throws rolls that transaction back.
 *
 * Which transaction depends on the handle the store was given, detected from its shape
 * (`postgres@3.4.7`):
 *
 * - A pool (`postgres(...)`, `createSql`) has `begin`: `body` runs in a new transaction on one
 *   connection, and commits when it returns.
 * - A transaction handle (the `tx` inside the caller's `sql.begin`, or a savepoint's handle) has
 *   `savepoint` and no `begin`: `body` runs in a savepoint of the caller's transaction. Its writes
 *   commit or roll back with the caller's transaction. When `body` throws — a refused write such as
 *   `AuthConflictError`, or a failed statement — only the savepoint rolls back, so the caller can
 *   catch the error and keep using its transaction, which Postgres would otherwise refuse.
 * - A reserved connection (`sql.reserve()`) has neither, and is refused with a `TypeError` rather
 *   than written through without a transaction.
 */
async function inTransaction<T>(sql: Sql, body: (tx: Sql) => Promise<T>): Promise<T> {
  try {
    return await runIsolated(sql, body)
  } catch (error) {
    if (isUniqueViolation(error, "auth_keys_method_subject_key")) {
      throw new AuthConflictError("key-exists")
    }
    throw error
  }
}

/** The transaction or savepoint half of {@link inTransaction}. */
async function runIsolated<T>(sql: Sql, body: (tx: Sql) => Promise<T>): Promise<T> {
  if (typeof (sql as { begin?: unknown }).begin === "function") {
    return (await sql.begin((tx) => body(tx))) as T
  }
  const handle = sql as Partial<Transaction>
  if (typeof handle.savepoint === "function") {
    return (await handle.savepoint((tx) => body(tx))) as T
  }
  throw new TypeError(
    "the Postgres auth store needs a pool or a transaction handle; this handle has neither " +
      "`begin` nor `savepoint` (a `sql.reserve()` connection has neither)",
  )
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false
  const { code, constraint_name } = error as { code?: unknown; constraint_name?: unknown }
  return code === UNIQUE_VIOLATION && constraint_name === constraint
}

/**
 * Inserts a key. A proven key first claims its address for `userId`, which deletes every other
 * user's unproven key carrying the address — including one with this key's (method, subject), so a
 * pre-registered claim cannot block the person who proved the address. A (method, subject) still
 * taken after that (a proven key, or a key of the same user) is `key-exists`, and the whole
 * transaction, the claim included, rolls back.
 */
async function insertKey(tx: Sql, userId: number, input: NewAuthKey): Promise<AuthKey> {
  if (input.provenAt !== null && input.email !== null) await claimAddress(tx, userId, input.email)
  const [row] = await tx<KeyRow[]>`
    INSERT INTO auth_keys (user_id, method, subject, email, secret, proven_at)
    VALUES (${userId}, ${input.method}, ${input.subject}, ${input.email}, ${input.secret},
      ${input.provenAt})
    RETURNING ${keyColumns(tx)}
  `
  return toKey(row)
}

/**
 * Makes `userId` the owner of `email`, or throws `AuthConflictError("email-owned")` when another
 * user owns it, and deletes every other user's unproven key that carries the address.
 *
 * The upsert takes the owner row's lock, so two users proving the same address at once are
 * serialised: the second one waits, then sees the first as the owner.
 */
async function claimAddress(tx: Sql, userId: number, email: string): Promise<void> {
  const [owner] = await tx<{ userId: number }[]>`
    INSERT INTO auth_email_owners (email, user_id) VALUES (${email}, ${userId})
    ON CONFLICT (email) DO UPDATE SET user_id = auth_email_owners.user_id
    RETURNING user_id AS "userId"
  `
  if (owner.userId !== userId) throw new AuthConflictError("email-owned")
  await tx`
    DELETE FROM auth_keys WHERE email = ${email} AND user_id <> ${userId} AND proven_at IS NULL
  `
}

function userColumns(sql: Sql) {
  return sql`id, created_at AS "createdAt", deleted_at AS "deletedAt"`
}

function keyColumns(sql: Sql) {
  return sql`
    id, user_id AS "userId", method, subject, email, secret, proven_at AS "provenAt",
    created_at AS "createdAt", updated_at AS "updatedAt"
  `
}

function sessionColumns(sql: Sql) {
  return sql`
    id, user_id AS "userId", key_id AS "keyId", token_hash AS "tokenHash", status,
    second_factor AS "secondFactor", expires_at AS "expiresAt"
  `
}

function toUser(row: UserRow): AuthUser {
  return { id: row.id, createdAt: row.createdAt, deletedAt: row.deletedAt }
}

function toKey(row: KeyRow): AuthKey {
  return {
    id: row.id,
    userId: row.userId,
    method: row.method,
    subject: row.subject,
    email: row.email,
    secret: row.secret,
    provenAt: row.provenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSession(row: AuthSessionRecord): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    keyId: row.keyId,
    tokenHash: row.tokenHash,
    status: row.status,
    secondFactor: row.secondFactor,
    expiresAt: row.expiresAt,
  }
}
