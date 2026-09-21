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
import postgres from "postgres"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { MigrationEditedError, type MigrationReader, runMigrations } from "./migrate.ts"
import { PostgresMigrationDriver, PostgresMigrationLockError } from "./postgres-migrate.ts"
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
  /** `application_name` of {@link sql}, so this run's backends can be found in the catalogue. */
  applicationName: string
  /** A second client, for looking at the server while the run is going on. */
  observer: Sql
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
  // A separate client, under a name of its own, so a query about the run's backends is
  // never answered about itself.
  const observer = createSql({
    connection: settings.connection,
    max: 1,
    applicationName: `${table}_observer`,
  })
  try {
    await sql`SET client_min_messages = warning`
    await body({ sql, table, subject, applicationName: table, observer })
  } finally {
    await sql`DROP TABLE IF EXISTS ${sql(subject)}`
    await sql`DROP TABLE IF EXISTS ${sql(table)}`
    await sql.end()
    await observer.end()
  }
}

/** The backends of `applicationName` that hold a granted advisory lock, right now. */
async function advisoryLockHolders(observer: Sql, applicationName: string): Promise<number[]> {
  const rows = await observer<{ pid: number }[]>`
    SELECT l.pid
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = ${applicationName}
    ORDER BY l.pid
  `
  return rows.map((row) => row.pid)
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

  it("holds the lock on the very backend the migrations run on, and lets it go", async () => {
    // The design the lock rests on: a *session* lock protects the session it was taken
    // on, so taking it on a pooled connection while the migrations run on the reserved
    // one protects a session nothing uses. Reading the statements alone cannot see that —
    // the reviewer sent lock and unlock through the pool and every assertion stayed green
    // — so this asks the server which backend holds the lock and which backend is running
    // the migration.
    await withRun(async ({ sql, table, subject, applicationName, observer }) => {
      let holdersDuringRun: number[] = []
      const reader: MigrationReader = {
        list: () => Promise.resolve(["0001_pid.sql"]),
        readText: async () => {
          // Called inside the lock, before the migration is applied.
          holdersDuringRun = await advisoryLockHolders(observer, applicationName)
          return `CREATE TABLE ${subject} (pid integer);
                  INSERT INTO ${subject} (pid) SELECT pg_backend_pid()`
        },
      }

      await runMigrations(new PostgresMigrationDriver({ sql, table }), {
        folder: "/migrations",
        reader,
      })

      const rows = await sql<{ pid: number }[]>`SELECT pid FROM ${sql(subject)}`
      assertStrictEquals(rows.length, 1)
      // One lock, and it is held by the backend the migration's own statement ran on.
      assertEquals(holdersDuringRun, [rows[0].pid])
      // And nothing of this run's is still holding one.
      assertEquals(await advisoryLockHolders(observer, applicationName), [])
    })
  })

  it("gives up by name when another runner holds the lock past the bound", async () => {
    // Issue #109. The lock used to be `pg_advisory_lock`, which waits for ever, so one
    // stuck runner stopped every other instance from starting and the deployment hung with
    // nothing in the log. The holder here is a real backend holding a real advisory lock,
    // which is the part a fake cannot show.
    await withRun(async ({ sql, table, applicationName, observer }) => {
      const holder = new PostgresMigrationDriver({ sql, table })
      const blocked = new PostgresMigrationDriver({
        sql,
        table,
        lockWaitMs: 30,
        lockRetryMs: 10,
        // The bound counts the waits, so an injected delay makes this test finish at the
        // speed of three round trips instead of sleeping through it.
        delay: () => Promise.resolve(),
      })

      let lockTaken: () => void = () => {}
      let releaseHolder: () => void = () => {}
      const granted = new Promise<void>((resolve) => {
        lockTaken = resolve
      })
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })

      const first = holder.withLock(() => {
        lockTaken()
        return held
      })
      await granted
      assertStrictEquals((await advisoryLockHolders(observer, applicationName)).length, 1)

      await assertRejects(
        () => blocked.withLock(() => Promise.resolve()),
        PostgresMigrationLockError,
        "30ms",
      )

      releaseHolder()
      await first
      // The runner that gave up took no lock, and the holder let its own go.
      assertEquals(await advisoryLockHolders(observer, applicationName), [])
      // And the lock is free again for a runner that comes along afterwards.
      assertStrictEquals(await blocked.withLock(() => Promise.resolve("ran")), "ran")
    })
  })

  it("makes two runners that spell the same table differently wait for each other", async () => {
    // The lock key follows the table as the server resolves it, not as the caller spelled
    // it. Deriving it from the spelling gave a driver with `schema: "public"` and a driver
    // reaching `public.migrations` through its search path two different keys: they ran at
    // the same time, and one crashed inside Postgres's own catalogue.
    await withRun(async ({ sql, table, subject }) => {
      await sql`CREATE TABLE ${sql(subject)} (id serial PRIMARY KEY)`
      const race = migrationRace({
        "0001_bump.no_transaction.sql": `INSERT INTO ${subject} DEFAULT VALUES`,
      }, 2)
      const options = { folder: "/migrations", reader: race.reader }

      const reports = await Promise.all([
        runMigrations(race.gate(new PostgresMigrationDriver({ sql, table })), options),
        runMigrations(
          race.gate(new PostgresMigrationDriver({ sql, table, schema: "public" })),
          options,
        ),
      ])

      assertEquals(reports.flatMap((report) => report.applied), ["0001_bump"])
      assertEquals(reports.flatMap((report) => report.skipped), ["0001_bump"])
      const rows = await sql<{ id: number }[]>`SELECT id FROM ${sql(subject)}`
      assertStrictEquals(rows.length, 1)
    })
  })

  it("does the same for a history table whose name needs quoting", async () => {
    // `to_regclass` parses its argument as SQL text, so a mixed-case name was folded and
    // found nowhere, and the key fell back to `current_schema()` — which here is a schema
    // the table is *not* in. Measured on the round 2 head, three rounds out of three: two
    // keys, both locks held at once, and the `.no_transaction` body ran twice.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const other = uniqueIdentifier("it_other")
    const table = `${uniqueIdentifier("it")}_MixedHist`
    const subject = uniqueIdentifier("it_subject")
    // `search_path` is a connection setting, and `withLock` reserves a connection of its
    // own, so it goes in the startup parameters rather than a `SET` on one session. Its
    // first schema is deliberately not the one the history table lives in.
    const sql = postgres({
      host: settings.connection.host,
      port: settings.connection.port,
      user: settings.connection.user,
      pass: settings.connection.password,
      db: settings.connection.database,
      connection: { application_name: table, search_path: `${other},public` },
    }) as unknown as Sql

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(other)}`
      await sql`CREATE TABLE public.${sql(subject)} (id serial PRIMARY KEY)`
      // The history table exists before the race and lives in `public`, so there is
      // something for the resolution to find.
      await new PostgresMigrationDriver({ sql, table, schema: "public" }).createHistoryTable()

      const race = migrationRace({
        "0001_bump.no_transaction.sql": `INSERT INTO public.${subject} DEFAULT VALUES`,
      }, 2)
      const options = { folder: "/migrations", reader: race.reader }

      const reports = await Promise.all([
        // Reaches `public.<table>` through the search path, whose first schema is `other`.
        runMigrations(race.gate(new PostgresMigrationDriver({ sql, table })), options),
        runMigrations(
          race.gate(new PostgresMigrationDriver({ sql, table, schema: "public" })),
          options,
        ),
      ])

      assertEquals(reports.flatMap((report) => report.applied), ["0001_bump"])
      assertEquals(reports.flatMap((report) => report.skipped), ["0001_bump"])
      const rows = await sql<{ id: number }[]>`SELECT id FROM public.${sql(subject)}`
      assertStrictEquals(rows.length, 1)
    } finally {
      await sql`DROP TABLE IF EXISTS public.${sql(subject)}`
      await sql`DROP TABLE IF EXISTS public.${sql(table)}`
      await sql`DROP SCHEMA IF EXISTS ${sql(other)} CASCADE`
      await sql.end()
    }
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
      assertEquals(report, { applied: [], skipped: ["0001_init"], missing: [] })
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

      assertEquals(report, { applied: ["0002_add"], skipped: ["0001_init"], missing: [] })
      const history = await new PostgresMigrationDriver({ sql, table }).appliedMigrations()
      assertEquals(history.map((row) => row.name), ["0001_init", "0002_add"])
      assertStrictEquals(history[0].checksum, null)
      assertStrictEquals(history[1].checksum?.length, 64)
    })
  })
})
