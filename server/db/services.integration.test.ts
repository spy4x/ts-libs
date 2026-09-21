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
 * **What the kept-clone tests here cover, and what they do not.** They cover the guard's
 * promise: every call form a person would write through a clone kept past `begin()` or a
 * nested `begin()` is refused, and so is anything read off the handle at any depth. They do
 * not cover code that goes looking for the driver's internals; `services.ts` lists the
 * three known routes that remain, all tracked in #108. The most reachable of them is a
 * query built inside the callback and awaited after it, which a forgotten `await` is enough
 * to write; another — the transaction's execute function carried on a value a call
 * *returned* — is a
 * consequence of leaving return values as the driver built them, which the return-value
 * test below is there to keep.
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
import postgres from "postgres"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import type { RowCache, Sql } from "./ports.ts"
import { createSql } from "./postgres.ts"
import { DbServiceBase, PostgresScopeEndedError } from "./services.ts"
import { ownedBy, reachableFrom } from "./testing/reachable.ts"

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

  /** The executor this instance writes through — the clone's wrapper, on a clone. */
  executor(): { unsafe(text: string): Promise<unknown> } & Record<string, unknown> {
    return this.sql as unknown as
      & { unsafe(text: string): Promise<unknown> }
      & Record<string, unknown>
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

/**
 * A service that reaches for a custom type helper the caller registered on the client.
 *
 * `sql.types` is a function carrying one helper per registered type, so reading it
 * through the clone's wrapper is the case that broke: a wrapper that returns a plain
 * arrow function for it loses `shout`.
 */
class TypedService extends DbServiceBase {
  shout(value: string): Promise<Array<{ v: string }>> {
    const helpers = this.sql as unknown as { types: { shout: (value: string) => unknown } }
    return this.sql<{ v: string }[]>`SELECT ${helpers.types.shout(value)}::text AS v`
      .then((rows) => rows.map((row) => ({ v: row.v })))
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

/**
 * The own keys of a `postgres@3.4.7` transaction handle.
 *
 * The same list is written down in `services.test.ts`, where the fake has to match it.
 * Keeping it in both files is deliberate: this one is measured against the driver, so a
 * driver upgrade that changes the shape fails here, and the fake's copy is then a comment
 * that no longer matches a test somebody has to look at (#115).
 */
const TRANSACTION_HANDLE_KEYS: string[] = [
  "array",
  "file",
  "json",
  "length",
  "name",
  "notify",
  "prepare",
  "prototype",
  "savepoint",
  "types",
  "typed",
  "unsafe",
]

describe("DbServiceBase against a real server", () => {
  it("gives a transaction callback a handle with no begin, reserve or listen", async () => {
    // What `services.test.ts`'s fake has to copy. `postgres` assigns `begin`, `reserve`
    // and `listen` to the root client alone (`src/index.js:69-82`), and `scope` builds the
    // handle with `Sql(handler)` plus `savepoint` and `prepare` (`src/index.js:251-254`).
    // The fake used to offer `begin` and `reserve` here, which is how two call forms
    // nobody can write reached the documentation (#115).
    await withSchema({ max: 1 }, async (sql) => {
      let keys: string[] = []
      let callable: string[] = []
      await sql.begin((tx) => {
        const handle = tx as unknown as Record<string, unknown>
        keys = [...Reflect.ownKeys(tx as unknown as object)].map(String).sort()
        callable = ["begin", "reserve", "listen"].filter(
          (name) => typeof handle[name] === "function",
        )
        return Promise.resolve()
      })

      assertEquals(keys, [...TRANSACTION_HANDLE_KEYS].sort())
      assertEquals(callable, [], "the driver's transaction handle grew a client-only method")
    })
  })

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

  it("reads off the real driver's handle never give back the driver's own value", async () => {
    // A regression test over the whole property graph, not a proof about the wrapper. It
    // says one thing: nothing *read* off the clone's handle is a value the driver owns, at
    // any depth. That is what rounds 2, 3 and 4 kept finding a new spelling of, most
    // recently `prototype.constructor`, which a list of call forms could never contain
    // because every ordinary function carries a `prototype` object whose `constructor` is
    // the function itself. What a call *returns* is outside this test on purpose; see the
    // header of this file for the routes that remain.
    await withSchema({ max: 1 }, async (sql) => {
      const service = new NoteService({ sql })

      // The reference set has to hold the values of *this* transaction, not just the root
      // client's: `postgres` builds `sql`, `typed`, `unsafe`, `file`, `savepoint` and
      // `prepare` fresh for every transaction, so a set taken from the root alone holds
      // none of the functions that send a statement here — and a set taken from a second,
      // separate transaction holds none of them either, because those are fresh again.
      // `begin` is intercepted so the handle recorded is the one this clone wraps.
      let rawTransaction: unknown
      // deno-lint-ignore no-explicit-any
      const client = sql as any
      const originalBegin = client.begin.bind(sql)
      // deno-lint-ignore no-explicit-any
      client.begin = (callback: (transaction: any) => Promise<unknown>) =>
        // deno-lint-ignore no-explicit-any
        originalBegin((transaction: any) => {
          rawTransaction = transaction
          return callback(transaction)
        })

      let walk: ReturnType<typeof reachableFrom> | undefined
      try {
        await service.begin((tx) => {
          walk = reachableFrom(tx.executor())
          return Promise.resolve()
        })
      } finally {
        client.begin = originalBegin
      }

      assertExists(rawTransaction)
      assertExists(walk)
      assertStrictEquals(walk.truncated, false, "the walk hit its limit instead of finishing")
      assertEquals(walk.refused, [], "a read refused while the clone was live")

      // Everything the root client and one raw transaction handle own, minus everything any
      // function at all can reach. That leaves the driver's own tag, `unsafe`, `file`,
      // `savepoint`, `prepare`, `array`, `json`, `notify`, the type helpers and the objects
      // hanging off them.
      const driverOwned = ownedBy(sql, rawTransaction)
      assertStrictEquals(
        driverOwned.size > 0,
        true,
        "the driver owns nothing reachable, so this proves nothing",
      )

      const leaked = [...walk.values].filter((value) => driverOwned.has(value))
      assertEquals(
        leaked.map((value) => typeof value === "function" ? value.name || "anonymous" : "object"),
        [],
        "a read off the handle gave back something the driver owns",
      )
    })
  })

  it("hands back what a call returns untouched, so the driver still recognises it", async () => {
    // The other side of wrapping everything a *read* hands out. A value a *call* returns
    // must not be wrapped: the driver recognises what it is given back by class — a
    // fragment, a `Parameter` from `json` or `array`, an `Identifier`, a `Query` — and a
    // wrapper would not be that class, so nested fragments would stop composing. It also
    // has to stay a real query object, with the five methods a caller reaches for.
    await withSchema({ max: 1 }, async (sql, schema) => {
      const service = new NoteService({ sql })

      await service.begin(async (tx) => {
        // deno-lint-ignore no-explicit-any
        const q = tx.executor() as any
        await q`INSERT INTO ${q(schema)}.note (id, body) VALUES (1, 'one'), (2, 'two')`

        // A fragment built by one call and spliced into another.
        const where = q`WHERE id = ${1}`
        const filtered = await q`SELECT id FROM ${q(schema)}.note ${where}`
        assertEquals(filtered.map((row: { id: number }) => row.id), [1])

        // The value helpers, each recognised by its class on the way back in.
        const asJson = await q`SELECT ${q.json({ a: 1 })}::jsonb AS v`
        assertEquals(asJson[0].v, { a: 1 })
        const asArray = await q`SELECT ${q.array([1, 2, 3])}::int[] AS v`
        assertEquals(asArray[0].v, [1, 2, 3])
        const byIdentifier = await q`SELECT id FROM ${q(schema)}.${q("note")} ORDER BY id`
        assertEquals(byIdentifier.map((row: { id: number }) => row.id), [1, 2])

        // And the query object keeps its own methods.
        // `values()` answers with a `Result`, an `Array` subclass, and `assertEquals`
        // compares prototypes — so the rows are mapped out, as `ids` above does.
        const asValues = await q`SELECT id FROM ${q(schema)}.note ORDER BY id`.values()
        assertEquals(asValues.map((row: number[]) => row), [[1], [2]])
        assertStrictEquals((await q`SELECT 1 AS v`.simple())[0].v, 1)
        const described = await q`SELECT id FROM ${q(schema)}.note`.describe()
        assertEquals(described.columns.map((column: { name: string }) => column.name), ["id"])
        const forEached: number[] = []
        await q`SELECT id FROM ${q(schema)}.note ORDER BY id`.forEach((row: { id: number }) => {
          forEached.push(row.id)
        })
        assertEquals(forEached, [1, 2])
        const cursored: number[] = []
        for await (const batch of q`SELECT id FROM ${q(schema)}.note ORDER BY id`.cursor(1)) {
          cursored.push(batch[0].id)
        }
        assertEquals(cursored, [1, 2])
      })
    })
  })

  it("refuses a kept clone reached with new, against the real driver", async () => {
    // `postgres` declares its helpers as ordinary functions, so they can be constructed,
    // and a constructor that returns an object returns that object: `new sql.unsafe(...)`
    // ran the statement. Against the server, on the round 2 head, row 3 was written,
    // reported success, and went with this transaction's rollback.
    await withSchema({ max: 1 }, async (sql, schema) => {
      const service = new NoteService({ sql })

      let kept: NoteService | undefined
      await service.begin(async (tx) => {
        kept = tx
        await tx.insert(schema, 1, "committed")
      })
      assertExists(kept)
      const executor = kept.executor()
      const statement = `INSERT INTO "${schema}".note (id, body) VALUES (3, 'through new')`

      await assertRejects(
        () =>
          service.begin(async (tx) => {
            await tx.insert(schema, 2, "second")
            await new (executor.unsafe as unknown as new (text: string) => unknown)(statement)
          }),
        PostgresScopeEndedError,
      )

      assertEquals(await service.ids(schema), [1])
    })
  })

  it("refuses a kept clone reached through prototype.constructor, against the real driver", async () => {
    // `unsafe.prototype.constructor` is `unsafe` itself, and it used to come back
    // unwrapped: on the round 3 head this wrote row 3, reported success, and lost it to
    // this transaction's rollback, on all three paths.
    await withSchema({ max: 1 }, async (sql, schema) => {
      const service = new NoteService({ sql })

      let kept: NoteService | undefined
      await service.begin(async (tx) => {
        kept = tx
        await tx.insert(schema, 1, "committed")
      })
      assertExists(kept)
      const executor = kept.executor() as unknown as {
        unsafe: { prototype: { constructor: (text: string) => Promise<unknown> } }
      }
      const statement = `INSERT INTO "${schema}".note (id, body) VALUES (3, 'through prototype')`

      await assertRejects(
        () =>
          service.begin(async (tx) => {
            await tx.insert(schema, 2, "second")
            await executor.unsafe.prototype.constructor(statement)
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

  it("keeps a caller's custom type helpers reachable inside a transaction", async () => {
    // The clone's executor is a wrapper, and a wrapper that replaced each function with a
    // plain arrow threw away the properties that function carried. `postgres` hangs one
    // helper per registered custom type on `sql.types` and `sql.typed`, which are
    // themselves functions, so `sql.types.shout(...)` became a `TypeError` inside a
    // transaction although it worked outside one.
    //
    // The client is built with the driver directly rather than through `createSql`,
    // because custom types are deliberately not part of `CreateSqlOptions`; this test is
    // about what a caller who registers one sees through the clone.
    const settings = postgresSettings()
    await requireReachable(settings.address)
    const name = uniqueIdentifier("it_types")
    const sql = postgres({
      host: settings.connection.host,
      port: settings.connection.port,
      user: settings.connection.user,
      pass: settings.connection.password,
      db: settings.connection.database,
      connection: { application_name: name },
      max: 1,
      types: {
        shout: {
          to: 25,
          from: [25],
          serialize: (value: string) => value.toUpperCase(),
          parse: (value: string) => value,
        },
      },
    }) as unknown as Sql

    try {
      const service = new TypedService({ sql })
      await service.begin(async (tx) => {
        const rows = await tx.shout("hello")
        assertEquals(rows, [{ v: "HELLO" }])
      })
    } finally {
      await sql.end()
    }
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
