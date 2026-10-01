// What the database tests rely on from a `Sql` client, written once and run against both kinds of
// object: `sql-fakes.test.ts` runs it on the two fake clients in the unit tier, and
// `sql-contract.integration.test.ts` runs it on a real `postgres` client against the Postgres
// container. The migration and service tests are written against the fakes, so a claim a fake gets
// wrong here is a claim those tests get wrong too.
//
// Two suites, because the two fakes claim different things. The handle suite is the shape of the
// pool, a transaction and a reserved connection, which both fakes copy from the driver. The lock
// suite is what the migration driver reads from the server: the advisory lock, the schema probe and
// `.values()` rows, which only the migration fake answers.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs one of the
// `describe…` functions.

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { Sql } from "./ports.ts"

/** A client and how to dispose of it. */
export interface SqlFixture {
  sql: Sql
  close(): Promise<void>
}

/** A client plus a second session that can hold an advisory lock. */
export interface SqlLockFixture extends SqlFixture {
  /** Makes another session take the lock for `key`, so a try-lock from `sql` is refused. */
  holdLockElsewhere(key: bigint): Promise<void>
  /** Lets that session give the lock back. */
  releaseLockElsewhere(key: bigint): Promise<void>
}

/** Opens a fresh fixture for one case. */
export type OpenSql<F extends SqlFixture> = () => Promise<F>

/** Runs `body` on a fresh fixture and closes it, whether the body passed or not. */
async function withFixture<F extends SqlFixture>(
  open: OpenSql<F>,
  body: (fixture: F) => Promise<void>,
): Promise<void> {
  const fixture = await open()
  try {
    await body(fixture)
  } finally {
    await fixture.close()
  }
}

/** A thing that has a property of this name, whatever its type. */
function has(value: unknown, name: string): boolean {
  return (typeof value === "function" || typeof value === "object") && value !== null &&
    name in value
}

/** Whether `value` is a promise-like: it has a `then` function. */
function isThenable(value: unknown): boolean {
  return has(value, "then") && typeof (value as { then: unknown }).then === "function"
}

/** The rows of a `.values()` query as plain positional arrays, which is how the driver reads them. */
async function positional(query: { values(): PromiseLike<unknown> }): Promise<unknown[][]> {
  return (await query.values() as unknown[][]).map((row) => [...row])
}

/** The helpers every handle carries, pool and transaction alike. */
const SHARED_HELPERS = ["unsafe", "file", "json", "array", "notify", "types", "typed"]

/** What one fake claims of the driver's handles. */
export interface HandleSurface {
  /**
   * `true` when the client copies the driver's whole set of helpers (`file`, `json`, `array`,
   * `notify`, `types`, `typed`, `listen`, `savepoint`, `prepare`). A client that models only
   * tagged templates, `unsafe`, `begin`, `reserve` and `end` passes `false` and is not asked for
   * more than it claims.
   */
  full: boolean
}

/** Registers the handle-shape suite for one client. */
export function describeSqlHandleContract(
  name: string,
  open: OpenSql<SqlFixture>,
  surface: HandleSurface,
): void {
  const member = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key]

  describe(`${name} (sql handle contract)`, () => {
    it("the pool carries begin, reserve, end and unsafe", async () => {
      await withFixture(open, ({ sql }) => {
        for (const key of ["begin", "reserve", "end", "unsafe"]) {
          assertStrictEquals(typeof member(sql, key), "function", key)
        }
        return Promise.resolve()
      })
    })

    it("a transaction handle has unsafe but no begin, reserve or end", async () => {
      await withFixture(open, async ({ sql }) => {
        await sql.begin((tx) => {
          assertStrictEquals(typeof member(tx, "unsafe"), "function")
          for (const key of ["begin", "reserve", "end"]) {
            assertStrictEquals(has(tx, key), false, key)
          }
          return Promise.resolve()
        })
      })
    })

    it("begin resolves with the callback's value", async () => {
      await withFixture(open, async ({ sql }) => {
        assertStrictEquals(await sql.begin(() => Promise.resolve(42)), 42)
      })
    })

    it("begin rejects with the very error the callback threw, and the pool still works after", async () => {
      await withFixture(open, async ({ sql }) => {
        const boom = new Error("boom")
        const caught = await assertRejects(() => sql.begin(() => Promise.reject(boom)))
        assertStrictEquals(caught, boom)
        assertStrictEquals(await sql.begin(() => Promise.resolve("again")), "again")
      })
    })

    it("a reserved connection has release and unsafe and no begin or reserve", async () => {
      await withFixture(open, async ({ sql }) => {
        const reserved = await sql.reserve()
        try {
          assertStrictEquals(typeof reserved.release, "function")
          assertStrictEquals(typeof reserved.unsafe, "function")
          for (const key of ["begin", "reserve"]) {
            assertStrictEquals(has(reserved, key), false, key)
          }
        } finally {
          reserved.release()
        }
      })
    })

    it("a template is a promise, and awaiting sql(name) or sql({ column }) throws", async () => {
      await withFixture(open, async ({ sql }) => {
        const query = sql`SELECT 1`
        assertStrictEquals(isThenable(query), true)
        await query
        await assertRejects(
          async () => await (sql("users") as unknown as PromiseLike<unknown>),
          Error,
          "NOT_TAGGED_CALL",
        )
        await assertRejects(
          async () => await (sql({ name: "a" }) as unknown as PromiseLike<unknown>),
          Error,
          "NOT_TAGGED_CALL",
        )
      })
    })

    if (!surface.full) return

    it("the pool carries listen and the shared helpers", async () => {
      await withFixture(open, ({ sql }) => {
        for (const key of ["listen", ...SHARED_HELPERS]) {
          assertStrictEquals(typeof member(sql, key), "function", key)
        }
        return Promise.resolve()
      })
    })

    it("a transaction handle has savepoint, prepare and the shared helpers but no listen", async () => {
      await withFixture(open, async ({ sql }) => {
        await sql.begin((tx) => {
          for (const key of ["savepoint", "prepare", ...SHARED_HELPERS]) {
            assertStrictEquals(typeof member(tx, key), "function", key)
          }
          assertStrictEquals(has(tx, "listen"), false)
          return Promise.resolve()
        })
      })
    })

    it("json, array and notify are the pool's own functions on a transaction, unsafe and file are not", async () => {
      await withFixture(open, async ({ sql }) => {
        await sql.begin((tx) => {
          for (const shared of ["json", "array", "notify"]) {
            assertStrictEquals(member(tx, shared), member(sql, shared), shared)
          }
          for (const own of ["unsafe", "file"]) {
            assertStrictEquals(member(tx, own) === member(sql, own), false, own)
          }
          return Promise.resolve()
        })
      })
    })

    it("unsafe can be constructed and prepare cannot", async () => {
      await withFixture(open, async ({ sql }) => {
        assertStrictEquals(has(sql.unsafe, "prototype"), true)
        await sql.begin((tx) => {
          assertStrictEquals(has(tx.prepare, "prototype"), false)
          return Promise.resolve()
        })
      })
    })
  })
}

/** Registers the lock, schema-probe and `.values()` suite for one client. */
export function describeSqlLockContract(name: string, open: OpenSql<SqlLockFixture>): void {
  /** An advisory-lock key no other run shares, so concurrent worktrees never meet on it. */
  const freshKey = (): bigint => BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n

  describe(`${name} (sql lock contract)`, () => {
    it("a try-lock on a free key answers true, as one positional column", async () => {
      await withFixture(open, async ({ sql }) => {
        const key = freshKey()
        const reserved = await sql.reserve()
        try {
          const rows = await positional(reserved`SELECT pg_try_advisory_lock(${key}) AS locked`)
          assertEquals(rows, [[true]])
          await reserved`SELECT pg_advisory_unlock(${key})`
        } finally {
          reserved.release()
        }
      })
    })

    it("a try-lock is refused while another session holds the key, and granted once it lets go", async () => {
      await withFixture(open, async (fixture) => {
        const key = freshKey()
        const reserved = await fixture.sql.reserve()
        try {
          await fixture.holdLockElsewhere(key)
          assertEquals(
            await positional(reserved`SELECT pg_try_advisory_lock(${key}) AS locked`),
            [[false]],
          )
          await fixture.releaseLockElsewhere(key)
          assertEquals(
            await positional(reserved`SELECT pg_try_advisory_lock(${key}) AS locked`),
            [[true]],
          )
          await reserved`SELECT pg_advisory_unlock(${key})`
        } finally {
          reserved.release()
        }
      })
    })

    it("the schema probe answers one row with a non-empty schema name", async () => {
      await withFixture(open, async ({ sql }) => {
        const rows = await positional(sql`SELECT coalesce(NULL, current_schema()) AS schema`)
        assertStrictEquals(rows.length, 1)
        const [schema] = rows[0] as unknown[]
        assertStrictEquals(typeof schema, "string")
        assertStrictEquals((schema as string) !== "", true)
      })
    })

    it("a bare SELECT 1 answers one row of one column", async () => {
      await withFixture(open, async ({ sql }) => {
        assertEquals(await positional(sql`SELECT 1`), [[1]])
      })
    })
  })
}

/** How many try-locks {@link describeSqlLockRefusalContract} expects to be refused. */
export const LOCK_REFUSALS = 3

/**
 * Registers the case that a lock held for a number of attempts and then let go answers `false`
 * that many times, then `true`. This is what the migration fake's `lockRefusals` option stands
 * for, so the fake's fixture holds the lock for exactly {@link LOCK_REFUSALS} attempts through
 * that option and the real client's fixture holds it through a second session.
 */
export function describeSqlLockRefusalContract(
  name: string,
  open: OpenSql<SqlLockFixture>,
): void {
  describe(`${name} (sql lock refusal contract)`, () => {
    it("refuses a held try-lock, then grants it once the key is let go", async () => {
      await withFixture(open, async (fixture) => {
        const key = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n
        const reserved = await fixture.sql.reserve()
        try {
          await fixture.holdLockElsewhere(key)
          for (let attempt = 1; attempt <= LOCK_REFUSALS; attempt++) {
            assertEquals(
              await positional(reserved`SELECT pg_try_advisory_lock(${key}) AS locked`),
              [[false]],
              `attempt ${attempt} of ${LOCK_REFUSALS} while held`,
            )
          }
          await fixture.releaseLockElsewhere(key)
          assertEquals(
            await positional(reserved`SELECT pg_try_advisory_lock(${key}) AS locked`),
            [[true]],
          )
          await reserved`SELECT pg_advisory_unlock(${key})`
        } finally {
          reserved.release()
        }
      })
    })
  })
}
