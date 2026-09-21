/**
 * The Postgres migration driver against a real server.
 *
 * `postgres-migrate.test.ts` asserts the statements the driver sends. Three of the claims
 * in this module are not about the text but about what the server does with it, and only
 * a real connection answers them:
 *
 *  - two runners started together apply each migration once. Against a fake that is a
 *    call count; against a server it is whether `pg_advisory_lock` on one reserved
 *    connection actually makes the second runner wait;
 *  - a `.no_transaction` migration is the shape the lock has to carry, because its body
 *    and its history row are separate statements and the `UNIQUE` constraint on the name
 *    cannot undo a body that ran twice;
 *  - `ALTER TABLE … ADD COLUMN IF NOT EXISTS checksum` upgrades a history table that was
 *    created before checksums existed, and rows in it read back as `null`.
 *
 * Isolation: every test names its own history table and its own migration-made tables
 * from a random suffix and drops them in a `finally`. They live in the connection's
 * default schema, which is what the driver's unqualified form uses, so nothing shared is
 * touched and nothing is truncated.
 */

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { MigrationEditedError, type MigrationReader, runMigrations } from "./migrate.ts"
import { PostgresMigrationDriver } from "./postgres-migrate.ts"
import { createSql } from "./postgres.ts"
import type { Sql } from "./ports.ts"
import { migrationRace } from "./testing/migration-race.ts"

/** A {@link MigrationReader} over a map of file name to SQL text. */
function memoryReader(files: Record<string, string>): MigrationReader {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    readText: (_folder: string, fileName: string) => {
      const text = files[fileName]
      return text === undefined
        ? Promise.reject(new Error(`no such migration: ${fileName}`))
        : Promise.resolve(text)
    },
  }
}

/** Names this run owns, and a client. Everything named here is dropped afterwards. */
interface Run {
  sql: Sql
  /** The history table, unique to this run. */
  table: string
  /** A table the migrations under test create or write to, unique to this run. */
  subject: string
}

/** Open a client, run `body`, and drop both of this run's tables afterwards. */
async function withRun(body: (run: Run) => Promise<void>): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const table = uniqueIdentifier("it_migrations")
  const subject = uniqueIdentifier("it_subject")
  // The default pool size: `withLock` reserves a connection for the run, and a second
  // runner needs one of its own to wait for the lock on.
  const sql = createSql({ connection: settings.connection, applicationName: table })
  try {
    await sql`SET client_min_messages = warning`
    await body({ sql, table, subject })
  } finally {
    await sql`DROP TABLE IF EXISTS ${sql(subject)}`
    await sql`DROP TABLE IF EXISTS ${sql(table)}`
    await sql.end()
  }
}

describe("the Postgres migration runner against a real server", () => {
  it("applies each migration once when two runners start together", async () => {
    await withRun(async ({ sql, table, subject }) => {
      await sql`CREATE TABLE ${sql(subject)} (id serial PRIMARY KEY)`
      // A `.no_transaction` migration, because it is the case the UNIQUE constraint on
      // the history name cannot rescue: the body and the history row are two statements,
      // so a doubled body is a doubled row in this table and no error anywhere.
      const race = migrationRace({
        "0001_bump.no_transaction.sql": `INSERT INTO ${subject} DEFAULT VALUES`,
      }, 2)
      const options = { folder: "/migrations", reader: race.reader }

      const reports = await Promise.all([
        runMigrations(race.gate(new PostgresMigrationDriver({ sql, table })), options),
        runMigrations(race.gate(new PostgresMigrationDriver({ sql, table })), options),
      ])

      assertEquals(reports.flatMap((report) => report.applied), ["0001_bump"])
      assertEquals(reports.flatMap((report) => report.skipped), ["0001_bump"])
      const rows = await sql<{ id: number }[]>`SELECT id FROM ${sql(subject)} ORDER BY id`
      // Measured on `5c7a40f`: two rows, and one of the two runners then failed on the
      // history table's unique constraint.
      assertStrictEquals(rows.length, 1)
      const history = await new PostgresMigrationDriver({ sql, table }).appliedMigrations()
      assertEquals(history.map((row) => row.name), ["0001_bump"])
    })
  })

  it("refuses to run when an applied migration's file changed afterwards", async () => {
    await withRun(async ({ sql, table, subject }) => {
      const driver = () => new PostgresMigrationDriver({ sql, table })
      const applied = `CREATE TABLE ${subject} (id integer PRIMARY KEY)`
      await runMigrations(driver(), {
        folder: "/migrations",
        reader: memoryReader({ "0001_init.sql": applied }),
      })

      await assertRejects(
        () =>
          runMigrations(driver(), {
            folder: "/migrations",
            reader: memoryReader({ "0001_init.sql": `${applied} -- one more column, later` }),
          }),
        MigrationEditedError,
        "0001_init",
      )

      // Unchanged again, and the run goes through: the check is about the body, not
      // about having ever seen a mismatch.
      const report = await runMigrations(driver(), {
        folder: "/migrations",
        reader: memoryReader({ "0001_init.sql": applied }),
      })
      assertEquals(report, { applied: [], skipped: ["0001_init"] })
    })
  })

  it("adds the checksum column to a history table created without one", async () => {
    await withRun(async ({ sql, table, subject }) => {
      // The shape this driver created before checksums existed, `VARCHAR(100)` included.
      await sql`
        CREATE TABLE ${sql(table)} (
          id         SERIAL PRIMARY KEY,
          name       VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `
      await sql`INSERT INTO ${sql(table)} (name) VALUES (${"0001_init"})`

      const report = await runMigrations(new PostgresMigrationDriver({ sql, table }), {
        folder: "/migrations",
        reader: memoryReader({
          // Edited since it was applied, and skipped all the same: the row carries no
          // checksum, so there is nothing to compare it with.
          "0001_init.sql": "SELECT 'this is not what ran'",
          "0002_add.sql": `CREATE TABLE ${subject} (id integer PRIMARY KEY)`,
        }),
      })

      assertEquals(report, { applied: ["0002_add"], skipped: ["0001_init"] })
      const history = await new PostgresMigrationDriver({ sql, table }).appliedMigrations()
      assertEquals(history.map((row) => row.name), ["0001_init", "0002_add"])
      assertStrictEquals(history[0].checksum, null)
      assertStrictEquals(history[1].checksum?.length, 64)
    })
  })
})
