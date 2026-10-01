/**
 * The scripted `Sql` fake the Postgres migration driver tests run on, kept in its own file so
 * `sql-contract.test.ts` can hold it to the real client. Test-only: not exported from the
 * package and excluded from publishing with the rest of `testing/`.
 */

import type { Sql, Transaction } from "../ports.ts"

/** Options for {@link createFakeSql}. */
export interface FakeSqlOptions {
  /** Answers, drained from the front. A missing entry answers no rows. */
  answers?: unknown[][]
  /** Statement text that should reject when executed through `unsafe`. */
  failOn?: string
  /** What the server answers for the resolved-schema probe. Defaults to `public`. */
  currentSchema?: string
  /**
   * How many times `pg_try_advisory_lock` answers `false` before it answers `true`.
   *
   * Defaults to `0` — the lock is free. `Infinity` stands for a holder that never lets go,
   * which is what the bound is for.
   */
  lockRefusals?: number
  /**
   * The client's `transform.column.to`, which `sql(name)` applies on every handle of a real
   * client configured with `postgres.camel`: the pool, a reserved connection and a `begin`
   * callback's. Defaults to `undefined` — a plain client, no transform — which is what
   * every test not about {@link PostgresIdentifierTransformError} needs.
   */
  columnTransformTo?: (identifier: string) => string
}

/**
 * A recorder that renders `postgres` templates into a comparable string.
 *
 * `sql("migrations")` renders as a double-quoted identifier, as the driver does, and every
 * other value renders as `$1`, `$2`, …. Identifiers are recognised by the marker the
 * `sql(value)` call form returns, so the rendering does not depend on the statement text.
 *
 * A dot inside an identifier becomes a quoted separator, which is what the driver's own
 * `escapeIdentifier` does (`postgres@3.4.7/src/types.js:216`): `sql("public.migrations")`
 * is `"public"."migrations"`, not one identifier with a dot in its name. The driver is the
 * schema-qualified form's only implementation, so a fake that quoted the whole string
 * would assert SQL the driver never produces.
 *
 * **Statements are recorded per handle.** `topLevel` is the pool, `reserved` is the
 * connection `sql.reserve()` handed out, and `inner` is inside a `sql.begin` callback.
 * One list for all of them could not tell them apart, and the whole point of the lock is
 * that it is held on the same session the migrations run on: sending the advisory lock
 * through the pool instead left every assertion green.
 */
export function createFakeSql(options: FakeSqlOptions = {}) {
  const topLevel: string[] = []
  const inner: string[] = []
  const reserved: string[] = []
  const boundValues: unknown[] = []
  const answers = options.answers ?? []
  let inTransaction = false
  let reserves = 0
  let releases = 0
  let lockAttempts = 0
  let lockHeldElsewhere = false

  const render = (strings: TemplateStringsArray, values: unknown[]): string => {
    let text = strings[0]
    const bound: unknown[] = []
    for (let index = 0; index < values.length; index += 1) {
      const tail = strings[index + 1]
      const value = values[index]
      const identifier = identifierOf(value)
      if (identifier !== undefined) {
        text += `${identifier}${tail}`
      } else {
        bound.push(value)
        boundValues.push(value)
        text += `$${bound.length}${tail}`
      }
    }
    return text.trim().replace(/\s+/g, " ")
  }

  /** Which handle a statement went through. */
  type Handle = "pool" | "reserved"

  const record = (query: string, handle: Handle): void => {
    if (inTransaction) inner.push(query)
    else if (handle === "reserved") reserved.push(query)
    else topLevel.push(query)
  }

  /** One tag function over the shared recorder, bound to the handle it belongs to. */
  const makeTag = (handle: Handle) => {
    const statement = (strings: unknown, ...values: unknown[]): unknown => {
      if (!Array.isArray(strings)) {
        const name = options.columnTransformTo?.(String(strings)) ?? String(strings)
        return new FakeIdentifier(`"${name.replaceAll(`"`, `""`).replaceAll(".", `"."`)}"`)
      }
      const query = render(strings as unknown as TemplateStringsArray, values)
      record(query, handle)
      // `withLock`'s own statements — the #156 warm-up query included — answer
      // themselves and do not draw on the queue. A test scripts what its *driver
      // method* reads; padding the queue for statements the lock sends is a trap that
      // moves every answer along by one the moment the lock changes shape.
      if (query === "SELECT 1") return withValues(Promise.resolve([{ "?column?": 1 }]))
      if (query.includes("current_schema()")) {
        return withValues(Promise.resolve([{ schema: options.currentSchema ?? "public" }]))
      }
      // The lock attempt answers a row, as `pg_try_advisory_lock` does. `lockRefusals`
      // is how a test stands in for another runner holding it.
      if (query.includes("pg_try_advisory_lock")) {
        lockAttempts += 1
        const refused = lockHeldElsewhere || lockAttempts <= (options.lockRefusals ?? 0)
        return withValues(Promise.resolve([{ locked: !refused }]))
      }
      if (query.includes("pg_advisory_")) return withValues(Promise.resolve([]))
      return withValues(Promise.resolve(answers.shift() ?? []))
    }
    return Object.assign(
      statement as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
      {
        unsafe: (text: string) => {
          const query = text.trim().replace(/\s+/g, " ")
          record(query, handle)
          return options.failOn !== undefined && query.includes(options.failOn)
            ? Promise.reject(new Error(`fake sql rejects: ${query}`))
            : Promise.resolve([])
        },
      },
    )
  }

  const asTag = makeTag("pool")

  const client = Object.assign(asTag, {
    /**
     * `sql.reserve()`, as `postgres@3.4.7` really has it.
     *
     * The lock is a session lock, so the run has to happen on the connection the lock was
     * taken on — a fake without `reserve` would let `withLock` pass while the real driver
     * locked a session the run never used.
     *
     * **The reserved client has no `begin`.** `postgres@3.4.7` assigns `begin` to the pool
     * object alone (`src/index.js:68-81`) although `ReservedSql` is typed as inheriting
     * it, so calling it there is a `TypeError` at runtime and nothing at compile time. The
     * fake leaves it out for that reason: with `begin` on it, a driver that reached for it
     * would pass here and fail against the server.
     */
    reserve: () => {
      reserves += 1
      return Promise.resolve(
        Object.assign(makeTag("reserved"), {
          release: () => {
            releases += 1
          },
        }),
      )
    },
    begin: async <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      topLevel.push("BEGIN")
      inTransaction = true
      try {
        const result = await callback(makeTag("pool") as unknown as Transaction)
        topLevel.push("COMMIT")
        return result
      } catch (error) {
        topLevel.push("ROLLBACK")
        throw error
      } finally {
        inTransaction = false
      }
    },
    end: () => Promise.resolve(),
  })

  return {
    sql: client as unknown as Sql,
    topLevel,
    inner,
    reserved,
    boundValues,
    connections: () => ({ reserves, releases }),
    lockAttempts: () => lockAttempts,
    /** Stands in for another session holding the advisory lock, until it is set back to false. */
    setLockHeldElsewhere: (held: boolean): void => {
      lockHeldElsewhere = held
    },
  }
}

function identifierOf(value: unknown): string | undefined {
  return value instanceof FakeIdentifier ? value.value : undefined
}

/**
 * Attach `.values()` to a fake query's result promise, the way `postgres@3.4.7` attaches it
 * to a real one — `.values()` resolves to each row rendered as a plain array of its values,
 * in the order the row's own keys were set, rather than as the name-keyed object the rest of
 * this fake builds for convenience. The driver builds a `.values()` row positionally from the
 * wire in the first place and never consults a name at all (`src/connection.js:489,505-509`);
 * building it from a plain object's key order here is a faithful enough stand-in, because
 * every row this fake hands out is built with `{ ... }` object literals whose keys are written
 * in the query's own `SELECT` order.
 */
function withValues<T extends Promise<unknown[]>>(
  promise: T,
): T & { values(): Promise<unknown[][]> } {
  return Object.assign(promise, {
    values: () =>
      promise.then((rows) =>
        rows.map((row) => Array.isArray(row) ? row : Object.values(row as object))
      ),
  })
}

/** `postgres@3.4.7`'s `Identifier` (`src/types.js:44-48`): the quoted text, in `value`. */
class FakeIdentifier {
  constructor(readonly value: string) {}

  /** The driver's `Identifier` is thenable and throws when awaited: it is not a query. */
  then(): never {
    throw new Error("NOT_TAGGED_CALL: Query not called as a tagged template literal")
  }
}
