/**
 * Tests for the Postgres service base class.
 *
 * Every test here runs against a fake `Sql` that mimics the driver's tagged template:
 * `sql("users")` and `sql({ name })` render inline — as an identifier and a column list —
 * while anything else becomes `$1`, `$2`, …. That nesting is what `buildMethods` uses, so
 * without it these assertions would pass against SQL the driver never produces.
 *
 * That is the limit of this file: **no test opens a Postgres connection**, so column
 * mapping, `RETURNING *` shapes and `NOW()` evaluation are asserted as text, not as
 * behaviour. A live-database suite is the missing piece and it is named in the PR body.
 *
 * The fake is cast to `Sql`. That is unavoidable rather than lazy: `postgres`'s type is a
 * tag function with a dozen embedded properties and overloads, and no honest object
 * satisfies it. The cast is confined to `createFakeSql`.
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert"
import type { RowCache, Sql, Transaction } from "./ports.ts"
import { DbServiceBase, PostgresScopeEndedError } from "./services.ts"

/** Options for {@link createFakeSql}. */
interface FakeSqlOptions {
  /** Statements that should reject instead of answering, matched by substring. */
  failOn?: string[]
  /** Answers, drained from the front. A missing entry answers no rows, as an empty list. */
  answers?: unknown[][]
  /**
   * Answer from the statement text instead of from the queue.
   *
   * `undefined` falls through to {@link answers}. This is how a test stands in for a
   * server that holds a particular row: a `WHERE` the statement carries changes what
   * comes back, which a queue of answers cannot express.
   */
  answerFor?: (query: string) => unknown[] | undefined
}

/** A value `postgres` splices in as a quoted identifier. */
interface FakeIdentifier {
  __identifier: string
}

/** A value `postgres` splices in as a column list. */
interface FakeColumnList {
  __columns: Record<string, unknown>
}

/**
 * A recorder that mimics `postgres`'s tagged template for the calls this package makes.
 *
 * `topLevel` holds statements issued on the client, plus `BEGIN`/`ROLLBACK`/`COMMIT`/
 * `end(5)` markers; `inner` holds statements issued on a transaction handle, in order,
 * which is what proves `begin` swapped the executor the callback writes through.
 */
function createFakeSql(options: FakeSqlOptions = {}) {
  const topLevel: string[] = []
  const inner: string[] = []
  const answers = options.answers ?? []
  const failOn = options.failOn ?? []
  let inTransaction = false

  const render = (strings: TemplateStringsArray, values: unknown[]): string => {
    let text = strings[0]
    const bound: unknown[] = []
    const bind = (value: unknown): string => {
      bound.push(value)
      return `$${bound.length}`
    }
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]
      const tail = strings[index + 1]
      const identifier = identifierOf(value)
      if (identifier !== undefined) {
        text += `"${identifier}"${tail}`
        continue
      }
      const columns = columnListOf(value)
      if (columns !== undefined) {
        text += Object.entries(columns)
          .map(([column, cell]) => `"${column}" = ${bind(cell)}`)
          .join(", ") + tail
        continue
      }
      if (typeof value === "function") {
        // A transform helper, `sql(transform(column))`. Applied, so an assertion about
        // camelCase columns cannot pass against a transform the driver never called.
        text += `"${String((value as (column: string) => string)("updated_at"))}"${tail}`
        continue
      }
      text += `${bind(value)}${tail}`
    }
    return text.trim().replace(/\s+/g, " ")
  }

  const execute = (query: string, record: (query: string) => void): Promise<unknown> => {
    record(query)
    if (failOn.some((fragment) => query.includes(fragment))) {
      return Promise.reject(new Error(`fake sql rejects: ${query}`))
    }
    const scripted = options.answerFor?.(query)
    if (scripted !== undefined) return Promise.resolve(scripted)
    // `?? []` and not `?? undefined`: the driver answers a query that matched nothing
    // with an empty list, and a fake that answered `undefined` made every caller of
    // `rows[0]` throw a TypeError where the real one returns no row.
    return Promise.resolve(answers.shift() ?? [])
  }

  /**
   * One call form, as the driver has it.
   *
   * `sql` is a single callable used two ways: as a tag, and as `sql("users")` /
   * `sql({ name })`, which render a value for a later template. Measured against
   * `postgres@3.4.7`: `sql("users")` returns an `Identifier`, not a promise and not the
   * string, so the fake has to make the same distinction by looking for a template
   * strings array.
   */
  const statement = (strings: unknown, ...values: unknown[]): unknown => {
    if (!Array.isArray(strings)) {
      return typeof strings === "string"
        ? { __identifier: strings } satisfies FakeIdentifier
        : { __columns: strings as Record<string, unknown> } satisfies FakeColumnList
    }
    const query = render(strings as unknown as TemplateStringsArray, values)
    return inTransaction
      ? execute(query, (it) => inner.push(it))
      : execute(query, (it) => topLevel.push(it))
  }

  const asTag = statement as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>

  /**
   * The transaction handle, with the two nesting calls `postgres` puts on it.
   *
   * `savepoint` is the real one and is recorded in `inner`, because a savepoint is a
   * statement on the connection the transaction already holds. `begin` is there so the
   * fake can be asked for it: `postgres` does put `begin` on a transaction handle, and
   * calling it takes a *second* connection out of the pool, which is the bug this fake
   * used to label "BEGIN NESTED" and assert as correct. It is recorded in `topLevel`,
   * where a second `BEGIN` is visible.
   */
  const transaction = Object.assign(statement, {
    savepoint: <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      inner.push("SAVEPOINT")
      return Promise.resolve()
        .then(() => callback(transaction as unknown as Transaction))
        .then((result) => {
          inner.push("RELEASE SAVEPOINT")
          return result
        })
        .catch((error: unknown) => {
          inner.push("ROLLBACK TO SAVEPOINT")
          throw error
        })
    },
    begin: <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> =>
      client.begin(callback),
  })

  const client = Object.assign(asTag, {
    begin: <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      topLevel.push("BEGIN")
      inTransaction = true
      return Promise.resolve()
        .then(() => callback(transaction as unknown as Transaction))
        .then((result) => {
          topLevel.push("COMMIT")
          inTransaction = false
          return result
        })
        .catch((error: unknown) => {
          topLevel.push("ROLLBACK")
          inTransaction = false
          throw error
        })
    },
    end: (endOptions?: { timeout?: number }) => {
      topLevel.push(`end(${endOptions?.timeout ?? ""})`)
      return Promise.resolve()
    },
  })

  return {
    sql: client as unknown as Sql,
    topLevel,
    inner,
  }
}

function identifierOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "__identifier" in value
    ? String((value as FakeIdentifier).__identifier)
    : undefined
}

function columnListOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && "__columns" in value
    ? (value as FakeColumnList).__columns
    : undefined
}

/**
 * A `DbServiceBase` that exposes the client its clone holds.
 *
 * `protected sql` is where a clone's executor lives, so proving `begin` swapped it needs
 * one subclass that reads it. This is also how a consumer uses the class: the base has no
 * query method of its own.
 */
class TestService extends DbServiceBase {
  select(value: number): Promise<unknown> {
    return this.sql`SELECT ${value}`
  }
}

/** A `RowCache` that records its calls. */
function createFakeCache<T>() {
  const calls: string[] = []
  const stored = new Map<string | number, T>()
  const cache: RowCache<T> = {
    wrap: (key, compute) => {
      calls.push(`wrap:${key}`)
      const cached = stored.get(key)
      if (cached !== undefined) return Promise.resolve(cached)
      return compute().then((value) => {
        stored.set(key, value)
        return value
      })
    },
    set: (key, value) => {
      calls.push(`set:${key}`)
      stored.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      calls.push(`delete:${key}`)
      stored.delete(key)
      return Promise.resolve()
    },
  }
  return { cache, calls, stored }
}

Deno.test("connect runs SELECT 1 and shutdown closes the pool with a five second bound", async () => {
  const fake = createFakeSql()
  const service = new DbServiceBase({ sql: fake.sql })

  await service.connect()
  await service.shutdown()

  assertEquals(fake.topLevel, ["SELECT 1", "end(5)"])
})

Deno.test("isConnected reports false instead of throwing when the query fails", async () => {
  const fake = createFakeSql({ failOn: ["SELECT 1"] })
  const service = new DbServiceBase({ sql: fake.sql })

  assertStrictEquals(await service.isConnected(), false)
  assertEquals(fake.topLevel, ["SELECT 1"])
})

Deno.test("sanitize drops undefined fields and always drops updatedAt", () => {
  const service = new DbServiceBase({ sql: createFakeSql().sql })

  assertEquals(service.sanitize({ name: "kept", missing: undefined }), { name: "kept" })
  assertEquals(service.sanitize({ name: "kept", updatedAt: new Date(0) }), { name: "kept" })
  assertEquals(service.sanitize({}), {})
  assertEquals(service.sanitize({ zero: 0, empty: "", no: false }), {
    zero: 0,
    empty: "",
    no: false,
  })
})

Deno.test("findOne reads through the cache outside a transaction", async () => {
  const fake = createFakeSql({ answers: [[{ id: 7, name: "cached" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<{ id: number; name: string }>()

  const row = await service.findOne(cache, 7, fake.sql`SELECT * FROM users WHERE id = ${7}`)

  assertEquals(row, { id: 7, name: "cached" })
  assertEquals(calls, ["wrap:7"])
})

Deno.test("createOne, updateOne and deleteOne write the row through the cache", async () => {
  const fake = createFakeSql({
    answers: [[{ id: 1, name: "created" }], [{ id: 1, name: "updated" }], [{ id: 1 }]],
  })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls, stored } = createFakeCache<{ id: number; name: string }>()

  await service.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
  assertEquals(stored.get(1), { id: 1, name: "created" })

  await service.updateOne(cache, fake.sql`UPDATE users SET name = ${"x"} RETURNING *`)
  assertEquals(stored.get(1), { id: 1, name: "updated" })

  await service.deleteOne(cache, fake.sql`UPDATE users SET deleted_at = NOW() RETURNING *`)
  assertEquals(stored.has(1), false)

  assertEquals(calls, ["set:1", "set:1", "delete:1"])
})

Deno.test("findOne inside a transaction reads the database and leaves the cache alone", async () => {
  const fake = createFakeSql({ answers: [[{ id: 5 }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<{ id: number }>()

  const row = await service.begin(async (tx) =>
    await tx.findOne(cache, 5, fake.sql`SELECT * FROM users WHERE id = ${5}`)
  )

  assertEquals(row, { id: 5 })
  assertEquals(calls, [])
  assertEquals(fake.inner, ["SELECT * FROM users WHERE id = $1"])
})

Deno.test("a cache write made inside a transaction runs only after the commit", async () => {
  const fake = createFakeSql({ answers: [[{ id: 3, name: "inside" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<Record<string, unknown>>()

  await service.begin(async (tx) => {
    await tx.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
    // Queued, not written: the row is not committed yet.
    assertEquals(calls, [])
  })

  assertEquals(calls, ["set:3"])
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, ["INSERT INTO users DEFAULT VALUES RETURNING *"])
})

Deno.test("a cache write made inside a failed transaction is discarded", async () => {
  const fake = createFakeSql({ answers: [[{ id: 9, name: "rolled back" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<Record<string, unknown>>()

  let message = ""
  try {
    await service.begin(async (tx) => {
      await tx.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
      throw new Error("constraint violated")
    })
  } catch (error) {
    message = (error as Error).message
  }

  assertStrictEquals(message, "constraint violated")
  assertEquals(calls, [])
  assertEquals(fake.topLevel, ["BEGIN", "ROLLBACK"])
})

Deno.test("a failing cache write is logged and does not fail the query", async () => {
  const fake = createFakeSql({ answers: [[{ id: 12 }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const cache: RowCache<{ id: number }> = {
    wrap: (_key, compute) => compute(),
    set: () => Promise.reject(new Error("cache down")),
    delete: () => Promise.resolve(),
  }

  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    const row = await service.createOne(
      cache,
      fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`,
    )
    assertEquals(row, { id: 12 })
  } finally {
    console.error = original
  }

  assertEquals(logged.length, 1)
  assertEquals((logged[0][1] as Error).message, "cache down")
})

Deno.test("begin routes the callback's queries through the transaction handle", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  const result = await service.begin(async (tx) => {
    await tx.select(1)
    return "done"
  })

  assertStrictEquals(result, "done")
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, ["SELECT $1"])
})

Deno.test("a nested begin opens a savepoint on the transaction, not a second transaction", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  await service.begin(async (tx) => {
    await tx.begin(async (innerTx) => {
      await innerTx.select(2)
    })
  })

  // One BEGIN and one COMMIT, on the client. A second BEGIN here would be a second
  // connection out of the pool carrying a transaction of its own, which commits
  // separately and survives the outer rollback; that is what this used to do.
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, ["SAVEPOINT", "SELECT $1", "RELEASE SAVEPOINT"])
})

Deno.test("a nested begin that throws rolls back to the savepoint and leaves the outer open", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  await service.begin(async (tx) => {
    let message = ""
    try {
      await tx.begin(async (innerTx) => {
        await innerTx.select(2)
        throw new Error("the savepoint fails")
      })
    } catch (error) {
      message = (error as Error).message
    }
    assertStrictEquals(message, "the savepoint fails")
    await tx.select(3)
  })

  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, [
    "SAVEPOINT",
    "SELECT $1",
    "ROLLBACK TO SAVEPOINT",
    "SELECT $1",
  ])
})

Deno.test("a clone kept past begin refuses every later statement", async () => {
  // The clone is the one handle on the connection the transaction ran on. A service that
  // stores it — `this.db = tx` — keeps that handle for the rest of the process, and a
  // write through it later lands inside whatever transaction that connection is running
  // then and goes with that transaction's rollback, after reporting success.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await service.begin(async (tx) => {
    kept = tx
    await tx.select(1)
  })

  assertExists(kept)
  // Thrown, not rejected: the check sits on the executor, which the driver also calls
  // synchronously. `select` returns the tagged template unawaited, so the throw reaches
  // the caller directly; an `async` method turns the same throw into a rejection.
  assertThrows(
    () => kept!.select(2),
    PostgresScopeEndedError,
    "belonged to a transaction that has already committed or rolled back",
  )
  // A nested `begin` on the kept clone is the same door, and closes with it.
  await assertRejects(() => kept!.begin(() => Promise.resolve(undefined)), PostgresScopeEndedError)
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, ["SELECT $1"])
})

Deno.test("a clone kept past a begin that rolled back refuses too", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await assertRejects(
    () =>
      service.begin((tx) => {
        kept = tx
        return Promise.reject(new Error("the callback failed"))
      }),
    Error,
    "the callback failed",
  )

  assertExists(kept)
  assertThrows(() => kept!.select(1), PostgresScopeEndedError)
  assertEquals(fake.topLevel, ["BEGIN", "ROLLBACK"])
  assertEquals(fake.inner, [])
})

Deno.test("a write through a kept clone cannot land in a later transaction", async () => {
  // The reproduction from issue #96, as a statement count. Before the fix the kept
  // clone's `SELECT` was recorded inside the second transaction — three inner
  // statements and a COMMIT — and it disappeared when that transaction rolled back.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await service.begin(async (tx) => {
    kept = tx
    await tx.select(1)
  })

  await assertRejects(
    () =>
      service.begin(async (tx) => {
        await tx.select(2)
        await kept!.select(3)
      }),
    PostgresScopeEndedError,
  )

  assertEquals(fake.inner, ["SELECT $1", "SELECT $1"])
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"])
})

Deno.test("a clone kept past a savepoint refuses every later statement", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await service.begin(async (tx) => {
    await tx.begin(async (innerTx) => {
      kept = innerTx
      await innerTx.select(1)
    })
    assertExists(kept)
    assertThrows(() => kept!.select(2), PostgresScopeEndedError)
    // The transaction the savepoint sat inside is untouched by the refusal.
    await tx.select(3)
  })

  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, ["SAVEPOINT", "SELECT $1", "RELEASE SAVEPOINT", "SELECT $1"])
})

Deno.test("a cache write made inside a savepoint waits for the outermost commit", async () => {
  const fake = createFakeSql({ answers: [[{ id: 21, name: "inner" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<Record<string, unknown>>()

  await service.begin(async (tx) => {
    await tx.begin(async (innerTx) => {
      await innerTx.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
    })
    // The savepoint has returned and the row is still not committed: the outer
    // transaction can roll it back, so nothing may reach the cache yet.
    assertEquals(calls, [])
  })

  assertEquals(calls, ["set:21"])
})

Deno.test("a cache write made inside a savepoint that threw never runs", async () => {
  const fake = createFakeSql({ answers: [[{ id: 22, name: "discarded" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<Record<string, unknown>>()

  await service.begin(async (tx) => {
    let message = ""
    try {
      await tx.begin(async (innerTx) => {
        await innerTx.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
        throw new Error("the savepoint fails")
      })
    } catch (error) {
      message = (error as Error).message
    }
    assertStrictEquals(message, "the savepoint fails")
  })

  // The outer transaction committed, and the row the savepoint rolled back is not in
  // the cache. A cache holding a row the database never kept is the failure the whole
  // deferral exists to prevent.
  assertEquals(calls, [])
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
})

Deno.test("a cache write made inside a savepoint is discarded when the outer transaction fails", async () => {
  const fake = createFakeSql({ answers: [[{ id: 23, name: "rolled back" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls } = createFakeCache<Record<string, unknown>>()

  let message = ""
  try {
    await service.begin(async (tx) => {
      await tx.begin(async (innerTx) => {
        await innerTx.createOne(cache, fake.sql`INSERT INTO users DEFAULT VALUES RETURNING *`)
      })
      throw new Error("the outer transaction fails")
    })
  } catch (error) {
    message = (error as Error).message
  }

  assertStrictEquals(message, "the outer transaction fails")
  assertEquals(calls, [])
  assertEquals(fake.topLevel, ["BEGIN", "ROLLBACK"])
})

Deno.test("buildMethods produces the template SQL for read, create, update and soft delete", async () => {
  const fake = createFakeSql({
    answers: [[{ id: 4 }], [{ id: 4 }], [{ id: 4 }], [{ id: 4 }], [{ id: 4 }], [{ id: 4 }]],
  })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache } = createFakeCache<{ id: number }>()
  const methods = service.buildMethods<{ id: number }, { name: string }, { name: string }>(
    "users",
    cache,
  )

  await methods.findOne({ id: 4 })
  await methods.createOne({ data: { name: "created" } })
  await methods.updateOne({ id: 4, data: { name: "updated" } })
  await methods.deleteOne({ id: 4 })
  await methods.undeleteOne({ id: 4 })
  await methods.findChanged(new Date("2026-01-01T00:00:00Z"))

  assertEquals(fake.topLevel, [
    `SELECT * FROM "users" WHERE id = $1 AND deleted_at IS NULL`,
    `INSERT INTO "users" "name" = $1 RETURNING *`,
    `UPDATE "users" SET updated_at = NOW(), "name" = $1 WHERE id = $2 AND deleted_at IS NULL ` +
    `RETURNING *`,
    `UPDATE "users" SET updated_at = NOW(), deleted_at = NOW() WHERE id = $1 RETURNING *`,
    // `undeleteOne` keeps a statement of its own, and it is the one update that has to
    // reach a deleted row.
    `UPDATE "users" SET updated_at = NOW(), deleted_at = NULL WHERE id = $1 RETURNING *`,
    `SELECT * FROM "users" WHERE updated_at > $1 ORDER BY updated_at DESC`,
  ])
})

Deno.test("updateOne with no fields touches updated_at instead of building invalid SQL", async () => {
  const fake = createFakeSql({ answers: [[{ id: 4 }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache } = createFakeCache<{ id: number }>()
  const methods = service.buildMethods<{ id: number }, { name: string }, { name?: string }>(
    "users",
    cache,
  )

  // `sql({})` renders an empty column list, so the general form produced
  // `SET updated_at = NOW(), WHERE id = $1` and the server answered with a syntax error.
  await methods.updateOne({ id: 4, data: {} })
  await methods.updateOne({ id: 4, data: { name: undefined } })

  assertEquals(fake.topLevel, [
    `UPDATE "users" SET updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    `UPDATE "users" SET updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
  ])
})

/**
 * A fake server holding exactly one soft-deleted row.
 *
 * A statement carrying `deleted_at IS NULL` matches nothing; every other statement
 * matches the row. That is the difference the filter makes, and a queue of answers
 * cannot express it — with a queue, a `findOne` that forgot the filter still reads
 * `null` simply because the queue ran out.
 */
const DELETED_ROW = { id: 4, name: "deleted" }

function createServerHoldingADeletedRow() {
  return createFakeSql({
    answerFor: (query) => (query.includes("deleted_at IS NULL") ? [] : [DELETED_ROW]),
  })
}

Deno.test("a soft-deleted row read with the opt-out does not leak into the next plain read", async () => {
  const fake = createServerHoldingADeletedRow()
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, stored } = createFakeCache<{ id: number; name: string }>()
  const methods = service.buildMethods<{ id: number; name: string }, never, never>("users", cache)

  assertEquals(await methods.findOne({ id: 4, includeDeleted: true }), DELETED_ROW)

  assertStrictEquals(stored.has(4), false)
  assertStrictEquals(await methods.findOne({ id: 4 }), null)
})

Deno.test("an update cannot put a soft-deleted row back where a plain read finds it", async () => {
  const fake = createServerHoldingADeletedRow()
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, stored } = createFakeCache<{ id: number; name: string }>()
  const methods = service.buildMethods<{ id: number; name: string }, never, { name: string }>(
    "users",
    cache,
  )

  await methods.deleteOne({ id: 4 })
  // The update matches nothing, so it returns no row and writes nothing to the cache.
  // Without `AND deleted_at IS NULL` it matched the deleted row, returned it, and stored
  // it — and the next plain read then answered from the cache, where no filter applies.
  await methods.updateOne({ id: 4, data: { name: "resurrected" } })

  assertStrictEquals(stored.has(4), false)
  assertStrictEquals(await methods.findOne({ id: 4 }), null)
})

Deno.test("the includeDeleted read neither reads the cache nor writes to it", async () => {
  const fake = createFakeSql({ answers: [[{ id: 5, name: "deleted" }]] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache, calls, stored } = createFakeCache<{ id: number; name: string }>()
  const methods = service.buildMethods<{ id: number; name: string }, never, never>("users", cache)

  const row = await methods.findOne({ id: 5, includeDeleted: true })

  assertEquals(row, { id: 5, name: "deleted" })
  // No `wrap` and no `set`: a deleted row that entered the cache would be handed to the
  // next plain `findOne` as if it were live.
  assertEquals(calls, [])
  assertStrictEquals(stored.has(5), false)
  assertEquals(fake.topLevel, [`SELECT * FROM "users" WHERE id = $1`])
})

Deno.test("findOne reports a miss as null whether or not a transaction is open", async () => {
  const fake = createFakeSql({ answers: [[], []] })
  const service = new DbServiceBase({ sql: fake.sql })
  const { cache } = createFakeCache<{ id: number }>()

  const outside = await service.findOne(cache, 8, fake.sql`SELECT * FROM users WHERE id = ${8}`)
  const inside = await service.begin((tx) =>
    tx.findOne(cache, 9, fake.sql`SELECT * FROM users WHERE id = ${9}`)
  )

  // It used to be `undefined` outside a transaction and `null` inside one, although the
  // declared return type said `null | T` on both paths.
  assertStrictEquals(outside, null)
  assertStrictEquals(inside, null)
})
