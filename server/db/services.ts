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
 *    clone's `sql` is a transaction handle, which has no `begin` of its own. Neither
 *    source got the nested case right, and neither does calling `begin` on the client:
 *    measured against `postgres@3.4.7`, `sql.begin` inside an open transaction takes a
 *    *second connection* out of the pool and opens a *second, independent*
 *    transaction there, which commits on its own and survives the outer rollback. A
 *    nested `begin` here calls `savepoint` on the transaction handle instead, which is
 *    the only nesting `postgres` has.
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

/** Arguments to {@link RowMethods.findOne}. */
export interface FindOneParams {
  id: string | number
  /**
   * Return the row even when it is soft-deleted. Defaults to `false`.
   *
   * The read then bypasses the cache in both directions, because the cache is keyed by
   * id alone and cannot hold a deleted row and a live one apart. Use it for an audit
   * view or for an undelete flow that has to show what it is about to restore; a
   * caller that just wants "the row, if it is there" should leave it alone.
   */
  includeDeleted?: boolean
}

/**
 * What {@link DbServiceBase.buildMethods} returns.
 *
 * Written out as an interface rather than inferred, because `deno publish` rejects an
 * exported method whose return type it cannot write down.
 */
export interface RowMethods<
  M extends postgres.Row,
  C extends Partial<unknown>,
  U extends Partial<unknown>,
> {
  /** One row by id. `null` when it is missing, and when it is soft-deleted. */
  findOne(params: FindOneParams): Promise<null | M>
  /** Every row touched since `updatedAtGt`, deleted ones included; this is the sync read. */
  findChanged(updatedAtGt: Date): Promise<M[]>
  createOne(params: { data: C }): Promise<M>
  /**
   * Updates a live row. An empty `data` touches `updated_at` and nothing else.
   *
   * `undefined` when no live row has that id — the id is unknown, or the row is
   * soft-deleted, which this statement does not match. `undeleteOne` is the way back.
   */
  updateOne(params: { id: string | number; data: U }): Promise<M | undefined>
  /** Soft delete: sets `deleted_at`. `undefined` when no row has that id. */
  deleteOne(params: { id: string | number }): Promise<M | undefined>
  /**
   * Reverses {@link deleteOne}, and is the one update that reaches a deleted row.
   * `undefined` when no row has that id.
   */
  undeleteOne(params: { id: string | number }): Promise<M | undefined>
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
   * discarded when the callback throws.
   *
   * A nested call — `begin` on the clone the callback was given — opens a **savepoint**
   * on the transaction handle, so the inner unit rolls back on its own and still rolls
   * back with the outer transaction. Reaching for `client.begin` instead would take a
   * second connection out of the pool and open an independent transaction on it, and
   * the inner rows would survive the outer rollback.
   *
   * Cache writes made inside a savepoint are held separately until the savepoint
   * returns, and then joined to the outer transaction's queue. Nothing runs before the
   * outermost commit, and a savepoint that threw contributes nothing: the outer
   * transaction can still roll back, and a cache holding rows the database never kept
   * is the failure this deferral exists to prevent.
   */
  async begin<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    if (this.pendingCacheOperations !== null) {
      return await this.beginSavepoint(fn, this.pendingCacheOperations)
    }
    const pendingCacheOperations: Array<() => Promise<void>> = []
    const result = await this.client.begin(async (transaction: Transaction) => {
      return await fn(this.cloneFor(transaction, pendingCacheOperations))
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

  /**
   * The nested half of {@link begin}: a savepoint on the transaction handle.
   *
   * `outerQueue` is the queue of the transaction this savepoint sits inside. Inner
   * cache writes go to a queue of their own and are appended to it only once the
   * savepoint has returned, which is what makes a thrown savepoint leave no trace.
   */
  private async beginSavepoint<T>(
    fn: (tx: this) => Promise<T>,
    outerQueue: Array<() => Promise<void>>,
  ): Promise<T> {
    const innerQueue: Array<() => Promise<void>> = []
    const transaction = this.sql as unknown as Transaction
    const result = await transaction.savepoint(async (savepoint: Transaction) => {
      return await fn(this.cloneFor(savepoint, innerQueue))
    })
    outerQueue.push(...innerQueue)
    return result as T
  }

  /** A clone of this service that writes through `executor` and queues its cache writes. */
  private cloneFor(executor: Transaction, queue: Array<() => Promise<void>>): this {
    const service = Object.create(this) as this
    service.setSql(executor as unknown as Sql)
    service.pendingCacheOperations = queue
    return service
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

  /**
   * Read one row through the cache, or straight from the database inside a transaction.
   *
   * A miss is `null` on both paths. It used to be `null` inside a transaction and
   * `undefined` outside one, because the cached path returned whatever `wrap` handed
   * back: `RowCache.wrap` is typed to return a row, and the only thing its compute can
   * produce for a query that matched nothing is `undefined`.
   */
  async findOne<T extends postgres.Row>(
    cache: RowCache<T>,
    id: string | number,
    command: postgres.PendingQuery<T[]>,
  ): Promise<null | T> {
    if (this.pendingCacheOperations) {
      return (await command)[0] ?? null
    }
    const cached = await cache.wrap(id, async () => (await command)[0] as T)
    return (cached as T | undefined) ?? null
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

  /** The updated row, or `undefined` when the statement matched none. */
  async updateOne<T extends postgres.Row>(
    cache: RowCache<T>,
    command: postgres.PendingQuery<T[]>,
  ): Promise<T | undefined> {
    const updated = (await command)[0]
    if (updated) {
      await this.setCache(cache, updated["id"] as string | number, updated)
    }
    return updated
  }

  /** The deleted row, or `undefined` when the statement matched none. */
  async deleteOne<T extends postgres.Row>(
    cache: RowCache<T>,
    command: postgres.PendingQuery<T[]>,
  ): Promise<T | undefined> {
    const deleted = (await command)[0]
    if (deleted) {
      await this.deleteCache(cache, deleted["id"] as string | number)
    }
    return deleted
  }

  /**
   * The six row operations every table in the template schema exposes.
   *
   * `deleteOne` is a soft delete (`deleted_at = NOW()`), matching the schema's
   * `deleted_at` columns and the auditability behind them; `undeleteOne` reverses
   * it. Identifiers are passed through `this.sql(...)`, so the driver quotes the
   * table name instead of the template interpolating it.
   *
   * The return type is written out rather than inferred. An inferred one is not a
   * problem for a caller, but it is for publishing: `deno publish` requires an explicit
   * type on an exported method, and this one method failed that check for the whole
   * workspace.
   */
  buildMethods<M extends postgres.Row, C extends Partial<unknown>, U extends Partial<unknown>>(
    table: string,
    cache: RowCache<M>,
  ): RowMethods<M, C, U> {
    return {
      findOne: ({ id, includeDeleted = false }: FindOneParams): Promise<null | M> => {
        if (includeDeleted) {
          // The opt-out goes around the cache in both directions, and it has to. The
          // cache is keyed by id alone, so a deleted row read through it would be
          // handed to the next plain `findOne` as if it were live, and a filter in the
          // SQL would only hold while the cache missed.
          return this.sql<M[]>`
            SELECT * FROM ${this.sql(table)} WHERE id = ${id}
          `.then((rows) => rows[0] ?? null)
        }
        return this.findOne<M>(
          cache,
          id,
          this.sql<M[]>`
            SELECT * FROM ${this.sql(table)} WHERE id = ${id} AND deleted_at IS NULL
          `,
        )
      },
      // Deliberately unfiltered: this is the sync read, and a client that is catching up
      // has to learn that a row was deleted. `deleted_at` is on the row it returns.
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
      updateOne: (params: { id: string | number; data: U }): Promise<M | undefined> => {
        const data = this.sanitize(params.data)
        // `sql({})` renders an empty column list, so the general form would produce
        // `SET updated_at = NOW(), WHERE id = $1` — a syntax error from the server. An
        // update of nothing but the timestamp is a legitimate touch, so it gets its own
        // statement instead of being rejected here.
        const command = Object.keys(data).length === 0
          ? this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW()
            WHERE id = ${params.id} AND deleted_at IS NULL
            RETURNING *
          `
          : this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW(), ${this.sql(data)}
            WHERE id = ${params.id} AND deleted_at IS NULL
            RETURNING *
          `
        return this.updateOne<M>(cache, command)
      },
      deleteOne: ({ id }: { id: string | number }): Promise<M | undefined> =>
        this.deleteOne<M>(
          cache,
          this.sql<M[]>`
            UPDATE ${this.sql(table)}
            SET updated_at = NOW(), deleted_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `,
        ),
      // Its own statement, and the one update that must reach a deleted row.
      undeleteOne: ({ id }: { id: string | number }): Promise<M | undefined> =>
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
