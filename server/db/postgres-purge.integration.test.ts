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

import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { PostgresIdentifierTransformError } from "./postgres-migrate.ts"
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
    // (`template/libs/server/db/+index.ts:13`). The table listing was originally aliased
    // to one lower-case word precisely so this client read the same `tablename` a plain
    // client does; before that alias existed, the row's `table_name` came back as
    // `tableName` under this transform, `row.table_name` was `undefined`, and the
    // identifier splice below threw inside the driver rather than dropping anything (#77).
    // The listing is read by column position now, not by the alias (#137, which also
    // fixed a `postgres.pascal` client — see `postgres-migrate.integration.test.ts`), but
    // this test still holds and still exercises `postgres.camel`.
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

  it("refuses to purge when a listed table's name would be rewritten, and drops nothing", async () => {
    // Round 2 found the alias fix above incomplete: `DROP TABLE ${sql(schema)}.${sql(table)}`
    // runs the client's own `transform.column.to` on both names, but the listing above reads
    // `table_name` as a bound value, which that transform never touches. A camelCase client
    // asked to purge a schema holding "UserProfile" would list it and then try to drop
    // `_user_profile`, which does not exist — reproduced here rather than assumed.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_purge_camel_refuse")
    const plainTable = uniqueIdentifier("plain_one")
    const mixedTable = "UserProfile"
    const sql = createSql({
      connection: settings.connection,
      transform: postgres.camel,
      max: 1,
      applicationName: schema,
    })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.${sql(plainTable)} (id integer PRIMARY KEY)`
      // Created through `unsafe`, not `sql(mixedTable)`: creating it through the identifier
      // form would send `mixedTable` through the very transform this test is about, and the
      // table would not exist under the exact spelling the test needs.
      await sql.unsafe(`CREATE TABLE "${schema}"."${mixedTable}" (id integer PRIMARY KEY)`)

      const error = await assertRejects(
        () => purgeDatabase({ sql, schema, environment: { [ENV_NAME]: "test" } }),
        PostgresIdentifierTransformError,
      )
      assertEquals(error.kind, "table")
      assertEquals(error.identifier, mixedTable)

      // Every name was checked before the first `DROP` ran, so the plain table the listing
      // also returned is untouched too, not only the one that caused the refusal.
      assertEquals(await tableExists(sql, schema, plainTable), true)
      assertEquals(await tableExists(sql, schema, mixedTable), true)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})

describe("purgeDatabase through a transaction handle", () => {
  it("drops the schema's tables when handed the handle `sql.begin` passes in", async () => {
    // `postgres@3.4.7` sets `options` on the pool object alone (`src/index.js:69-81`); the
    // handle `sql.begin` passes to its callback has none, although `TransactionSql` is
    // typed as extending `Sql`. A purge run inside a transaction, so that a failed `DROP`
    // rolls every other one back, has to keep working on such a handle.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_purge_tx")
    const table = uniqueIdentifier("note")
    const sql = createSql({ connection: settings.connection, max: 1, applicationName: schema })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.${sql(table)} (id integer PRIMARY KEY)`

      const purged = await sql.begin((transaction) =>
        purgeDatabase({ sql: transaction, schema, environment: { [ENV_NAME]: "test" } })
      )

      assertEquals(purged, { dropped: [table], refused: false })
      assertEquals(await tableExists(sql, schema, table), false)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })

  it("refuses a camelCase handle's mixed-case schema and drops nothing in either", async () => {
    // A transaction handle carries no `options`, but its `sql(name)` still runs the client's
    // `transform.column.to`. Were the name check skipped there, the listing would read
    // `mixed` while every `DROP` went to `decoy`: the purge would report success, leave
    // `mixed` whole and empty `decoy`, a schema it was never asked to touch.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const base = uniqueIdentifier("it_purge_tx_camel")
    const mixed = `${base}_Mixed`
    const decoy = `${base}__mixed` // What `postgres.camel` sends for `mixed`.
    const table = uniqueIdentifier("note")
    const sql = createSql({
      connection: settings.connection,
      transform: postgres.camel,
      max: 1,
      applicationName: base,
    })

    try {
      await sql`SET client_min_messages = warning`
      // Through `unsafe`: `sql(mixed)` would send `mixed` through the transform under test.
      for (const schema of [mixed, decoy]) {
        await sql.unsafe(`CREATE SCHEMA "${schema}"`)
        await sql.unsafe(`CREATE TABLE "${schema}"."${table}" (id integer PRIMARY KEY)`)
      }

      const error = await assertRejects(
        () =>
          sql.begin((transaction) =>
            purgeDatabase({ sql: transaction, schema: mixed, environment: { [ENV_NAME]: "test" } })
          ),
        PostgresIdentifierTransformError,
      )
      assertEquals(error.kind, "schema")
      assertEquals(error.rewrittenTo, decoy)
      assertEquals(await tableExists(sql, mixed, table), true)
      assertEquals(await tableExists(sql, decoy, table), true)
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${mixed}" CASCADE`)
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${decoy}" CASCADE`)
      await sql.end()
    }
  })
})

/**
 * A `transform.row.from` that adds a field without changing a row's shape: a `.values()` row
 * (an array) stays an array of the same length, an object row stays an object with one more
 * key. Mirrors `postgres-migrate.integration.test.ts`'s `auditFieldTransform`, kept local
 * rather than imported so this file's tests stay self-contained.
 */
const auditFieldTransform = {
  row: {
    from: (row: unknown) => {
      if (Array.isArray(row)) {
        const copy = row.slice() as unknown[] & { auditedAt?: string }
        copy.auditedAt = "audit-marker"
        return copy
      }
      return { ...(row as Record<string, unknown>), auditedAt: "audit-marker" }
    },
  },
}

describe("purgeDatabase against a client with a transform.row.from that adds a field", () => {
  it("still reports and drops the named schema's table", async () => {
    // Pins that the table listing is read through `.values()`, not `Object.values(row)` on a
    // name-keyed object (#137 round 3): a row transform that spreads `{ ...row, extra }` turns
    // a name-keyed object into one with an extra key, but `.values()` builds a plain positional
    // array in the first place, so an added field lands at the end and never shifts the
    // `tablename` column out of position 0.
    const settings = postgresSettings()
    await requireReachable(settings.address)

    const schema = uniqueIdentifier("it_purge_audit")
    const table = uniqueIdentifier("note")
    const sql = createSql({
      connection: settings.connection,
      transform: auditFieldTransform as unknown as typeof postgres.camel,
      max: 1,
      applicationName: schema,
    })

    try {
      await sql`SET client_min_messages = warning`
      await sql`CREATE SCHEMA ${sql(schema)}`
      await sql`CREATE TABLE ${sql(schema)}.${sql(table)} (id integer PRIMARY KEY)`

      const purged = await purgeDatabase({ sql, schema, environment: { [ENV_NAME]: "test" } })

      assertEquals(purged, { dropped: [table], refused: false })
      assertEquals(await tableExists(sql, schema, table), false)
    } finally {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
      await sql.end()
    }
  })
})
