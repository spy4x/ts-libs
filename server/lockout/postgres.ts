/**
 * The Postgres {@link LockoutStore}, over a table and columns the caller names. Every server
 * instance sharing the database sees the same counters, and they survive a restart.
 *
 * A dedicated table looks like this; an existing table, such as one row per enrolled secret, only
 * needs the four columns:
 *
 * ```sql
 * CREATE TABLE lockouts (
 *   subject         TEXT PRIMARY KEY,
 *   failed_attempts INTEGER NOT NULL DEFAULT 0,
 *   locked_until    TIMESTAMPTZ,
 *   last_failure_at TIMESTAMPTZ
 * );
 * ```
 *
 * The subject column must be unique. With `createMissing` (the default) an unknown subject's row is
 * inserted with `ON CONFLICT DO NOTHING`, which needs that unique index, and any other column of the
 * table must have a default. With `createMissing: false` a subject without a row has nothing to
 * guess: `begin` lets it through and writes nothing.
 *
 * Rows are never deleted: with `createMissing` every new subject adds one, so an endpoint keyed by
 * something a stranger chooses, such as an e-mail address, grows the table by one row per address.
 * A row whose quiet reset has passed and whose lock has ended decides nothing any more, and a row
 * whose last failure time is `NULL` was never counted by `begin`, so both can be deleted. One
 * exception: a delete that commits while a `begin` for that subject is running lets that one check
 * through uncounted, on a row that had been quiet for the whole reset period anyway. On a table
 * that holds only counters, with the default policy and columns, run on a schedule:
 *
 * ```sql
 * DELETE FROM lockouts
 * WHERE (last_failure_at IS NULL OR last_failure_at < now() - interval '7 days')
 *   AND (locked_until IS NULL OR locked_until < now())
 * ```
 *
 * On a table that holds something else, such as enrolled secrets, never delete the row: the
 * counter goes with it when the secret does.
 *
 * Table, schema and column names are validated as lower-case identifiers and sent through the
 * driver's identifier quoting, never spliced into the SQL text. One that the client's own column
 * transform (such as `postgres.camel`) would rewrite is refused too: rows are read positionally, so
 * a transform cannot rename what is read, but it would rename what is written.
 *
 * @module
 */

import { type } from "arktype"
import type { Sql } from "../db/index.ts"
import { expectRowShape, identifierRewrittenBy } from "../db/postgres-migrate.ts"
import type { LockoutState, LockoutStore } from "./mod.ts"

/** The column names the store reads and writes. */
export interface LockoutColumns {
  /** The caller's key: its type is the caller's, any type a string or number binds to. */
  subject: string
  /** An integer count. */
  failures: string
  /** A nullable `timestamptz`. */
  lockedUntil: string
  /** A nullable `timestamptz`. */
  lastFailureAt: string
}

/** `subject`, `failed_attempts`, `locked_until`, `last_failure_at`. */
export const DEFAULT_LOCKOUT_COLUMNS: Readonly<LockoutColumns> = Object.freeze({
  subject: "subject",
  failures: "failed_attempts",
  lockedUntil: "locked_until",
  lastFailureAt: "last_failure_at",
})

/** Options for {@link createPostgresLockoutStore}. */
export interface PostgresLockoutStoreOptions {
  /** A pool client: each update runs in its own `sql.begin` transaction. */
  sql: Sql
  /** The table holding the counters. */
  table: string
  /** The table's schema. Defaults to the connection's `search_path`. */
  schema?: string
  /** Column names; each defaults to {@link DEFAULT_LOCKOUT_COLUMNS}. */
  columns?: Partial<LockoutColumns>
  /** Insert a zero row for an unknown subject. Defaults to `true`. */
  createMissing?: boolean
}

const identifier = type(/^[a-z_][a-z0-9_]{0,62}$/)

function checkIdentifier(sql: Sql, role: string, name: string): string {
  const out = identifier(name)
  if (out instanceof type.errors) {
    throw new TypeError(
      `lockout ${role} name ${JSON.stringify(name)} must be a lower-case identifier of 1 to 63 ` +
        `characters: letters, digits and underscores, not starting with a digit`,
    )
  }
  const rewritten = identifierRewrittenBy(sql, name)
  if (rewritten !== undefined) {
    throw new TypeError(
      `this client's transform.column.to would send the lockout ${role} name ` +
        `${JSON.stringify(name)} as ${JSON.stringify(rewritten)}; use a client without it`,
    )
  }
  return name
}

function readCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`lockout failure count ${JSON.stringify(value)} is not a count`)
  }
  return count
}

function readTime(value: unknown): number | null {
  if (value === null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime()
  throw new TypeError(`lockout time ${String(value)} is not a timestamptz value`)
}

function toDate(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms)
}

/**
 * Builds the store. Throws a `TypeError` for a table, schema or column name that is not a plain
 * lower-case identifier, or that the client's column transform would rewrite.
 */
export function createPostgresLockoutStore(options: PostgresLockoutStoreOptions): LockoutStore {
  const { sql, createMissing = true } = options
  const columns = { ...DEFAULT_LOCKOUT_COLUMNS, ...options.columns }
  const table = checkIdentifier(sql, "table", options.table)
  const schema = options.schema === undefined
    ? undefined
    : checkIdentifier(sql, "schema", options.schema)
  const target = sql(schema === undefined ? table : `${schema}.${table}`)
  const subjectColumn = sql(checkIdentifier(sql, "subject column", columns.subject))
  const failures = sql(checkIdentifier(sql, "failures column", columns.failures))
  const lockedUntil = sql(checkIdentifier(sql, "lockedUntil column", columns.lockedUntil))
  const lastFailureAt = sql(checkIdentifier(sql, "lastFailureAt column", columns.lastFailureAt))

  return {
    update: async (subject, change) => {
      await sql.begin(async (tx) => {
        if (createMissing) {
          await tx`
            INSERT INTO ${target} (${subjectColumn}, ${failures}) VALUES (${subject}, 0)
            ON CONFLICT (${subjectColumn}) DO NOTHING
          `
        }
        const rows = await tx`
          SELECT ${failures}, ${lockedUntil}, ${lastFailureAt} FROM ${target}
          WHERE ${subjectColumn} = ${subject} FOR UPDATE
        `.values()
        let current: LockoutState | undefined
        if (rows[0] !== undefined) {
          const row = expectRowShape("lockout state", rows[0], 3)
          current = {
            failures: readCount(row[0]),
            lockedUntil: readTime(row[1]),
            lastFailureAt: readTime(row[2]),
          }
        }
        const next = change(current)
        if (next === undefined) return
        await tx`
          UPDATE ${target}
          SET ${failures} = ${next.failures},
              ${lockedUntil} = ${toDate(next.lockedUntil)},
              ${lastFailureAt} = ${toDate(next.lastFailureAt)}
          WHERE ${subjectColumn} = ${subject}
        `
      })
    },
  }
}
