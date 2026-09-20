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

import { assertEquals, assertStrictEquals } from "@std/assert"
import type { RowCache, Sql, Transaction } from "./ports.ts"
import { DbServiceBase } from "./services.ts"

/** Options for {@link createFakeSql}. */
interface FakeSqlOptions {
  /** Statements that should reject instead of answering, matched by substring. */
  failOn?: string[]
  /** Answers, drained from the front. A missing entry answers no rows. */
  answers?: unknown[][]
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
    return Promise.resolve(answers.shift())
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

  const transaction = Object.assign(statement, {
    begin: <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      inner.push("SAVEPOINT")
      return Promise.resolve(callback(transaction as unknown as Transaction))
    },
  })

  const client = Object.assign(asTag, {
    begin: <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      topLevel.push(inTransaction ? "BEGIN NESTED" : "BEGIN")
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

Deno.test("a nested begin opens a savepoint through the transaction", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  await service.begin(async (tx) => {
    await tx.begin(async (innerTx) => {
      await innerTx.select(2)
    })
  })

  // A nested call reaches `this.client.begin`, and a `BEGIN` that arrives inside a
  // transaction is the savepoint `postgres` opens there — the fake labels that as
  // `BEGIN NESTED`, and the point is that it does not open a second client transaction.
  // The callback then writes through the clone, whose executor is still the transaction.
  assertEquals(fake.topLevel, ["BEGIN", "BEGIN NESTED", "COMMIT", "COMMIT"])
  assertEquals(fake.inner, ["SELECT $1"])
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
    `SELECT * FROM "users" WHERE id = $1`,
    `INSERT INTO "users" "name" = $1 RETURNING *`,
    `UPDATE "users" SET updated_at = NOW(), "name" = $1 WHERE id = $2 RETURNING *`,
    `UPDATE "users" SET updated_at = NOW(), deleted_at = NOW() WHERE id = $1 RETURNING *`,
    `UPDATE "users" SET updated_at = NOW(), deleted_at = NULL WHERE id = $1 RETURNING *`,
    `SELECT * FROM "users" WHERE updated_at > $1 ORDER BY updated_at DESC`,
  ])
})
