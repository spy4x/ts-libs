// A real `postgres` client held to the `Sql` contract the unit tier runs on the two fakes
// (`sql-fakes.test.ts`). Nothing here creates a table or a schema: the contract only asks about the
// shape of the handles and about advisory locks, and the lock keys are random per case and given back
// in the case's own `finally`.

import { postgresSettings, requireReachable } from "@integration-testing"
import { createSql } from "./postgres.ts"
import {
  describeSqlHandleContract,
  describeSqlLockContract,
  describeSqlLockRefusalContract,
  type SqlLockFixture,
} from "./sql-contract.test.ts"

describeSqlHandleContract("postgres", async () => {
  const settings = postgresSettings()
  await requireReachable(settings.address)
  const sql = createSql({ connection: settings.connection })
  return { sql, close: () => sql.end() }
}, { full: true })

/** A real client plus a second session that holds advisory locks. */
async function openLockFixture(): Promise<SqlLockFixture> {
  const settings = postgresSettings()
  await requireReachable(settings.address)
  const sql = createSql({ connection: settings.connection })
  const other = createSql({ connection: settings.connection, max: 1 })
  const held: bigint[] = []
  let session: Awaited<ReturnType<typeof other.reserve>> | undefined
  return {
    sql,
    holdLockElsewhere: async (key: bigint) => {
      session ??= await other.reserve()
      await session`SELECT pg_advisory_lock(${key})`
      held.push(key)
    },
    releaseLockElsewhere: async (key: bigint) => {
      await session!`SELECT pg_advisory_unlock(${key})`
      held.splice(held.indexOf(key), 1)
    },
    close: async () => {
      try {
        // A case that failed before it let go still gives the lock back.
        for (const key of held) await session!`SELECT pg_advisory_unlock(${key})`
      } finally {
        session?.release()
        await other.end()
        await sql.end()
      }
    },
  }
}

describeSqlLockContract("postgres", openLockFixture)
describeSqlLockRefusalContract("postgres", openLockFixture)
