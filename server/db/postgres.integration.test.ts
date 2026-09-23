/**
 * The Postgres smoke test of the integration tier (#74).
 *
 * `server/db/postgres.test.ts` asserts the options object the driver is handed and
 * says so in its own header: "the claim that they reach the wire is the one thing
 * here a reviewer should treat as untested". This is the test that opens the socket.
 * It stays a round trip — create, insert, select — because its job is to prove the
 * tier works end to end, not to test the driver.
 *
 * Isolation: every run creates its own schema, named from a random suffix, and drops
 * it in a `finally`. Two runs against the same container never see each other's
 * tables.
 */

import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { createSql } from "./postgres.ts"

describe("postgres against a real server", () => {
  it("writes a row in its own schema and reads it back", async () => {
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_db")
    // One connection, so the `client_min_messages` below holds for every statement
    // this test sends: `DROP SCHEMA … CASCADE` is otherwise a page of NOTICE output.
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.note (id integer PRIMARY KEY, body text NOT NULL)`
      await sql`INSERT INTO ${sql(schema)}.note (id, body) VALUES (1, ${"written over a socket"})`

      const rows = await sql`SELECT id, body FROM ${sql(schema)}.note ORDER BY id`
      assertEquals(rows.map((row) => ({ id: row.id, body: row.body })), [
        { id: 1, body: "written over a socket" },
      ])
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})

/**
 * The message every pinning test below throws if the deferred-constraint write it expects to
 * silently succeed ever rejects instead — which is what postgres.js correctly reporting the
 * failure would look like from here.
 */
const UPSTREAM_FIXED_MESSAGE = "postgres.js now reports this (porsager/postgres#1117): remove " +
  "the #134 paragraph in createSql/README and this test"

/**
 * Await `promise`, expecting it to resolve the way the pinned driver's bug makes it resolve —
 * a "successful" write that is not actually there. If it rejects instead, that is what an
 * upstream fix looks like from here: convert the rejection into {@link UPSTREAM_FIXED_MESSAGE}
 * rather than let a reader debug a bare assertion failure with no idea the bug this test pins
 * is the reason.
 */
async function expectDriverStillLosesWrite<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (cause) {
    throw new Error(UPSTREAM_FIXED_MESSAGE, { cause })
  }
}

describe("postgres@3.4.7 against a real server — a deferred constraint at implicit commit (#134)", () => {
  // Pinned driver behaviour, not a bug this package can fix: a single statement through the
  // extended-protocol path — a tagged template, or `sql.unsafe(text, params)` with a
  // parameters argument — resolves from the server's `CommandComplete`
  // (`postgres@3.4.7/src/connection.js:568`), which arrives *before* the implicit commit that
  // actually checks a `DEFERRABLE INITIALLY DEFERRED` constraint. When that commit then fails,
  // the `ErrorResponse` it carries arrives on a query the driver has already resolved and
  // cleared (`:792`), so it has nothing left to reject — no thrown error, no
  // `unhandledrejection`, just a resolved promise reporting a write that is not there. Only a
  // *parameterless* `sql.unsafe(text)` and any statement inside `sql.begin` take the
  // simple-protocol path, which resolves after the server's own commit and so does report the
  // failure — which is why `server/db`'s prose says `sql.begin` is the one path that is always
  // safe. Reported upstream: https://github.com/porsager/postgres/issues/1117 (reproduction:
  // https://github.com/porsager/postgres/issues/1117#issuecomment-5795651028). These tests are
  // the trip wire for an upgrade that fixes it — a version where one of them fails with
  // `UPSTREAM_FIXED_MESSAGE` is the version where the `server/db` prose and `createSql`'s
  // JSDoc can lose the paragraph naming it.

  it("resolves a single tagged-template insert a deferred constraint rejected at commit, and loses the row", async () => {
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_db_deferred")
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.p (id int PRIMARY KEY)`
      await sql`
        CREATE TABLE ${sql(schema)}.c (
          id int PRIMARY KEY,
          p  int REFERENCES ${sql(schema)}.p (id) DEFERRABLE INITIALLY DEFERRED
        )
      `

      // No parent row 9 exists, so the deferred foreign-key check fails at the implicit
      // commit — after this promise has already resolved as a success.
      const result = await expectDriverStillLosesWrite(
        sql`INSERT INTO ${sql(schema)}.c (id, p) VALUES (1, 9) RETURNING id`,
      )
      assertEquals(result.count, 1)
      assertEquals(result.length, 1)

      // The row the driver just reported as written is not in the table.
      const rows = await sql`SELECT id FROM ${sql(schema)}.c`
      assertEquals(rows.length, 0)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })

  it("resolves a parameterised sql.unsafe insert the same way — it is the parameters, not the tagged-template syntax", async () => {
    // `sql.unsafe(text)` with no parameters takes the simple-protocol path
    // (`args.length === 0` in the driver's own `unsafe`) and correctly reports a deferred
    // failure; passing parameters switches it to the same extended-protocol path a tagged
    // template takes, and the failure is lost the same way. This is the case round 1 of #134
    // documented as safe and was not — pinned here so the distinction is enforced, not just
    // asserted in prose.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_db_deferred_unsafe")
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.p (id int PRIMARY KEY)`
      await sql`
        CREATE TABLE ${sql(schema)}.c (
          id int PRIMARY KEY,
          p  int REFERENCES ${sql(schema)}.p (id) DEFERRABLE INITIALLY DEFERRED
        )
      `

      const result = await expectDriverStillLosesWrite(
        sql.unsafe(
          `INSERT INTO ${schema}.c (id, p) VALUES ($1, $2) RETURNING id`,
          [1, 9],
        ),
      )
      assertEquals(result.count, 1)
      assertEquals(result.length, 1)

      const rows = await sql`SELECT id FROM ${sql(schema)}.c`
      assertEquals(rows.length, 0)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })

  it("expectDriverStillLosesWrite reports the upgrade instruction when the failure is reported", async () => {
    // Simulates "upstream fixed it" without waiting for a driver upgrade: `.simple()` forces
    // the very same statement onto the simple-protocol path, which resolves after the
    // server's own commit and so does report the failure. This is the reviewer's own check
    // that the helper above converts a reported failure into `UPSTREAM_FIXED_MESSAGE` rather
    // than passing an unrelated assertion failure through.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_db_deferred_simple")
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.p (id int PRIMARY KEY)`
      await sql`
        CREATE TABLE ${sql(schema)}.c (
          id int PRIMARY KEY,
          p  int REFERENCES ${sql(schema)}.p (id) DEFERRABLE INITIALLY DEFERRED
        )
      `

      const thrown = await assertRejects(() =>
        expectDriverStillLosesWrite(
          sql`INSERT INTO ${sql(schema)}.c (id, p) VALUES (1, 9) RETURNING id`.simple(),
        )
      )
      assertEquals((thrown as Error).message, UPSTREAM_FIXED_MESSAGE)

      const rows = await sql`SELECT id FROM ${sql(schema)}.c`
      assertEquals(rows.length, 0)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })

  it("sql.begin does report the same deferred constraint failure, and nothing is written", async () => {
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_db_deferred_begin")
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.p (id int PRIMARY KEY)`
      await sql`
        CREATE TABLE ${sql(schema)}.c (
          id int PRIMARY KEY,
          p  int REFERENCES ${sql(schema)}.p (id) DEFERRABLE INITIALLY DEFERRED
        )
      `

      await assertRejects(() =>
        sql.begin(async (transaction) => {
          await transaction`INSERT INTO ${transaction(schema)}.c (id, p) VALUES (1, 9)`
        })
      )

      const rows = await sql`SELECT id FROM ${sql(schema)}.c`
      assertEquals(rows.length, 0)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})
