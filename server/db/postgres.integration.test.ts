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

import { assertEquals } from "@std/assert"
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
