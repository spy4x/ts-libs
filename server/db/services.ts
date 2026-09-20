/**
 * The Postgres service base class.
 *
 * Ported from `template/libs/server/db/+index.ts:26-213`, with the cache helpers
 * kept and the transaction helper reconciled against
 * `offer-lens/libs/db/mod.ts:38-65`.
 *
 * **Reconciliation.** Both sources have a `begin<T>()`, and they differ in two
 * ways. The template stores the client in a `protected sql` field and clones with
 * `Object.create(this)` plus a `protected setSql`; offer-lens stores it in a
 * `protected db` field and clones the same way, with a constructor that throws
 * when no client exists. The shapes are otherwise one mechanism, so this keeps the
 * template's shape and ports offer-lens's two improvements into it:
 *
 *  - `begin` recurses correctly. The template called `this.sql.begin(...)`, and a
 *    clone's `sql` is a transaction handle, which has no `begin` of its own —
 *    `postgres` opens a savepoint through `savepoint()` there instead. This calls
 *    `begin` on the *client* the instance was built with, so a nested `begin` lands
 *    on the client and opens a savepoint as `postgres` intends.
 *  - the clone is created through `Object.create(this)` and nothing else. Class
 *    fields, including `readonly` ones, do not survive that: a subclass must not
 *    keep per-instance state the callback depends on, and every field the clone
 *    reads must be assigned in the constructor or be a prototype member. That is
 *    documented rather than worked around — any fix that copied fields would have
 *    to know them, which a base class cannot.
 *
 * The cache helper set is the template's `findOne`, `createOne`, `updateOne`,
 * `deleteOne` and `buildMethods`, unchanged apart from `RowCache` replacing the
 * domain cache class. Two behaviours are deliberate and are the reason the
 * deferred-write machinery exists at all: inside a transaction, cache writes are
 * queued and run only after the transaction commits, so a rolled-back transaction
 * cannot leave a cache holding a row the database never stored; and a failed cache
 * write is logged, never thrown, because a cache that rejected a write must not
 * fail a query that already committed.
 */

import type postgres from "postgres"
import type { RowCache, Sql, Transaction } from "./ports.ts"

/** Configuration for {@link DbServiceBase}. */
export interface DbServiceBaseOptions {
  /** The client every method runs against. */
  sql: Sql
}

export class DbServiceBase {
  protected sql: Sql

  /** The client a nested `begin` opens through. Never reassigned. */
  private readonly client: Sql

  private pendingCacheOperations: Array<() => Promise<void>> | null = null

  constructor(options: DbServiceBaseOptions) {
    this.sql = options.sql
    this.client = options.sql
  }

  /** Point this instance, or a transaction clone, at another executor. */
  protected setSql(sql: Sql): void {
    this.sql = sql
  }

  /** `true` when `SELECT 1` succeeds. A driver failure is `false`, never a throw. */
  async isConnected(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`
      return true
    } catch {
      return false
    }
  }

  /**
   * Run `fn` in a transaction, with `this` bound to a clone whose client is the
   * transaction handle.
   *
   * Cache writes made by the callback are deferred until after the commit and are
   * discarded when the callback throws. A nested `begin` in `fn` opens a savepoint
   * on the client, so the helper composes.
   */
  async begin<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const pendingCacheOperations: Array<() => Promise<void>> = []
    const result = await this.client.begin(async (transaction: Transaction) => {
      const service = Object.create(this) as this
      service.setSql(transaction as unknown as Sql)
      service.pendingCacheOperations = pendingCacheOperations
      return await fn(service)
    })
    for (const operation of pendingCacheOperations) {
      await operation()
    }
    // `postgres` types `begin` as `Promise<UnwrapPromiseArray<T>>`, and that mapped type is
    // not provably `T` for an unconstrained `T`. The runtime value is exactly `T`: the
    // unwrapping only removes promises the caller's array elements already were, which
    // awaiting the result removes too.
    return result as T
  }

  /** Fail now when the database is unreachable, rather than on the first query. */
  async connect(): Promise<void> {
    await this.sql`SELECT 1`
  }

  /** Close the pool. Bounded by five seconds so a shutdown cannot hang. */
  async shutdown(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }

  /**
   * Drop `undefined` fields, and always drop `updatedAt`.
   *
   * `undefined` is what `postgres` renders as `DEFAULT`. `updatedAt` is dropped
   * because the template schema sets `updated_at = NOW()` on the server for every
   * write, so a caller-supplied value would be overwritten by a client clock that
   * is not the database's.
   */
  sanitize<T>(obj: Partial<T>): Partial<T> {
    return Object.keys(obj).reduce<Partial<T>>((acc, key) => {
      const value = obj[key as keyof Partial<T>]
      if (value !== undefined) {
        acc[key as keyof Partial<T>] = value
      }
      if (key === "updatedAt") {
        delete acc[key as keyof Partial<T>]
      }
      return acc
    }, {})
  }

  /** Read one row through the cache, or straight from the database inside a transaction. */
  async findOne<T extends postgres.Row>(
    cache: RowCache<T>,
    id: string | number,
    command: postgres.PendingQuery<T[]>,
  ): Promise<null | T> {
    if (this.pendingCacheOperations) {
      return (await command)[0] ?? null
    }
    return cache.wrap(id, async () => (await command)[0] as T)
  }

  async createOne<T extends postgres.Row>(
    cache: RowCache<T>,
    command: postgres.PendingQuery<T[]>,
  ): Promise<T> {
    const created = (await command)[0]
    if (created) {
      await this.setCache(cache, created["id"] as string | number, created)
    }
    return created
  }

  async updateOne<T extends postgres.Row>(
    cache: RowCache<T>,
    command: postgres.PendingQuery<T[]>,
  ): Promise<T> {
    const updated = (await command)[0]
    if (updated) {
      await this.setCache(cache, updated["id"] as string | number, updated)
    }
    return updated
  }

  async deleteOne<T extends postgres.Row>(
    cache: RowCache<T>,
    command: postgres.PendingQuery<T[]>,
  ): Promise<T> {
    const deleted = (await command)[0]
    if (deleted) {
      await this.deleteCache(cache, deleted["id"] as string | number)
    }
    return deleted
  }

  /**
   * The five row operations every table in the template schema exposes.
   *
   * `deleteOne` is a soft delete (`deleted_at = NOW()`), matching the schema's
   * `deleted_at` columns and the auditability behind them; `undeleteOne` reverses
   * it. Identifiers are passed through `this.sql(...)`, so the driver quotes the
   * table name instead of the template interpolating it.
   */
  buildMethods<M extends postgres.Row, C extends Partial<unknown>, U extends Partial<unknown>>(
    table: string,
    cache: RowCache<M>,
  ) {
    return {
      findOne: ({ id }: { id: string | number }): Promise<null | M> =>
        this.findOne<M>(
          cache,
          id,
          this.sql<M[]>`SELECT * FROM ${this.sql(table)} WHERE id = ${id}`,
        ),
      findChanged: (updatedAtGt: Date): Promise<M[]> =>
        this.sql<M[]>`
          SELECT * FROM ${this.sql(table)}
          WHERE updated_at > ${updatedAtGt}
          ORDER BY updated_at DESC
        `,
      createOne: ({ data }: { data: C }): Promise<M> =>
        this.createOne<M>(
          cache,
          this.sql<M[]>`
            INSERT INTO ${this.sql(table)}
            ${this.sql(this.sanitize(data))}
            RETURNING *
          `,
        ),
      updateOne: (params: { id: string | number; data: U }): Promise<M> =>
        this.updateOne<M>(
          cache,
          this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW(), ${this.sql(this.sanitize(params.data))}
            WHERE id = ${params.id}
            RETURNING *
          `,
        ),
      deleteOne: ({ id }: { id: string | number }): Promise<M> =>
        this.deleteOne<M>(
          cache,
          this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW(), deleted_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `,
        ),
      undeleteOne: ({ id }: { id: string | number }): Promise<M> =>
        this.updateOne<M>(
          cache,
          this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW(), deleted_at = NULL
            WHERE id = ${id}
            RETURNING *
          `,
        ),
    }
  }

  protected setCache<T extends postgres.Row>(
    cache: RowCache<T>,
    id: string | number,
    value: T,
  ): Promise<void> {
    return this.runCacheOperation(() => cache.set(id, value))
  }

  protected deleteCache<T extends postgres.Row>(
    cache: RowCache<T>,
    id: string | number,
  ): Promise<void> {
    return this.runCacheOperation(() => cache.delete(id))
  }

  private runCacheOperation(operation: () => Promise<void>): Promise<void> {
    if (this.pendingCacheOperations) {
      this.pendingCacheOperations.push(() => this.executeCacheOperation(operation))
      return Promise.resolve()
    }
    return this.executeCacheOperation(operation)
  }

  private async executeCacheOperation(operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      console.error("Cache update failed", error)
    }
  }
}
