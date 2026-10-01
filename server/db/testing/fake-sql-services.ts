/**
 * The recording `Sql` fake the service-base tests run on, kept in its own file so
 * `sql-contract.test.ts` can hold it to the real client. Test-only: not exported from the
 * package and excluded from publishing with the rest of `testing/`.
 */

import type { Sql, Transaction } from "../ports.ts"

/**
 * What awaiting `sql("users")` or `sql({ name })` does in the driver: both are thenable and throw,
 * because a value to splice is not a query.
 */
function notTaggedCall(): never {
  throw new Error("NOT_TAGGED_CALL: Query not called as a tagged template literal")
}

/** Options for {@link createFakeSql}. */
export interface FakeSqlOptions {
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
  then(): never
}

/** A value `postgres` splices in as a column list. */
interface FakeColumnList {
  __columns: Record<string, unknown>
  then(): never
}

/**
 * A recorder that mimics `postgres`'s tagged template for the calls this package makes.
 *
 * `topLevel` holds statements issued on the client, plus `BEGIN`/`ROLLBACK`/`COMMIT`/
 * `end(5)` markers; `inner` holds statements issued on a transaction handle, in order,
 * which is what proves `begin` swapped the executor the callback writes through.
 */
export function createFakeSql(options: FakeSqlOptions = {}) {
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
          ? { __identifier: strings, then: notTaggedCall } satisfies FakeIdentifier
          : {
            __columns: strings as Record<string, unknown>,
            then: notTaggedCall,
          } satisfies FakeColumnList
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
    // The driver's reserved connection: the call forms and helpers of a handle, plus `release`,
    // and none of the pool-only `begin`, `reserve`, `listen` and `end`.
    reserve: function (): Promise<unknown> {
      topLevel.push("reserve()")
      return Promise.resolve(Object.assign(makeTag(), makeSqlHelpers(), { release: () => {} }))
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
