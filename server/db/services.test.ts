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
import { ownedBy, reachableFrom } from "./testing/reachable.ts"

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
   * One call form, as the driver has it, built fresh for each handle.
   *
   * `sql` is a single callable used two ways: as a tag, and as `sql("users")` /
   * `sql({ name })`, which render a value for a later template. Measured against
   * `postgres@3.4.7`: `sql("users")` returns an `Identifier`, not a promise and not the
   * string, so the fake has to make the same distinction by looking for a template
   * strings array.
   *
   * **Written as a `function`, not an arrow**, and so is every callable this fake hands
   * out except `prepare`. `postgres` declares them the same way, which makes them
   * constructible, and `new sql.unsafe(...)` was a live route past the scope check for
   * exactly that reason. An arrow-function fake cannot be constructed at all, so it
   * reported the route closed while the driver's own shape left it open. `prepare` is an
   * arrow in the driver (`postgres@3.4.7/src/index.js:253`), so it is one here too.
   *
   * A fresh function per handle, because `postgres` builds one per `Sql(handler)` call:
   * the root client's tag and a transaction's tag are two different function objects.
   */
  const makeTag = () =>
    function (strings: unknown, ...values: unknown[]): unknown {
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

  /**
   * `sql.types` / `sql.typed`, as `postgres` builds them.
   *
   * A function that also carries one named helper per custom type the caller registered
   * (`postgres@3.4.7/src/index.js:86-102`). `shout` stands in for such a helper. Built
   * per handle, because `typed` is declared inside `Sql(handler)` and is therefore a
   * different function on the client and on a transaction handle.
   */
  const makeCustomTypes = () =>
    Object.assign(
      function (value: unknown): unknown {
        return { __typed: value }
      },
      {
        shout: function (value: string): unknown {
          return { __shout: value.toUpperCase() }
        },
      },
    )

  /**
   * The helpers `Sql(handler)` puts on every handle, client and transaction alike.
   *
   * `unsafe`, `file` and the type helpers are declared inside `Sql` in the driver, so each
   * handle gets its own; `json`, `array` and `notify` are declared once in the enclosing
   * `Postgres()` scope and are therefore literally shared between the client and every
   * transaction handle (`postgres@3.4.7/src/index.js:84-101,199,318-326`). The fake copies
   * that split, because the graph-walk test asks which values a handle owns.
   */
  const makeSqlHelpers = () => {
    const customTypes = makeCustomTypes()
    return {
      unsafe: function (text: string): Promise<unknown> {
        return execute(text, (it) => (inTransaction ? inner : topLevel).push(it))
      },
      file: function (path: string): Promise<unknown> {
        return execute(`file(${path})`, (it) => (inTransaction ? inner : topLevel).push(it))
      },
      json: sharedJson,
      array: sharedArray,
      notify: sharedNotify,
      // `types` and `typed` are the driver's own shape: a *function* carrying one helper
      // per custom type the caller registered. A wrapper that replaced functions with
      // plain arrows lost `shout` here, and `sql.types.shout(...)` became a TypeError
      // inside a transaction.
      types: customTypes,
      typed: customTypes,
    }
  }

  const sharedJson = function (value: unknown): unknown {
    return { __json: value }
  }
  const sharedArray = function (value: unknown[]): unknown {
    return { __array: value }
  }
  const sharedNotify = async function (channel: string, payload: string): Promise<unknown> {
    return await execute(
      `pg_notify(${channel}, ${payload})`,
      (it) => (inTransaction ? inner : topLevel).push(it),
    )
  }

  /**
   * The transaction handle, carrying the properties the real one carries and no others.
   *
   * Measured against `postgres@3.4.7` and a real server (#115), a transaction handle's own
   * keys are `length`, `name`, `prototype`, `types`, `typed`, `unsafe`, `notify`, `array`,
   * `json`, `file`, `savepoint` and `prepare`. It has **no `begin`, no `reserve` and no
   * `listen`** — those are assigned to the root client alone (`src/index.js:69-82`), and
   * calling one on a transaction handle is a plain `TypeError`. An earlier version of this
   * fake carried `begin` and `reserve` here and a comment claiming the driver does too,
   * which put two call forms nobody can write into `services.ts`'s list of refusals.
   *
   * `savepoint` is recorded in `inner`, because a savepoint is a statement on the
   * connection the transaction already holds.
   */
  const transaction = Object.assign(makeTag(), {
    savepoint: function <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
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
    // An arrow, as in the driver, which is why it is the one callable here that cannot be
    // constructed and carries no `prototype`.
    prepare: (name: string): string => {
      inner.push(`prepare(${name})`)
      return name
    },
    ...makeSqlHelpers(),
  })

  /**
   * The root client: the same `Sql(handler)` helpers plus the four the pool alone carries.
   *
   * `begin`, `reserve`, `listen` and `end` live here and nowhere else, which is what makes
   * `tx.begin(...)` a `TypeError` against the real driver.
   */
  const client = Object.assign(makeTag(), {
    begin: function <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
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
    reserve: async function (): Promise<unknown> {
      topLevel.push("reserve()")
      return await Promise.resolve(client)
    },
    listen: async function (channel: string): Promise<unknown> {
      topLevel.push(`listen(${channel})`)
      return await Promise.resolve({ unlisten: () => Promise.resolve() })
    },
    end: function (endOptions?: { timeout?: number }): Promise<void> {
      topLevel.push(`end(${endOptions?.timeout ?? ""})`)
      return Promise.resolve()
    },
    ...makeSqlHelpers(),
  })

  return {
    sql: client as unknown as Sql,
    /**
     * The raw transaction handle, for the graph walk.
     *
     * The client no longer leads to it: the two are separate function objects now, as they
     * are in the driver, so a reference set built from `sql` alone holds none of the
     * functions that send a statement on a transaction.
     */
    handle: transaction,
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

  /** The executor this instance writes through — the clone's wrapper, on a clone. */
  executor(): FakeExecutor {
    return this.sql as unknown as FakeExecutor
  }
}

/**
 * The transaction-handle surface {@link createFakeSql} offers, as the scope tests reach
 * for it.
 *
 * It lists what a `postgres@3.4.7` transaction handle actually carries. `begin`, `reserve`
 * and `listen` are absent because the driver's handle does not have them (#115).
 */
interface FakeExecutor {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  (identifier: string): unknown
  unsafe(text: string): Promise<unknown>
  file(path: string): Promise<unknown>
  json(value: unknown): unknown
  array(value: unknown[]): unknown
  notify(channel: string, payload: string): Promise<unknown>
  prepare(name: string): string
  savepoint<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>
  types: { (value: unknown): unknown; shout(value: string): unknown }
  typed: { (value: unknown): unknown; shout(value: string): unknown }
}

/**
 * The own keys of a `postgres@3.4.7` transaction handle, measured against a real server.
 *
 * `length`, `name` and `prototype` are what any ordinary function carries; the rest is what
 * `Sql(handler)` assigns plus the `savepoint` and `prepare` that `scope` adds
 * (`postgres@3.4.7/src/index.js:84-101,251-254`). `begin`, `reserve` and `listen` are not
 * here: they are assigned to the root client alone (`src/index.js:69-82`).
 *
 * `services.integration.test.ts` asserts this same list against the driver itself, so a
 * driver upgrade that changes the shape turns that test red instead of leaving this fake
 * quietly describing a handle nobody has (#115).
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

/** A template strings array, for the `new sql(template)` route. */
function fakeTemplate(text: string): TemplateStringsArray {
  return Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray
}

/**
 * Every way a caller can reach the driver through the clone's executor and get an answer.
 *
 * Table-driven on purpose. The `Proxy` exists so that a property nobody listed cannot
 * become a way around the check, and a test that named only `savepoint` could not show
 * that: letting `unsafe` through the `get` trap unchecked left both tiers green.
 *
 * Every form here works while the clone is live and is refused once it is not, which is
 * why one table drives both tests. Construction is the exception and has a table of its
 * own; see {@link constructForms}.
 */
function callForms(sql: FakeExecutor): Array<[string, () => unknown]> {
  return [
    ["tagged template", () => sql`SELECT ${1}`],
    ["identifier helper", () => sql("users")],
    ["unsafe", () => sql.unsafe("SELECT 1")],
    ["file", () => sql.file("/migrations/0001.sql")],
    ["json", () => sql.json({ a: 1 })],
    ["array", () => sql.array([1, 2])],
    ["notify", () => sql.notify("channel", "payload")],
    ["prepare", () => sql.prepare("tx1")],
    ["savepoint", () => sql.savepoint(() => Promise.resolve(undefined))],
    ["a custom type helper", () => sql.types.shout("hello")],
    ["the typed alias of the same helper", () => sql.typed.shout("hello")],
    [
      "a property descriptor's own value",
      () => {
        const descriptor = Object.getOwnPropertyDescriptor(sql, "unsafe")
        return (descriptor?.value as (text: string) => unknown)("SELECT 1")
      },
    ],
  ]
}

/**
 * Every way the review found to reach the driver through a `prototype` object.
 *
 * Its own table because none of these is a call on the handle or on something read off it:
 * each one walks to the `prototype` object every ordinary function carries and takes the
 * `constructor` back off it, which is the function itself. All six wrote a row after the
 * transaction had ended, reported success, and lost it to the next rollback.
 */
function prototypeForms(sql: FakeExecutor): Array<[string, () => unknown]> {
  const raw = sql as unknown as Record<string, Raw>
  return [
    ["sql.prototype.constructor", () => raw.prototype.constructor(fakeTemplate("SELECT 1"))],
    [
      "sql.prototype.constructor.unsafe",
      () => raw.prototype.constructor.unsafe("SELECT 1"),
    ],
    ["unsafe.prototype.constructor", () => raw.unsafe.prototype.constructor("SELECT 1")],
    [
      "savepoint.prototype.constructor",
      () => raw.savepoint.prototype.constructor(() => Promise.resolve(undefined)),
    ],
    [
      "a descriptor's prototype value, then its constructor",
      () => Object.getOwnPropertyDescriptor(raw.unsafe, "prototype")?.value.constructor("SELECT 1"),
    ],
    [
      "types.prototype.constructor",
      () => raw.types.prototype.constructor("hello"),
    ],
  ]
}

/** The untyped view the prototype walk needs; every step of it is a property read. */
// deno-lint-ignore no-explicit-any
type Raw = any

/**
 * Every way to reach the driver through `new`.
 *
 * Apart on purpose: these are refused whether the clone is live or not, so they cannot
 * join {@link callForms}, which every live test expects to succeed. A `TypeError` while
 * the clone is live, {@link PostgresScopeEndedError} once it is not.
 */
function constructForms(sql: FakeExecutor): Array<[string, () => unknown]> {
  return [
    [
      "new on unsafe",
      () => new (sql.unsafe as unknown as new (text: string) => unknown)("SELECT 1"),
    ],
    ["new on the handle itself", () =>
      new (sql as unknown as new (s: unknown) => unknown)(
        fakeTemplate("SELECT 1"),
      )],
    [
      "Reflect.construct on unsafe",
      () => Reflect.construct(sql.unsafe as unknown as new (text: string) => unknown, ["SELECT 1"]),
    ],
    [
      "Reflect.construct on the handle itself",
      () =>
        Reflect.construct(sql as unknown as new (s: unknown) => unknown, [
          fakeTemplate("SELECT 1"),
        ]),
    ],
  ]
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

Deno.test("the fake transaction handle carries the driver's own keys and no others", () => {
  // The fake is the shape a contributor reads to learn the driver's surface. It used to
  // offer `begin` and `reserve` on the transaction handle, with a comment saying the
  // driver does too, and that put two call forms nobody can write into the list of
  // refusals `services.ts` documents (#115).
  const fake = createFakeSql()

  assertEquals(
    [...Reflect.ownKeys(fake.handle)].map(String).sort(),
    [
      ...TRANSACTION_HANDLE_KEYS,
    ].sort(),
  )

  for (const clientOnly of ["begin", "reserve", "listen", "end"]) {
    assertStrictEquals(
      clientOnly in fake.handle,
      false,
      `the transaction handle must not carry ${clientOnly}`,
    )
    assertStrictEquals(
      typeof (fake.sql as unknown as Record<string, unknown>)[clientOnly],
      "function",
      `the client must carry ${clientOnly}`,
    )
  }

  // The client and the handle are two objects, as they are in the driver.
  assertStrictEquals(fake.sql as unknown === fake.handle, false)
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

Deno.test("every call form through a kept clone is refused, not only the ones we thought of", async () => {
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await service.begin((tx) => {
    kept = tx
    return Promise.resolve()
  })
  assertExists(kept)
  const sql = kept.executor()

  for (
    const [name, call] of [...callForms(sql), ...constructForms(sql), ...prototypeForms(sql)]
  ) {
    assertThrows(call, PostgresScopeEndedError, undefined, `${name} was not refused`)
  }
  // Nothing reached the driver: neither the transaction that ended nor the client.
  assertEquals(fake.inner, [])
  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
})

Deno.test("reads off the clone's executor never give back the fake's own function or object", async () => {
  // A regression test over the property graph, and the reason it is a walk rather than a
  // list: round 3 of the review found `sql.prototype.constructor`, which no list of call
  // forms had, because every ordinary function carries a `prototype` object whose
  // `constructor` is the function itself. A list can only ever cover the routes somebody
  // thought of. It covers *reads* only; what a call returns is left as the driver built
  // it on purpose, and the route that opens is listed on `PostgresScopeEndedError`.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let walk: ReturnType<typeof reachableFrom> | undefined
  await service.begin((tx) => {
    walk = reachableFrom(tx.executor())
    return Promise.resolve()
  })

  assertExists(walk)
  assertStrictEquals(walk.truncated, false, "the walk hit its limit instead of finishing")
  assertEquals(walk.refused, [], "a read refused while the clone was live")

  // Everything the raw fake owns, minus what any function at all can reach: the fake's own
  // tags, `unsafe`, `file`, `json`, `array`, `notify`, `savepoint`, `prepare`, the type
  // helpers and every object hanging off them.
  //
  // Both roots, and that is not tidiness. The client and the transaction handle are two
  // separate function objects, as they are in the driver, so a set built from `fake.sql`
  // alone holds none of the functions that send a statement on *this* transaction — and a
  // leak of one of those is exactly what this test is for.
  const driverOwned = ownedBy(fake.sql, fake.handle)
  assertStrictEquals(driverOwned.size > 0, true, "the fake owns nothing, so this proves nothing")

  const leaked = [...walk.values].filter((value) => driverOwned.has(value))
  assertEquals(
    leaked.map((value) => (typeof value === "function" ? value.name || "anonymous" : "object")),
    [],
    "a read off the handle gave back something the fake owns",
  )
})

Deno.test("a property descriptor taken while the clone was live dies with it", async () => {
  // Reading the descriptor early used to be the way to keep the driver's own function
  // rather than the wrapper, so the check was gone before the transaction was.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let kept: PropertyDescriptor | undefined
  await service.begin((tx) => {
    kept = Object.getOwnPropertyDescriptor(tx.executor(), "unsafe")
    return Promise.resolve()
  })

  assertExists(kept)
  assertThrows(
    () => (kept!.value as (text: string) => unknown)("SELECT 1"),
    PostgresScopeEndedError,
  )
  assertEquals(fake.inner, [])
})

Deno.test("a getter planted on a live clone runs with the wrapper as this, not the raw handle", async () => {
  // A read through the wrapper must not be a way to obtain the handle the wrapper stands
  // in for. `Reflect.get` without a receiver runs an accessor with the *target* as `this`,
  // so a getter planted through the live clone was handed the driver's own handle and
  // could write through it after the transaction had ended.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  let receiver: unknown
  let kept: TestService | undefined
  await service.begin((tx) => {
    const sql = tx.executor() as unknown as Record<string, unknown>
    Object.defineProperty(sql, "planted", {
      get: function (this: unknown): number {
        receiver = this
        return 1
      },
      configurable: true,
    })
    void sql.planted
    kept = tx
    return Promise.resolve()
  })

  // Not the driver's handle, and not something that still works after the scope: the
  // receiver is this scope's wrapper, so every call through it is checked like any other.
  assertStrictEquals(receiver === fake.handle, false, "the getter received the raw handle")
  assertExists(kept)
  assertStrictEquals(receiver, kept!.executor())
  assertThrows(
    () => (receiver as { unsafe: (text: string) => unknown }).unsafe("SELECT 1"),
    PostgresScopeEndedError,
  )
})

Deno.test("a property the engine will not let the wrapper stand in for is refused after the scope", async () => {
  // The one shape the wrapper cannot serve: a non-configurable, non-writable own data
  // property has to be read back as the target's own value, so a proxy that answered with
  // a wrapper would get a `TypeError` from the engine instead of refusing on its own
  // terms. No property of a driver function is shaped that way — `length` and `name` are
  // configurable, `prototype` is writable — so this builds one to pin what happens.
  const fake = createFakeSql()
  // On the transaction handle, because that is what the clone's executor wraps.
  Object.defineProperty(fake.handle, "frozenHelper", {
    value: (): string => "the driver's own function",
    writable: false,
    enumerable: false,
    configurable: false,
  })
  const service = new TestService({ sql: fake.sql })

  let kept: TestService | undefined
  await service.begin((tx) => {
    const sql = tx.executor() as unknown as Record<string, unknown>
    // While live it is handed over unwrapped, which is what the caller would have had
    // without the clone at all. That is the limit, written down rather than implied.
    assertStrictEquals(typeof sql.frozenHelper, "function")
    assertStrictEquals(
      Object.getOwnPropertyDescriptor(sql, "frozenHelper")?.value,
      sql.frozenHelper,
    )
    kept = tx
    return Promise.resolve()
  })

  assertExists(kept)
  const retired = kept!.executor() as unknown as Record<string, unknown>
  assertThrows(() => retired.frozenHelper, PostgresScopeEndedError)
  assertThrows(
    () => Object.getOwnPropertyDescriptor(retired, "frozenHelper"),
    PostgresScopeEndedError,
  )
})

Deno.test("every call form works while the clone is still live", async () => {
  // The other half of the same table, walked rather than sampled. A wrapper that refused
  // everything would pass the test above and be useless, and the custom type helper is
  // the one that was actually lost: replacing each function with a plain arrow threw away
  // the properties it carried, so `sql.types.shout` did not exist inside a transaction
  // although it does outside one.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  await service.begin(async (tx) => {
    const sql = tx.executor()
    for (const [name, call] of callForms(sql)) {
      let answer: unknown
      try {
        answer = call()
      } catch (error) {
        throw new Error(`${name} threw while the clone was live: ${String(error)}`)
      }
      // Several of these are queries; awaiting them keeps the fake's recording in order
      // and leaves nothing pending behind the test.
      if (answer instanceof Promise) await answer
    }

    // The values the wrapper has to carry through unchanged, spelled out.
    assertEquals(sql.types.shout("hello"), { __shout: "HELLO" })
    assertEquals(sql.typed.shout("hello"), { __shout: "HELLO" })
    assertEquals(sql.json({ a: 1 }), { __json: { a: 1 } })
    assertEquals(sql("users"), { __identifier: "users" })
    // Reading the same helper twice gives the same function, so an identity comparison
    // still holds through the wrapper.
    assertStrictEquals(sql.types.shout, sql.types.shout)
    // And the descriptor read hands out the wrapper, not the driver's own function.
    assertStrictEquals(Object.getOwnPropertyDescriptor(sql, "unsafe")?.value, sql.unsafe)
  })
})

Deno.test("construction through a live clone is refused as well, by name", async () => {
  // `postgres` exposes no constructor. `new sql.unsafe(...)` runs the statement only
  // because any plain function can be constructed, so it is refused outright rather than
  // passed through and checked — one rule, and no route that exists only after the scope.
  const fake = createFakeSql()
  const service = new TestService({ sql: fake.sql })

  await service.begin((tx) => {
    for (const [name, call] of constructForms(tx.executor())) {
      assertThrows(call, TypeError, "is not a constructor", `${name} was not refused`)
    }
    return Promise.resolve()
  })

  assertEquals(fake.inner, [])
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
