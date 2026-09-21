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
 *  - the clone is created through `Object.create(this)` and nothing else. The clone's
 *    prototype is the instance it was made from, so every field of that instance is
 *    *readable* through the prototype chain — an earlier version of this comment said
 *    they were not, which is wrong. What does not carry is a *write*: assigning to a
 *    field on the clone creates an own property on the clone and leaves the original's
 *    untouched, which is exactly why `pendingCacheOperations` can be swapped per clone
 *    without disturbing the instance the callback was called on. A subclass that mutates
 *    a field inside the callback and expects the change to outlive the transaction is
 *    the case to avoid.
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

/**
 * Thrown when a transaction clone is used after its transaction has ended.
 *
 * The clone {@link DbServiceBase.begin} hands its callback is scoped to that
 * transaction. A service that stores it — `this.db = tx` inside the callback — would
 * otherwise keep a handle on the connection the transaction ran on, and a write through
 * that handle later lands inside whatever transaction that connection is running next
 * and disappears with that transaction's rollback. The write reports success on the way
 * out, which is what makes the loss silent.
 *
 * This is the Postgres half of `SqliteScopeEndedError` in `sqlite.ts`, and it is thrown
 * for the same reason.
 *
 * **It is thrown, not rejected.** The check sits on the executor itself, which the
 * driver also uses synchronously (`sql(table)` renders an identifier and returns it), so
 * one rule covers every call *made through the clone*. A method declared `async`, or one
 * that awaits its query, turns the throw into the rejection its caller expects; a method
 * that returns the tagged template unawaited sees it one tick earlier, as a throw.
 *
 * **Two routes are still open, and they are open on the version before this check too.**
 * A query *built* inside the callback and awaited afterwards runs when it is awaited,
 * and the call that built it happened while the clone was live, so nothing here sees it.
 * The same goes for a raw handle taken straight from `this.sql.savepoint(...)`, which is
 * the driver's own object rather than the clone's. Both still write into a later
 * transaction and lose the row. They are tracked in #108.
 */
export class PostgresScopeEndedError extends Error {
  constructor() {
    super(
      `this transaction clone belonged to a transaction that has already committed or ` +
        `rolled back; a statement through it afterwards runs on the connection that ` +
        `transaction was opened on, inside whatever transaction is open there now`,
    )
    this.name = "PostgresScopeEndedError"
  }
}

/** A transaction executor that can be switched off, and the switch. */
interface ScopedExecutor {
  /** What the clone writes through until {@link end} is called. */
  executor: Transaction
  /** Retire the executor. Every later call through it throws. */
  end: () => void
}

/**
 * Wrap a transaction handle so it stops working when its transaction ends.
 *
 * A `Proxy` rather than a hand-written stand-in, because the driver's handle is a tag
 * function carrying a dozen properties — `savepoint`, `unsafe`, `json`, `file`, the type
 * helpers — and a stand-in would have to list them, so a property nobody thought of
 * would quietly go around the check.
 *
 * **Four traps, because there are four ways to reach the driver through the handle**:
 * calling it (`` sql`…` `` and `sql(identifier)`), calling something on it
 * (`sql.savepoint(…)`, `sql.unsafe(…)`), constructing through it
 * (`new sql.unsafe(…)`, `Reflect.construct(…)`) and reading a property *descriptor* off
 * it (`Object.getOwnPropertyDescriptor(sql, "unsafe").value(…)`). An earlier version had
 * the first two, and each of the other two wrote a row after the transaction had ended
 * and lost it to the next rollback, reporting success on the way out. The remaining traps
 * cannot hand out the driver: `has` and `ownKeys` answer with names, `getPrototypeOf`
 * answers `Function.prototype`, and `set`, `defineProperty` and `deleteProperty` change
 * the handle rather than reading from it and can execute no statement.
 *
 * **Construction is refused outright, live as well as retired.** `postgres` exposes no
 * constructor: `new sql.unsafe(…)` "works" only because any plain function can be
 * constructed and a constructor that returns an object returns that object, so the query
 * object comes back by accident of the language. Refusing is both the simpler trap — no
 * `newTarget` to carry — and the honest one, and the refusal after the scope is
 * {@link PostgresScopeEndedError} while the refusal before it is a `TypeError` naming the
 * rule.
 *
 * **A function reached through the handle is wrapped, not replaced.** An earlier version
 * of this returned a plain arrow function for every function-valued property, and that
 * threw away the properties the function carried: the driver hangs a caller's custom type
 * helpers on `sql.types` and `sql.typed`, which are themselves functions, so
 * `sql.types.myType(value)` became a `TypeError` inside a transaction. Each function is
 * now wrapped in a `Proxy` of its own, recursively, so its properties survive and every
 * call through any of them is still refused once the scope has ended. One handler serves
 * the root and every nested wrapper, so a route closed here is closed everywhere.
 *
 * Wrappers are remembered per value, so reading the same property twice gives the same
 * function and an identity comparison still holds.
 *
 * `this` is passed on unchanged everywhere, so a driver method sees the receiver the call
 * actually named rather than one this wrapper picked.
 */
function scopeExecutor(executor: Transaction): ScopedExecutor {
  let ended = false
  const assertUsable = (): void => {
    if (ended) throw new PostgresScopeEndedError()
  }
  const wrappers = new WeakMap<object, unknown>()

  const handler: ProxyHandler<(...parameters: unknown[]) => unknown> = {
    apply(inner, thisArg, parameters: unknown[]) {
      assertUsable()
      return Reflect.apply(inner, thisArg, parameters)
    },

    construct() {
      assertUsable()
      throw new TypeError(
        `a Postgres transaction handle is not a constructor; \`new sql.unsafe(...)\` runs ` +
          `the statement only because any plain function can be constructed, and it is ` +
          `refused here so that it cannot become a way around the end of a transaction`,
      )
    },

    get(inner, property) {
      const value = Reflect.get(inner, property)
      if (unsubstitutable(inner, property)) {
        assertUsable()
        return value
      }
      return guard(value)
    },

    /**
     * A descriptor read must not hand out the function the wrapper is standing in for.
     *
     * The value is replaced by its wrapper, so a descriptor taken while the scope was
     * live is as dead as the handle afterwards, and `Object.getOwnPropertyDescriptor`
     * stops being the way to keep the driver's own function past the transaction.
     */
    getOwnPropertyDescriptor(inner, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(inner, property)
      if (descriptor === undefined) return undefined
      if (unsubstitutable(inner, property)) {
        assertUsable()
        return descriptor
      }
      if ("value" in descriptor) {
        return { ...descriptor, value: guard(descriptor.value) }
      }
      return {
        ...descriptor,
        get: guard(descriptor.get) as (() => unknown) | undefined,
        set: guard(descriptor.set) as ((value: unknown) => void) | undefined,
      }
    },
  }

  /**
   * `true` when the engine will not let a wrapper stand in for this property.
   *
   * A non-configurable own property that is not a writable data property has to be read
   * back, and reported, as the target's own value; a proxy that answers with anything else
   * gets a `TypeError` from the engine rather than refusing on its own terms. No property
   * of a driver function is shaped that way — `length` and `name` are configurable and
   * `prototype` is writable — so this is the shape the wrapper cannot serve rather than
   * one it meets. Where it does occur the value is handed over while the scope is live,
   * which is what the caller would have had anyway, and the read is refused once the scope
   * has ended.
   */
  function unsubstitutable(target: object, property: string | symbol): boolean {
    const own = Reflect.getOwnPropertyDescriptor(target, property)
    return own !== undefined && own.configurable !== true && own.writable !== true
  }

  /** Guard a value reached through the handle: functions are wrapped, anything else is not. */
  function guard(value: unknown): unknown {
    if (typeof value !== "function") return value
    const cached = wrappers.get(value as object)
    if (cached !== undefined) return cached
    const wrapper = new Proxy(value as (...parameters: unknown[]) => unknown, handler)
    wrappers.set(value as object, wrapper)
    return wrapper
  }

  return {
    // The root goes through the same `guard` as everything reached from it, so the handle
    // and its helpers are one shape with one set of rules.
    executor: guard(executor) as Transaction,
    end: () => {
      ended = true
    },
  }
}

/** The scope-ender used before a clone exists, so `begin`'s `finally` is unconditional. */
const endNothing = (): void => {}

/** A transaction clone and the switch that retires it. */
interface TransactionClone<S> {
  /** The service the callback is given. */
  service: S
  /** Retire the clone's executor. Every statement through it afterwards throws. */
  endScope: () => void
}

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
   *
   * **The clone stops working when the transaction returns**, on the rollback path as
   * well as the commit path, and every statement through it afterwards throws
   * {@link PostgresScopeEndedError}. A service that stores it — `this.db = tx` — would
   * otherwise keep writing through the connection that transaction ran on, into whatever
   * transaction that connection is running next, and the row would disappear with that
   * transaction's rollback after the write had reported success. That error is **thrown**
   * rather than rejected, so a caller that chains `.catch(...)` on an unawaited query
   * will not see it; see {@link PostgresScopeEndedError} for why, and for the two routes
   * past the check that #108 records.
   */
  async begin<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    if (this.pendingCacheOperations !== null) {
      return await this.beginSavepoint(fn, this.pendingCacheOperations)
    }
    const pendingCacheOperations: Array<() => Promise<void>> = []
    let endScope: () => void = endNothing
    let result: unknown
    try {
      result = await this.client.begin(async (transaction: Transaction) => {
        const clone = this.cloneFor(transaction, pendingCacheOperations)
        endScope = clone.endScope
        return await fn(clone.service)
      })
    } finally {
      // Here and not inside the callback: the clone is dead once the transaction has
      // returned, whether it committed or rolled back, and a callback that stored it
      // cannot tell those apart either.
      endScope()
    }
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
   *
   * The savepoint's clone is retired when the savepoint returns, exactly as
   * {@link begin} retires its own: a clone kept past a savepoint is the same open door
   * onto the connection, and the outer transaction is still running on it.
   */
  private async beginSavepoint<T>(
    fn: (tx: this) => Promise<T>,
    outerQueue: Array<() => Promise<void>>,
  ): Promise<T> {
    const innerQueue: Array<() => Promise<void>> = []
    const transaction = this.sql as unknown as Transaction
    let endScope: () => void = endNothing
    let result: unknown
    try {
      result = await transaction.savepoint(async (savepoint: Transaction) => {
        const clone = this.cloneFor(savepoint, innerQueue)
        endScope = clone.endScope
        return await fn(clone.service)
      })
    } finally {
      endScope()
    }
    outerQueue.push(...innerQueue)
    return result as T
  }

  /**
   * A clone of this service that writes through `executor` and queues its cache writes.
   *
   * The executor the clone is given is a wrapper, not the driver's handle: `endScope`
   * switches it off, and that is what stops a kept clone writing after its transaction.
   */
  private cloneFor(
    executor: Transaction,
    queue: Array<() => Promise<void>>,
  ): TransactionClone<this> {
    const scope = scopeExecutor(executor)
    const service = Object.create(this) as this
    service.setSql(scope.executor as unknown as Sql)
    service.pendingCacheOperations = queue
    return { service, endScope: scope.end }
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
