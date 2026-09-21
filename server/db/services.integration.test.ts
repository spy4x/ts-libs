/**
 * `DbServiceBase` against a real Postgres server.
 *
 * `services.test.ts` runs against a fake that renders the driver's tagged template into
 * text. Three of the claims in this module cannot be checked that way, because they are
 * claims about what the server does with the text:
 *
 *  - a nested `begin` must roll back with the transaction it sits inside. Against a fake
 *    that is a label; against a server it is whether the row is still there;
 *  - `updateOne` with an empty data object used to render `SET updated_at = NOW(),
 *    WHERE …`. Only a server says whether that is valid SQL;
 *  - the soft-delete filter has to match a real `deleted_at` column;
 *  - a clone kept past `begin` has to be refused. Against a fake that is a flag; against
 *    a server it is whether the write reaches the transaction that connection is running
 *    next and vanishes with that transaction's rollback.
 *
 * The kept-clone tests use `max: 1`, so the clone and the later transaction are certain
 * to share the one connection and the collision is deterministic rather than a matter of
 * which connection the pool happened to hand out.
 *
 * The nested-`begin` tests leave the pool at its default size on purpose. With `max: 1`
 * the unfixed code — which takes a second connection out of the pool for the nested
 * call — waits for a connection that can never be free, and a Deno test has no timeout
 * of its own, so it would hang the tier instead of failing an assertion.
 *
 * Isolation: every test creates its own schema from a random suffix and drops it in a
 * `finally`. Nothing shared is touched.
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import type { RowCache, Sql } from "./ports.ts"
import { createSql } from "./postgres.ts"
import { DbServiceBase, PostgresScopeEndedError } from "./services.ts"

/** A note row, as the table below stores it. */
interface Note extends Record<string, unknown> {
  id: number
  body: string
  updated_at: Date
  deleted_at: Date | null
}

/**
 * A service that writes through whatever executor its clone holds.
 *
 * `protected sql` is where a transaction clone's executor lives, so reaching it needs a
 * subclass. This is also how a consumer uses the class: the base has no query method of
 * its own. The schema is a method argument rather than a field, because a clone is made
 * with `Object.create` and this test is not the place to depend on how that carries
 * state.
 */
class NoteService extends DbServiceBase {
  insert(schema: string, id: number, body: string): Promise<unknown> {
    return this.sql`INSERT INTO ${this.sql(schema)}.note (id, body) VALUES (${id}, ${body})`
  }

  /**
   * Every id in the table, as a plain array.
   *
   * `postgres` answers with a `Result`, which is an `Array` subclass; `assertEquals`
   * compares prototypes, so the rows are mapped out rather than asserted as they come.
   */
  async ids(schema: string): Promise<number[]> {
    const rows = await this
      .sql<{ id: number }[]>`SELECT id FROM ${this.sql(schema)}.note ORDER BY id`
    return rows.map((row) => row.id)
  }
}

/** A cache that stores nothing, for the cases where the database is the whole subject. */
function passthroughCache(): RowCache<Note> {
  return {
    wrap: (_key, compute) => compute(),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  }
}

/** Options for {@link withSchema}. */
interface SchemaOptions {
  /** Pool size. Left out for the driver's default, which is what the nested tests need. */
  max?: number
  /**
   * Point `search_path` at the schema, so a bare table name resolves to it.
   *
   * Only `buildMethods` needs this: it takes a bare table name and renders it through
   * `sql(table)`, which quotes it as a single identifier, so `schema.note` is not
   * expressible there. It is a session setting, so it is only safe with `max: 1`.
   */
  searchPath?: boolean
}

/** Open a client on a fresh schema holding a `note` table, and drop the schema after. */
async function withSchema(
  options: SchemaOptions,
  body: (sql: Sql, schema: string) => Promise<void>,
): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_services")
  const sql = createSql({
    connection: settings.connection,
    applicationName: schema,
    ...(options.max === undefined ? {} : { max: options.max }),
  })
  try {
    await sql`SET client_min_messages = warning`
    await sql`CREATE SCHEMA ${sql(schema)}`
    await sql`
      CREATE TABLE ${sql(schema)}.note (
        id         integer PRIMARY KEY,
        body       text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        deleted_at timestamptz
      )
    `
    if (options.searchPath === true) {
      await sql`SELECT set_config('search_path', ${schema}, false)`
    }
    await body(sql, schema)
  } finally {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
    await sql.end()
  }
}

describe("DbServiceBase against a real server", () => {
  it("rolls a nested begin back together with the transaction it sits inside", async () => {
    await withSchema({}, async (sql, schema) => {
      const service = new NoteService({ sql })

      await assertRejects(
        () =>
          service.begin(async (tx) => {
            await tx.insert(schema, 1, "outer")
            await tx.begin(async (inner) => {
              await inner.insert(schema, 2, "nested")
            })
            throw new Error("the outer transaction fails")
          }),
        Error,
        "the outer transaction fails",
      )

      // Both rows are gone. The nested call used to open a transaction on a second
      // connection, which committed on its own, so row 2 outlived the rollback that was
      // supposed to take it with it.
      assertEquals(await service.ids(schema), [])
    })
  })

  it("rolls a failed nested begin back to the savepoint and keeps the outer rows", async () => {
    await withSchema({}, async (sql, schema) => {
      const service = new NoteService({ sql })

      await service.begin(async (tx) => {
        await tx.insert(schema, 1, "outer")
        await assertRejects(
          () =>
            tx.begin(async (inner) => {
              await inner.insert(schema, 2, "nested")
              throw new Error("the savepoint fails")
            }),
          Error,
          "the savepoint fails",
        )
        await tx.insert(schema, 3, "after the savepoint")
      })

      assertEquals(await service.ids(schema), [1, 3])
    })
  })

  it("refuses a clone kept past begin, so its write cannot join a later transaction", async () => {
    await withSchema({ max: 1 }, async (sql, schema) => {
      const service = new NoteService({ sql })

      let kept: NoteService | undefined
      await service.begin(async (tx) => {
        kept = tx
        await tx.insert(schema, 1, "committed")
      })
      assertExists(kept)

      // The reproduction from issue #96. The kept clone used to write through the
      // connection its own transaction had run on, so row 3 landed inside this second
      // transaction, reported success, and disappeared when this one rolled back.
      await assertRejects(
        () =>
          service.begin(async (tx) => {
            await tx.insert(schema, 2, "second")
            await kept!.insert(schema, 3, "through the kept clone")
          }),
        PostgresScopeEndedError,
      )

      assertEquals(await service.ids(schema), [1])
    })
  })

  it("refuses a clone kept past a savepoint and leaves the outer transaction usable", async () => {
    await withSchema({ max: 1 }, async (sql, schema) => {
      const service = new NoteService({ sql })

      let kept: NoteService | undefined
      await service.begin(async (tx) => {
        await tx.begin(async (inner) => {
          kept = inner
          await inner.insert(schema, 1, "inside the savepoint")
        })
        assertExists(kept)
        assertThrows(
          () => kept!.insert(schema, 2, "through the kept clone"),
          PostgresScopeEndedError,
        )
        await tx.insert(schema, 3, "after the savepoint")
      })

      assertEquals(await service.ids(schema), [1, 3])
    })
  })

  it("updates only the timestamp when the data object is empty", async () => {
    await withSchema({ max: 1, searchPath: true }, async (sql) => {
      const service = new DbServiceBase({ sql })
      const notes = service.buildMethods<Note, { id: number }, { body?: string }>(
        "note",
        passthroughCache(),
      )
      const created = await notes.createOne({ data: { id: 1 } })

      // The general form renders `SET updated_at = NOW(), WHERE id = $1` for an empty
      // object, and the server answers `42601: syntax error at or near "WHERE"`.
      const touched = await notes.updateOne({ id: 1, data: {} })

      assertExists(touched)
      assertStrictEquals(touched.id, 1)
      assertStrictEquals(touched.updated_at > created.updated_at, true)
    })
  })

  it("hides a soft-deleted row from findOne and from updateOne", async () => {
    await withSchema({ max: 1, searchPath: true }, async (sql) => {
      const service = new DbServiceBase({ sql })
      const notes = service.buildMethods<Note, { id: number; body: string }, { body?: string }>(
        "note",
        passthroughCache(),
      )
      await notes.createOne({ data: { id: 1, body: "live" } })
      await notes.deleteOne({ id: 1 })

      assertStrictEquals(await notes.findOne({ id: 1 }), null)
      // The opt-out is the one read that still sees it.
      const audited = await notes.findOne({ id: 1, includeDeleted: true })
      assertStrictEquals(audited?.body, "live")
      // An update must match nothing, so it cannot hand a deleted row to a cache as if
      // it were live. No hand-written wider type here: `RowMethods.updateOne` says so.
      assertStrictEquals(await notes.updateOne({ id: 1, data: { body: "changed" } }), undefined)
      // `undeleteOne` keeps its own statement and is the one update that reaches it.
      const revivedRow = await notes.undeleteOne({ id: 1 })
      assertStrictEquals(revivedRow?.body, "live")
      const revived = await notes.findOne({ id: 1 })
      assertStrictEquals(revived?.body, "live")
    })
  })
})
