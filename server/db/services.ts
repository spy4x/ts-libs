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
 *
 * **Which helper sets follow a transaction.** A helper set closes over the instance that
 * built it, so what matters is where it is kept:
 *
 *  - a class field or any other property of the service (`notes = this.buildMethods(...)`)
 *    follows: `begin` gives the clone its own set, built on the clone, in the same
 *    property, so `tx.notes.createOne(...)` runs on the transaction and queues its cache
 *    write until the commit. This held only for the getter form until #230;
 *  - a getter that builds on every access (`get notes() { return this.buildMethods(...) }`)
 *    follows, because the getter runs with the clone as `this`;
 *  - a set built inside the callback through the clone (`tx.buildMethods(...)`) follows;
 *  - a set kept anywhere else does not: in a local variable or a module constant, nested
 *    inside another object (`tables = { notes: this.buildMethods(...) }`), copied or
 *    spread into a new object, in a `#private` field, or built by another service. Those
 *    still run on the instance that built them, outside the transaction.
 *
 * **What the transaction clone's guard promises**, and it is worth stating once here
 * because several comments below depend on it. A clone kept past `begin()` or past a
 * nested `begin()` refuses, with {@link PostgresScopeEndedError}, every call form a person
 * would write through it — the tagged template, the `sql(...)` helper forms, `unsafe`,
 * `file`, `json`, `array`, `types` and `typed`, `savepoint`, `notify`, `prepare`, `new`,
 * the service's own nested `begin()` (which rejects, being `async`), and anything read off
 * the handle at any depth. A transaction handle has no `begin`, `reserve` or `listen` of its
 * own; those throw a `TypeError`, live and retired alike. A query *built* through the clone
 * and awaited after the transaction is refused when it is sent, and a handle the driver
 * hands to a `savepoint` callback is retired when that savepoint returns — the two routes
 * #108 opened with. It is a guard against the mistake issue
 * #96 describes, a service that stores the clone and writes through it later, and **not a
 * security boundary**: code that deliberately reaches into the driver's internals is not
 * making that mistake, and could in any case import `postgres` and open a connection of
 * its own. One known route remains and is described on {@link PostgresScopeEndedError}.
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
 * **Two more moments are checked than a call through the clone**, because a call through
 * the clone is not the only way a statement reaches the transaction's connection. Both
 * were routes #108 measured, and both lose the row to the next rollback after reporting
 * success:
 *
 *  1. a query *built* inside the callback and awaited afterwards. `postgres` queries are
 *     lazy, so the call that built it happened while the clone was live and the statement
 *     is sent later. The check moves to the send: the query's own `handle` refuses the
 *     first send once the scope has ended. A forgotten `await` is enough to write this
 *     one, which is why it is closed rather than written down;
 *  2. a handle the driver hands to a `savepoint` callback. That handle is built by the
 *     driver and passed in, so it never passed through this wrapper; the callback now
 *     receives a scoped one that is retired when the savepoint returns.
 *
 * **One known route remains.** The driver's own internals ride on a value a call
 * *returned*. Every query object `postgres` builds holds the transaction's execute
 * function as `q.handler`, so `new q.constructor(…, q.handler, …)` sends a statement on
 * that connection. Return values are deliberately not wrapped — the driver recognises a
 * fragment or a parameter passed back into a query by its class, and a wrapper is not that
 * class — so this one cannot be closed by wrapping reads at all. Building a query out of
 * the driver's internals is not the mistake this guard is for, and the owner's decision on
 * #96 is that it ships recorded rather than chased.
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
 * **Four traps.** Two of them are where a statement is run — calling the handle
 * (`` sql`…` `` and `sql(identifier)`) and constructing through it (`new sql.unsafe(…)`,
 * `Reflect.construct(…)`) — and the other two are the two ways to *read* something out of
 * it: {@link ProxyHandler.get} and {@link ProxyHandler.getOwnPropertyDescriptor}. Each of
 * the four was added after a measured route past the previous set wrote a row into a later
 * transaction and lost it to that transaction's rollback, reporting success on the way out.
 *
 * The two read traps are what let the guard cover every call form a person would write
 * rather than a list of spellings: everything they hand back is wrapped, at any depth, so
 * a helper read off the handle is refused exactly as the handle itself is. The remaining
 * traps do not hand the driver out: `has` and `ownKeys` answer with names,
 * `getPrototypeOf` answers an intrinsic (`Function.prototype`, or `AsyncFunction.prototype`
 * for the driver's one `async` helper), and `set`, `defineProperty` and `deleteProperty`
 * change the handle rather than reading from it and can execute no statement. A regression
 * test in each tier walks the whole property graph — own keys including symbols,
 * descriptors, the prototype chain, `prototype` and `constructor` — and fails if a *read*
 * gives back a value the driver owns. It says nothing about what a call **returns**, which
 * is the one route that remains open on {@link PostgresScopeEndedError}.
 *
 * **Construction is refused outright, live as well as retired.** `postgres` exposes no
 * constructor: `new sql.unsafe(…)` "works" only because any plain function can be
 * constructed and a constructor that returns an object returns that object, so the query
 * object comes back by accident of the language. Refusing is both the simpler trap — no
 * `newTarget` to carry — and the honest one, and the refusal after the scope is
 * {@link PostgresScopeEndedError} while the refusal before it is a `TypeError` naming the
 * rule.
 *
 * **A function or object reached through the handle is wrapped, not replaced.** An earlier
 * version returned a plain arrow function for every function-valued property, and that
 * threw away the properties the function carried: the driver hangs a caller's custom type
 * helpers on `sql.types` and `sql.typed`, which are themselves functions, so
 * `sql.types.myType(value)` became a `TypeError` inside a transaction. A later one wrapped
 * functions but handed objects over as they were, and every ordinary function carries a
 * `prototype` object whose `constructor` is that function itself, so
 * `sql.prototype.constructor` was the driver's own handle. Each function *and* each object
 * is now wrapped in a `Proxy` of its own, recursively, so properties survive and every
 * call through any of them is still refused once the scope has ended. One handler serves
 * the root and every nested wrapper, so a rule written here holds at every depth of a
 * read.
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

  /**
   * The driver's own `savepoint`, read once so {@link ProxyHandler.apply} can recognise it.
   *
   * Read now rather than per call: it is a configurable data property on the handle, so
   * reading it costs nothing and cannot execute a statement.
   */
  const rawSavepoint: unknown = (executor as unknown as Record<string, unknown>)["savepoint"]

  const handler: ProxyHandler<(...parameters: unknown[]) => unknown> = {
    apply(inner, thisArg, parameters: unknown[]) {
      assertUsable()
      const scoped = inner === rawSavepoint ? scopeSavepointCallback(parameters) : parameters
      return armQuery(Reflect.apply(inner, thisArg, scoped))
    },

    construct() {
      assertUsable()
      throw new TypeError(
        `a Postgres transaction handle is not a constructor; \`new sql.unsafe(...)\` runs ` +
          `the statement only because any plain function can be constructed, and it is ` +
          `refused here so that it cannot become a way around the end of a transaction`,
      )
    },

    /**
     * The receiver is passed on, so an accessor runs with the wrapper as `this`.
     *
     * `Reflect.get` without one runs a getter with the *target* as `this`, which handed a
     * getter planted through a live clone the driver's own handle — a read that gave back
     * the very thing the wrapper stands in for. Passing the receiver changes nothing for a
     * data property, and the invariant on a non-configurable property is about the value,
     * not the receiver, so it still holds.
     */
    get(inner, property, receiver) {
      const value = Reflect.get(inner, property, receiver)
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
     * stops being the way to keep the driver's own function past the transaction. An
     * accessor's `get` and `set` are wrapped the same way.
     *
     * A wrapped accessor is called by whoever took the descriptor, so the `apply` trap
     * passes its `this` through unchanged rather than substituting a receiver of its own.
     * That is the right way round: the caller has named a receiver, and a wrapper that
     * replaced it would change what a legitimate call means. A caller who names the raw
     * handle as the receiver already holds the raw handle, so nothing is given away.
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
   * gets a `TypeError` from the engine rather than refusing on its own terms.
   *
   * No property of the driver's handle or of any function it carries is shaped that way —
   * `length` and `name` are configurable and an ordinary function's `prototype` is
   * writable. The shape does occur out in the language's own objects: `Object.prototype`,
   * `Function.prototype` and the like are non-configurable and non-writable on their
   * constructors, and a long enough walk of `constructor` and `prototype` reaches them.
   * Those are intrinsics shared by the whole program, not the driver, and nothing the
   * driver owns hangs off them, which the graph-walk tests check rather than assume. The
   * value is therefore handed over while the scope is live — which is what the caller would
   * have had anyway — and the read is refused once the scope has ended.
   */
  function unsubstitutable(target: object, property: string | symbol): boolean {
    const own = Reflect.getOwnPropertyDescriptor(target, property)
    return own !== undefined && own.configurable !== true && own.writable !== true
  }

  /**
   * Guard a value *read* through the handle: functions and objects are wrapped, primitives
   * are not.
   *
   * Objects and not only functions, because every ordinary function carries a `prototype`
   * object whose `constructor` is that function itself. Wrapping functions alone handed
   * that object over untouched, so `sql.prototype.constructor` was the driver's own handle
   * and a write through it after the transaction had ended reported success and went with
   * the next rollback. With objects wrapped too the rule holds for reads at any depth:
   * everything *read* through a wrapper is a wrapper or a primitive, so a helper found by
   * following properties is refused exactly as the handle itself is.
   *
   * **A value *returned by a call* is not wrapped**, and must not be. The driver
   * recognises what it is handed back by class — a fragment, a `Parameter` from
   * `sql.json(...)` or a custom type helper, a `PendingQuery` nested in another tagged
   * template — and a wrapper would not be that class. Returned promises and query objects
   * therefore stay exactly what the driver built, awaitable and with `values`, `simple`,
   * `cursor`, `forEach` and `describe` intact. That is why the `apply` trap hands the
   * result straight back, and it is also why a query object carries the transaction's own
   * execute function within reach — the one route that remains open on
   * {@link PostgresScopeEndedError}, which this design accepts rather than closes.
   */
  function guard(value: unknown): unknown {
    if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
      return value
    }
    const cached = wrappers.get(value as object)
    if (cached !== undefined) return cached
    const wrapper = new Proxy(value as (...parameters: unknown[]) => unknown, handler)
    wrappers.set(value as object, wrapper)
    return wrapper
  }

  /**
   * Make a query the driver just built refuse to be *sent* once the scope has ended.
   *
   * A `postgres@3.4.7` query is lazy. Nothing reaches the server when the query is built;
   * `then`, `catch`, `finally`, `execute` and `forEach` all go through the query's
   * `handle()` method, and that is where the statement is put on the transaction's
   * connection (`postgres@3.4.7/src/query.js:123-161`). So a query built through a live
   * clone and awaited after `begin()` has returned used to run inside whatever transaction
   * that connection held by then. A forgotten `await` is enough to write it, which is why
   * it is closed here rather than only written down (#108).
   *
   * The check goes on the query's own `handle`, shadowing the one it inherits, and only the
   * **first** send is checked: awaiting a query a second time sends nothing, so a result
   * read again after the transaction is not refused. The class of the object is untouched,
   * which matters — the driver recognises a fragment, a parameter or a nested query by its
   * class, so this could not have been done by wrapping the query in a `Proxy`.
   *
   * `handle` is not documented API. The integration tier awaits a query built inside the
   * callback and expects {@link PostgresScopeEndedError}, so a driver that renamed the
   * method would turn that test red rather than silently reopen the route.
   */
  function armQuery(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value
    const send = (value as { handle?: unknown }).handle
    if (typeof send !== "function") return value
    // Already armed, by this scope or by a nested one whose scope ends no later.
    if (Object.prototype.hasOwnProperty.call(value, "handle")) return value
    let sent = false
    Object.defineProperty(value, "handle", {
      value: function (this: unknown, ...parameters: unknown[]): unknown {
        if (!sent) {
          assertUsable()
          sent = true
        }
        return Reflect.apply(send as (...rest: unknown[]) => unknown, this, parameters)
      },
      writable: true,
      enumerable: false,
      configurable: true,
    })
    return value
  }

  /**
   * Give a `savepoint` callback a scoped handle instead of the driver's own.
   *
   * `sql.savepoint(fn)` calls `fn` with a handle the driver built, so that handle never
   * passed through this wrapper and a caller who kept it held an open door onto the
   * connection for the rest of the process (#108). Replacing the callback is the only
   * place it can be caught, because the driver hands the handle over rather than returning
   * it.
   *
   * The nested scope is retired when the callback settles, exactly as {@link
   * DbServiceBase.begin} retires its own clone, and on the failure path as well.
   *
   * The callback is the last function argument, which covers both of the driver's forms,
   * `savepoint(fn)` and `savepoint(name, fn)`. An array the callback returns is awaited
   * here, because the driver awaits one itself and would not once the callback's result is
   * a promise.
   */
  function scopeSavepointCallback(parameters: unknown[]): unknown[] {
    let index = -1
    for (let position = parameters.length - 1; position >= 0; position -= 1) {
      if (typeof parameters[position] === "function") {
        index = position
        break
      }
    }
    if (index === -1) return parameters
    const callback = parameters[index] as (handle: Transaction) => unknown
    const scoped = (handle: Transaction): unknown => {
      const nested = scopeExecutor(handle)
      let outcome: unknown
      try {
        outcome = callback(nested.executor)
      } catch (error) {
        nested.end()
        throw error
      }
      const settled = Array.isArray(outcome) ? Promise.all(outcome) : outcome
      return Promise.resolve(settled).finally(() => nested.end())
    }
    const scopedParameters = [...parameters]
    scopedParameters[index] = scoped
    return scopedParameters
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

/** Where a helper set came from: the instance it closes over, and what it was built with. */
interface RowMethodsOrigin {
  owner: DbServiceBase
  table: string
  cache: RowCache<postgres.Row>
}

/** Every helper set {@link DbServiceBase.buildMethods} made, keyed by the set itself. */
const rowMethodsOrigins = new WeakMap<object, RowMethodsOrigin>()

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
   * well as the commit path. Every call form a person would write through it afterwards —
   * a query, a helper, a helper read off a helper — throws
   * {@link PostgresScopeEndedError}. A service that stores it — `this.db = tx` — would
   * otherwise keep writing through the connection that transaction ran on, into whatever
   * transaction that connection is running next, and the row would disappear with that
   * transaction's rollback after the write had reported success. That is the mistake this
   * guards against; it is not a boundary against code that goes looking for the driver's
   * internals. That error is **thrown** rather than rejected, so a caller that chains
   * `.catch(...)` on an unawaited query will not see it; see
   * {@link PostgresScopeEndedError} for why, and for the one known route that remains.
   *
   * **A query built inside the callback must not be awaited outside it either.** `postgres`
   * queries are lazy, so a query the callback built and did not await — a forgotten
   * `await` is enough — would otherwise be sent on that connection later, inside whatever
   * transaction is open there by then. Awaiting it after the transaction has returned
   * rejects with {@link PostgresScopeEndedError} instead; awaiting one that already ran
   * inside the callback is not refused, because that sends nothing.
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
    this.rebindRowMethods(service)
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
   *
   * The set closes over this instance. Kept in a property of the service — a class field
   * is the usual place — it is rebuilt on each transaction clone, so `tx.<table>` runs
   * inside the transaction; the module doc lists which other forms follow a transaction.
   */
  buildMethods<M extends postgres.Row, C extends Partial<unknown>, U extends Partial<unknown>>(
    table: string,
    cache: RowCache<M>,
  ): RowMethods<M, C, U> {
    return this.buildRowMethods<M, C, U>(table, cache)
  }

  /**
   * The body of {@link buildMethods}, and the one place a helper set is made.
   *
   * Private so that a transaction clone rebuilds a helper set with exactly this shape even
   * when a subclass overrides `buildMethods`. Every set it makes is recorded, with the
   * instance it closes over, so that {@link rebindRowMethods} can find it.
   */
  private buildRowMethods<
    M extends postgres.Row,
    C extends Partial<unknown>,
    U extends Partial<unknown>,
  >(table: string, cache: RowCache<M>): RowMethods<M, C, U> {
    const methods: RowMethods<M, C, U> = {
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
    rowMethodsOrigins.set(methods, {
      owner: this,
      table,
      cache: cache as unknown as RowCache<postgres.Row>,
    })
    return methods
  }

  /**
   * Give `clone` its own copy of every helper set this instance holds in a property.
   *
   * A helper set closes over the instance that built it, so one built in a class field
   * (`notes = this.buildMethods(...)`) closes over the root. The clone reads that field
   * through its prototype, and without this step `tx.notes.createOne(...)` ran on the root
   * client, outside the transaction, and wrote the cache before the commit (#230).
   *
   * The walk covers own and inherited properties, symbols included, and reads only data
   * properties, so no getter runs. A set is replaced only when it was built by this
   * instance or by one it inherits from; a set another service built stays that service's.
   * The replacement keeps the property's attributes and is itself recorded, so a nested
   * `begin` rebinds it again onto the savepoint's clone.
   */
  private rebindRowMethods(clone: DbServiceBase): void {
    const seen = new Set<string | symbol>()
    for (
      let holder: object | null = Object.getPrototypeOf(clone);
      holder !== null && holder !== Object.prototype;
      holder = Object.getPrototypeOf(holder)
    ) {
      for (const key of Reflect.ownKeys(holder)) {
        if (seen.has(key)) continue
        seen.add(key)
        const descriptor = Reflect.getOwnPropertyDescriptor(holder, key)
        if (descriptor === undefined || !("value" in descriptor)) continue
        const value: unknown = descriptor.value
        if (typeof value !== "object" || value === null) continue
        const origin = rowMethodsOrigins.get(value)
        if (origin === undefined) continue
        if (origin.owner !== this && !Object.prototype.isPrototypeOf.call(origin.owner, this)) {
          continue
        }
        Object.defineProperty(clone, key, {
          ...descriptor,
          value: clone.buildRowMethods(origin.table, origin.cache),
        })
      }
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
