/**
 * The purge helper against a real Postgres server.
 *
 * `postgres-migrate.test.ts` asserts the statements the helper issues. It cannot assert
 * what they do, and for this helper that is the whole question: a `DROP TABLE` with a
 * bare name is valid SQL that drops a table in `public`, and reading the statement text
 * is not enough to see that the table in `public` is not the table the caller asked to
 * drop. That is what this file opens a socket for.
 *
 * Isolation: every run makes its own schema and its own table name from a random
 * suffix, and drops both in a `finally`. The decoy table this test plants in `public`
 * carries the same suffix, so the worst a broken purge can do here is drop a table this
 * run created. Nothing shared is touched and nothing is truncated.
 */

import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { ENV_NAME, purgeDatabase } from "./postgres-purge.ts"
import { createSql } from "./postgres.ts"
import type { Sql } from "./ports.ts"

/** `true` when `schema.table` exists as a base table on the server. */
async function tableExists(sql: Sql, schema: string, table: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = ${table} AND table_type = 'BASE TABLE'
    ) AS present
  `
  return rows[0].present
}

describe("purgeDatabase against a real server", () => {
  it("drops the named schema's tables and leaves a same-named table in public alone", async () => {
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_purge")
    const table = uniqueIdentifier("note")
    // One connection, so `client_min_messages` holds for every statement this test
    // sends and `search_path` is the server's default for all of them — which is the
    // path an unqualified DROP resolves through.
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.${sql(table)} (id integer PRIMARY KEY)`
      // The decoy. It has the name the purge will list out of the other schema, and it
      // is what an unqualified `DROP TABLE` reaches instead.
      await sql`CREATE TABLE public.${sql(table)} (id integer PRIMARY KEY)`

      const refused = await purgeDatabase({ sql, schema, environment: {} })
      assertEquals(refused, { dropped: [], refused: true })
      assertEquals(await tableExists(sql, schema, table), true)

      const purged = await purgeDatabase({ sql, schema, environment: { [ENV_NAME]: "test" } })

      assertEquals(purged, { dropped: [table], refused: false })
      assertEquals(await tableExists(sql, schema, table), false)
      // The one that matters: the purge reported the schema's table and dropped the
      // schema's table. It used to report the schema's table and drop this one.
      assertEquals(await tableExists(sql, "public", table), true)
    } finally {
      await sql`DROP TABLE IF EXISTS public.${sql(table)}`
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})

describe("purgeDatabase against a camelCase client", () => {
  it("reports and drops the named schema's table, not a same-named one in public", async () => {
    // `transform: postgres.camel` is what the template's own client used
    // (`template/libs/server/db/+index.ts:9`). `TableRow`'s column is aliased to one
    // lower-case word precisely so this client reads the same `tablename` a plain client
    // does; before that alias existed, the row's `table_name` came back as `tableName`
    // under this transform, `row.table_name` was `undefined`, and the identifier splice
    // below threw inside the driver rather than dropping anything (#77).
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_purge_camel")
    const table = uniqueIdentifier("note")
    const sql = createSql({
      connection: settings.connection,
      transform: postgres.camel,
      max: 1,
      applicationName: schema,
    })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.${sql(table)} (id integer PRIMARY KEY)`
      // The decoy, exactly as in the plain-client test above.
      await sql`CREATE TABLE public.${sql(table)} (id integer PRIMARY KEY)`

      const purged = await purgeDatabase({ sql, schema, environment: { [ENV_NAME]: "test" } })

      assertEquals(purged, { dropped: [table], refused: false })
      assertEquals(await tableExists(sql, schema, table), false)
      assertEquals(await tableExists(sql, "public", table), true)
    } finally {
      await sql`DROP TABLE IF EXISTS public.${sql(table)}`
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})
