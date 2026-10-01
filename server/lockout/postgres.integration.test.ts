/**
 * The Postgres `LockoutStore` against a real server (#315).
 *
 * The contract suite the memory store passes runs here, so the parallel-guess and quiet-reset rules
 * are shown to hold in Postgres too. The tests after it need a real database: a template-shaped
 * table with an integer subject and its own column names, and more parallel guesses than the pool
 * has connections.
 *
 * Isolation: every test creates its own schema from `uniqueIdentifier` and drops it in a `finally`.
 * The pool has ten connections, each with `search_path` set to that schema, so parallel guesses
 * really do arrive on separate connections.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { createLockout, DEFAULT_LOCKOUT_POLICY, type LockoutSubject } from "./mod.ts"
import { createPostgresLockoutStore } from "./postgres.ts"
import { describeLockoutStoreContract, NOW } from "./store-contract.test.ts"

const POOL_SIZE = 10

interface Database {
  sql: Sql
  schema: string
  close(): Promise<void>
}

/** A pool on a fresh schema. `close` ends the pool and drops the schema. */
async function openDatabase(): Promise<Database> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_lockout")
  const admin = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
    onnotice: () => {},
  }) as unknown as Sql
  await admin`CREATE SCHEMA ${admin(schema)}`

  const sql = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: POOL_SIZE }),
    connection: { application_name: schema, search_path: schema },
    onnotice: () => {},
  }) as unknown as Sql

  return {
    sql,
    schema,
    close: async () => {
      try {
        await sql.end()
        await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
      } finally {
        await admin.end()
      }
    },
  }
}

describeLockoutStoreContract("Postgres lockout store", async ({ createMissing }) => {
  const db = await openDatabase()
  try {
    await db.sql`
      CREATE TABLE lockouts (
        subject TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ
      )
    `
  } catch (error) {
    await db.close()
    throw error
  }
  return {
    store: createPostgresLockoutStore({ sql: db.sql, table: "lockouts", createMissing }),
    track: async (subject: LockoutSubject) => {
      await db.sql`INSERT INTO lockouts (subject) VALUES (${subject})`
    },
    read: async (subject: LockoutSubject) => {
      const rows = await db.sql`
        SELECT failed_attempts, locked_until, last_failure_at FROM lockouts
        WHERE subject = ${subject}
      `.values()
      const row = rows[0]
      if (row === undefined) return undefined
      const time = (value: unknown) => value === null ? null : (value as Date).getTime()
      return { failures: row[0] as number, lockedUntil: time(row[1]), lastFailureAt: time(row[2]) }
    },
    close: db.close,
  }
})

describe("Postgres lockout store on a table of its caller's", () => {
  it("counts an integer subject in its own columns, and lets one without a row through", async () => {
    const db = await openDatabase()
    try {
      await db.sql`
        CREATE TABLE user_totp (
          user_id INTEGER PRIMARY KEY,
          secret TEXT NOT NULL,
          wrong_codes INTEGER NOT NULL DEFAULT 0,
          blocked_until TIMESTAMPTZ,
          last_wrong_at TIMESTAMPTZ
        )
      `
      await db.sql`INSERT INTO user_totp (user_id, secret) VALUES (1, 'enrolled')`
      const lockout = createLockout({
        store: createPostgresLockoutStore({
          sql: db.sql,
          schema: db.schema,
          table: "user_totp",
          columns: {
            subject: "user_id",
            failures: "wrong_codes",
            lockedUntil: "blocked_until",
            lastFailureAt: "last_wrong_at",
          },
          createMissing: false,
        }),
        clock: { now: () => NOW },
      })

      for (let index = 0; index <= DEFAULT_LOCKOUT_POLICY.freeFailures; index += 1) {
        expect(await lockout.begin(1)).toBe(0)
        await lockout.fail(1)
      }
      expect(await lockout.begin(1)).toBe(DEFAULT_LOCKOUT_POLICY.firstLockMs)
      expect(await lockout.begin(2)).toBe(0)

      const rows = await db.sql`
        SELECT user_id, wrong_codes, blocked_until FROM user_totp ORDER BY user_id
      `.values()
      expect(rows.map((row) => [row[0], row[1], (row[2] as Date).getTime()])).toEqual([
        [1, DEFAULT_LOCKOUT_POLICY.freeFailures + 1, NOW + DEFAULT_LOCKOUT_POLICY.firstLockMs],
      ])
    } finally {
      await db.close()
    }
  })

  it("runs only the free checks and one more when far more guesses than connections race", async () => {
    const db = await openDatabase()
    try {
      await db
        .sql`CREATE TABLE lockouts (subject TEXT PRIMARY KEY, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, last_failure_at TIMESTAMPTZ)`
      const lockout = createLockout({
        store: createPostgresLockoutStore({ sql: db.sql, table: "lockouts" }),
        clock: { now: () => NOW },
      })
      const waits = await Promise.all(
        Array.from({ length: POOL_SIZE * 5 }, () => lockout.begin("ann@example.com")),
      )
      expect(waits.filter((wait) => wait === 0).length).toBe(
        DEFAULT_LOCKOUT_POLICY.freeFailures + 1,
      )
      const [row] = await db.sql`SELECT failed_attempts FROM lockouts`.values()
      expect(row[0]).toBe(DEFAULT_LOCKOUT_POLICY.freeFailures + 1)
    } finally {
      await db.close()
    }
  })
})
