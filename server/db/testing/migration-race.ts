/**
 * A rendezvous that makes "two migration runners started together" deterministic.
 *
 * This file is a **test helper**, not part of the package's public surface. It sits in
 * `server/db/testing/`, which `deno.jsonc`'s `publish.exclude` keeps out of the package.
 *
 * The race `runMigrations` has to survive is two runners that both read an empty history
 * before either of them writes to it. Started with nothing between them, whether they
 * reach that state is a matter of which round trip finishes first, so a test written that
 * way passes against unlocked code most of the time and proves nothing. The helper forces
 * the state instead, and does it without deadlocking the locked code:
 *
 *  - every runner's reader waits at a barrier in `list`, which `runMigrations` calls
 *    *after* it has read the history;
 *  - the barrier opens once every runner is accounted for — either standing at it, or
 *    blocked outside the lock waiting for its turn.
 *
 * With a working lock the second runner is blocked outside, so the first is let through
 * at once, finishes, and the second then reads the history the first wrote and skips.
 * Without a lock both stand at the barrier, it opens, and both apply everything. One
 * arrangement, both outcomes, and no sleeping.
 */

import type { MigrationDriver, MigrationReader } from "../migrate.ts"

/** What {@link migrationRace} hands a test. */
export interface MigrationRace {
  /** Wrap each runner's driver, so runners waiting for the lock can be counted. */
  gate: (driver: MigrationDriver) => MigrationDriver
  /** The reader every runner in the race shares. */
  reader: MigrationReader
}

/**
 * A race between `runners` migration runners over `files`.
 *
 * Every runner must use both halves: `gate` around its driver and `reader` as its
 * reader. A runner that uses only one of them is not counted and the barrier never
 * opens.
 */
export function migrationRace(files: Record<string, string>, runners: number): MigrationRace {
  let atBarrier = 0
  let waitingForLock = 0
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  /**
   * Open once every runner is accounted for and at least one has reached the barrier.
   *
   * The second half is not decoration. `Promise.all` calls every runner before any of
   * them has done more than one `await`, so for a moment they are all counted as waiting
   * for the lock and none has read anything yet; opening there would release the barrier
   * before it had held anybody, and the test would be back to the race it exists to
   * remove.
   */
  const maybeOpen = (): void => {
    if (atBarrier >= 1 && atBarrier + waitingForLock >= runners) open()
  }

  return {
    gate: (driver: MigrationDriver): MigrationDriver => ({
      withLock: async <T>(run: () => Promise<T>): Promise<T> => {
        waitingForLock += 1
        maybeOpen()
        try {
          return await driver.withLock(async () => {
            // Inside the lock now, so this runner is no longer one of the blocked ones.
            waitingForLock -= 1
            try {
              return await run()
            } finally {
              // Put it back before the lock is handed on, so the count stays balanced
              // for the `finally` below whichever way the run ended.
              waitingForLock += 1
            }
          })
        } finally {
          waitingForLock -= 1
        }
      },
      createHistoryTable: () => driver.createHistoryTable(),
      appliedMigrations: () => driver.appliedMigrations(),
      applyInTransaction: (migration) => driver.applyInTransaction(migration),
      applyWithoutTransaction: (migration) => driver.applyWithoutTransaction(migration),
    }),
    reader: {
      list: async () => {
        atBarrier += 1
        maybeOpen()
        await opened
        return Object.keys(files)
      },
      readText: (_folder: string, fileName: string) => {
        const text = files[fileName]
        return text === undefined
          ? Promise.reject(new Error(`no such migration: ${fileName}`))
          : Promise.resolve(text)
      },
    },
  }
}
