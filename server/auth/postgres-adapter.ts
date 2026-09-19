/**
 * Postgres adapter.
 *
 * Ported from `roley/auth/adapter.ts`, with two changes:
 *
 *  - the source took `sql` from a sibling module and wrote through the app-wide
 *    `cache` singleton on `updateUser`, which made the adapter the only place a
 *    user row could be evicted from a cache the adapter did not own. The SQL
 *    client is injected here and the adapter touches one store and nothing else;
 *  - the source's row types were `Key`/`Session`/`User` from the domain, so a
 *    `snake_case` column could be read into a `camelCase` field silently. Each
 *    row mapper is explicit below, and a column missing from a table fails at the
 *    query rather than at the first read of `undefined`.

 * The `postgres` driver is already pinned in the root import map (`npm:postgres@3.4.7`);
 * this module adds no dependency. Its tests never reach a database — they run
 * against a fake implementing the same `Adapter` interface, so the SQL here is
 * exercised for types only. That limitation is named in the PR body rather than
 * papered over with a skipped test.
 */

import postgres from "postgres"
import type {
  Adapter,
  Everything,
  Key,
  KeyBase,
  NewKeyLike,
  Session,
  SessionBase,
  User,
  UserBase,
} from "./types.ts"

/** The tag function shape `postgres` exposes, narrowed to what this adapter uses. */
export type Sql = postgres.Sql<Record<string, unknown>>

/** A database row, before it is mapped onto a domain record. */
type Row = Record<string, unknown>

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value)
  }
  throw new TypeError("expected a timestamp column")
}

function toNullableDate(value: unknown): null | Date {
  return value === null || value === undefined ? null : toDate(value)
}

function toNullableString(value: unknown): null | string {
  return typeof value === "string" ? value : null
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "bigint") {
    return Number(value)
  }
  throw new TypeError("expected a numeric column")
}

function mapUser(row: Row): User {
  return {
    id: toNumber(row["id"]),
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
    email: toNullableString(row["email"]),
    firstName: toNullableString(row["first_name"]),
    lastName: toNullableString(row["last_name"]),
    photoUrl: toNullableString(row["photo_url"]),
    permission: row["permission"] === null || row["permission"] === undefined
      ? null
      : toNumber(row["permission"]),
  }
}

function mapKey(row: Row): Key {
  return {
    id: toNumber(row["id"]),
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
    userId: toNumber(row["user_id"]),
    kind: toNumber(row["kind"]) as Key["kind"],
    identification: String(row["identification"]),
    email: toNullableString(row["email"]),
    secret: toNullableString(row["secret"]),
    expiresAt: toNullableDate(row["expires_at"]),
    attempts: row["attempts"] === null || row["attempts"] === undefined
      ? 0
      : toNumber(row["attempts"]),
  }
}

function mapSession(row: Row): Session {
  return {
    id: toNumber(row["id"]),
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
    token: String(row["token"]),
    userId: toNumber(row["user_id"]),
    keyId: toNumber(row["key_id"]),
    expiresAt: toNullableDate(row["expires_at"]),
  }
}

/** Columns each table must have. Exported so a migration can be checked against it. */
export const REQUIRED_COLUMNS = {
  users: [
    "id",
    "created_at",
    "updated_at",
    "email",
    "first_name",
    "last_name",
    "photo_url",
    "permission",
  ],
  keys: [
    "id",
    "created_at",
    "updated_at",
    "user_id",
    "kind",
    "identification",
    "email",
    "secret",
    "expires_at",
    "attempts",
  ],
  sessions: ["id", "created_at", "updated_at", "token", "user_id", "key_id", "expires_at"],
} as const

/**
 * Persistence over three tables: `users`, `keys`, `sessions`.
 *
 * `createUserWithEverything` runs in one transaction, so a failure cannot leave a
 * user row with no credential and no session.
 */
export class PostgresAdapter implements Adapter {
  constructor(private readonly sql: Sql) {}

  async createKey(key: NewKeyLike & Pick<KeyBase, "userId">): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      INSERT INTO keys ${
      this.sql({
        user_id: key.userId,
        kind: key.kind,
        identification: key.identification,
        email: key.email ?? null,
        secret: key.secret ?? null,
        expires_at: key.expiresAt ?? null,
        attempts: key.attempts ?? 0,
      })
    }
      RETURNING *
    `
    return row ? mapKey(row) : null
  }

  async createSession(
    session: Pick<SessionBase, "token" | "userId" | "keyId" | "expiresAt">,
  ): Promise<null | Session> {
    const [row] = await this.sql<Row[]>`
      INSERT INTO sessions ${
      this.sql({
        token: session.token,
        user_id: session.userId,
        key_id: session.keyId,
        expires_at: session.expiresAt ?? null,
      })
    }
      RETURNING *
    `
    return row ? mapSession(row) : null
  }

  async createUser(payload?: Partial<UserBase>): Promise<User> {
    const [row] = await this.sql<Row[]>`
      INSERT INTO users ${
      this.sql({
        email: payload?.email ?? null,
        first_name: payload?.firstName ?? null,
        last_name: payload?.lastName ?? null,
        photo_url: payload?.photoUrl ?? null,
        permission: payload?.permission ?? null,
      })
    }
      RETURNING *
    `
    if (!row) {
      throw new Error("users insert returned no row")
    }
    return mapUser(row)
  }

  createUserWithEverything(
    key: NewKeyLike,
    session: SessionBase,
    user?: Partial<UserBase>,
  ): Promise<Everything> {
    return this.sql.begin(async (tx) => {
      const [userRow] = await tx<Row[]>`
        INSERT INTO users ${
        tx({
          email: user?.email ?? null,
          first_name: user?.firstName ?? null,
          last_name: user?.lastName ?? null,
          photo_url: user?.photoUrl ?? null,
          permission: user?.permission ?? null,
        })
      }
        RETURNING *
      `
      if (!userRow) {
        throw new Error("users insert returned no row")
      }
      const createdUser = mapUser(userRow)
      const [keyRow] = await tx<Row[]>`
        INSERT INTO keys ${
        tx({
          user_id: createdUser.id,
          kind: key.kind,
          identification: key.identification,
          email: key.email ?? null,
          secret: key.secret ?? null,
          expires_at: key.expiresAt ?? null,
          attempts: key.attempts ?? 0,
        })
      }
        RETURNING *
      `
      if (!keyRow) {
        throw new Error("keys insert returned no row")
      }
      const createdKey = mapKey(keyRow)
      const [sessionRow] = await tx<Row[]>`
        INSERT INTO sessions ${
        tx({
          token: session.token,
          user_id: createdUser.id,
          key_id: createdKey.id,
          expires_at: session.expiresAt ?? null,
        })
      }
        RETURNING *
      `
      if (!sessionRow) {
        throw new Error("sessions insert returned no row")
      }
      return { user: createdUser, key: createdKey, session: mapSession(sessionRow) }
    }) as Promise<Everything>
  }

  async updateUser(id: number, update: Partial<UserBase>): Promise<null | User> {
    const [row] = await this.sql<Row[]>`
      UPDATE users SET ${this.sql(columnValues(update, USER_COLUMNS))} WHERE id = ${id} RETURNING *
    `
    return row ? mapUser(row) : null
  }

  async getUser(id: number): Promise<null | User> {
    const [row] = await this.sql<Row[]>`SELECT * FROM users WHERE id = ${id}`
    return row ? mapUser(row) : null
  }

  async getKey(id: number): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`SELECT * FROM keys WHERE id = ${id}`
    return row ? mapKey(row) : null
  }

  async getAllKeys(userId: number): Promise<Key[]> {
    const rows = await this.sql<Row[]>`SELECT * FROM keys WHERE user_id = ${userId} ORDER BY id`
    return rows.map(mapKey)
  }

  async deleteKey(key: Pick<KeyBase, "userId" | "kind">): Promise<boolean> {
    const rows = await this.sql<Row[]>`
      DELETE FROM keys WHERE user_id = ${key.userId} AND kind = ${key.kind} RETURNING id
    `
    return rows.length > 0
  }

  async deleteKeyById(id: number): Promise<void> {
    await this.sql`DELETE FROM keys WHERE id = ${id}`
  }

  async updateKey(id: number, key: Partial<KeyBase>): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      UPDATE keys SET ${this.sql(columnValues(key, KEY_COLUMNS))} WHERE id = ${id} RETURNING *
    `
    return row ? mapKey(row) : null
  }

  async findKeyByIdentification(identification: string): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      SELECT * FROM keys WHERE identification = ${identification} ORDER BY id LIMIT 1
    `
    return row ? mapKey(row) : null
  }

  async findKeyByEmail(email: string): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      SELECT * FROM keys WHERE email = ${email} ORDER BY id LIMIT 1
    `
    return row ? mapKey(row) : null
  }

  async findKeyByKindAndIdentification(
    key: Pick<KeyBase, "kind" | "identification">,
  ): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      SELECT * FROM keys
      WHERE kind = ${key.kind} AND identification = ${key.identification}
      ORDER BY id LIMIT 1
    `
    return row ? mapKey(row) : null
  }

  async findKeyByUserId(key: Pick<KeyBase, "kind" | "userId">): Promise<null | Key> {
    const [row] = await this.sql<Row[]>`
      SELECT * FROM keys WHERE kind = ${key.kind} AND user_id = ${key.userId} ORDER BY id LIMIT 1
    `
    return row ? mapKey(row) : null
  }

  async getSession(id: number): Promise<null | Session> {
    const [row] = await this.sql<Row[]>`SELECT * FROM sessions WHERE id = ${id}`
    return row ? mapSession(row) : null
  }

  async getAllSessions(userId: number): Promise<Session[]> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM sessions WHERE user_id = ${userId} ORDER BY id
    `
    return rows.map(mapSession)
  }

  async updateSession(id: number, session: Partial<SessionBase>): Promise<null | Session> {
    const [row] = await this.sql<Row[]>`
      UPDATE sessions SET ${this.sql(columnValues(session, SESSION_COLUMNS))}
      WHERE id = ${id} RETURNING *
    `
    return row ? mapSession(row) : null
  }

  async deleteSession(id: number): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE id = ${id}`
  }

  async deleteSessionByIdToken(id: number, token: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE id = ${id} AND token = ${token}`
  }

  async deleteAllSessions(userId: number): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE user_id = ${userId}`
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < NOW()`
  }
}

/** Column name per domain field, per table. */
const USER_COLUMNS: Record<string, string> = {
  email: "email",
  firstName: "first_name",
  lastName: "last_name",
  photoUrl: "photo_url",
  permission: "permission",
}

const KEY_COLUMNS: Record<string, string> = {
  userId: "user_id",
  kind: "kind",
  identification: "identification",
  email: "email",
  secret: "secret",
  expiresAt: "expires_at",
  attempts: "attempts",
}

const SESSION_COLUMNS: Record<string, string> = {
  userId: "user_id",
  keyId: "key_id",
  token: "token",
  expiresAt: "expires_at",
}

/**
 * Translate a partial domain update into column values.
 *
 * Only present keys are written, so an update cannot blank a column the caller
 * never mentioned — the source passed the domain object straight to `sql()`,
 * which wrote every key it happened to carry.
 */
function columnValues(
  update: Record<string, unknown>,
  columns: Record<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(columns)) {
    if (field in update) {
      values[column] = update[field]
    }
  }
  if (Object.keys(values).length === 0) {
    throw new Error("update carries no known column")
  }
  return values
}
