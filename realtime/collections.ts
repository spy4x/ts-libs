/**
 * Offline-writable collections: the "read cache plus outbox" level of ADR 003, from one adapter per
 * aggregate. A collection owns an {@link Outbox} (`@spy4x/realtime/outbox`) over its own IndexedDB
 * database and the overlay of its queued entries on a list. {@link createCollections} puts several
 * collections behind one ordered flush. Nothing here names a product: the commands, the error
 * codes, the wording and the shape of a row come from the adapter, and the calls go through a
 * {@link CallPort}.
 *
 * - **Overlay.** A queued create shows in the list, a queued delete hides its row, a queued edit
 *   replaces it ({@link CollectionDefinition.queuedItem}, {@link CollectionDefinition.applyEdit}).
 * - **One ordered flush.** Collections are registered parents first. `flush` sends them in that
 *   order, and a write made online (`submit`) runs the same flush, so a child's write never
 *   overtakes its parent's queue. Every step of every outbox runs under the one `lock`, which the
 *   app shares between tabs (`createWebLock`); readiness is checked under it, at the moment a
 *   write is about to leave.
 * - **A child waits for its parent.** {@link CollectionDefinition.dependencies} names the parent
 *   entries an entry refers to. The entry is not sent while one of them is queued or in conflict,
 *   and {@link Collections.waiting} reports it, with `onPerson` set while a parent is in conflict,
 *   so a screen can say "waiting for your choice" rather than "failed to send".
 * - **A parent that will never exist.** When a queued create is withdrawn, dropped or discarded,
 *   each dependent collection's `without` removes the reference from its queued entries (and from
 *   the edits behind them, so a later `withdraw` does not bring it back). The removal runs just
 *   after the lock is released, so for a moment a child can still hold the reference; the server
 *   ignoring ids it does not know in a write (ADR 003, rule 4) keeps that moment harmless.
 * - **Sending is the app's call.** `canSend` says whether the calls port is reachable as the
 *   queue's user; this layer never looks at a socket.
 *
 * The stored entries are the outbox's own, in the database the adapter names, so a queue written
 * by an app before it used this module is read unchanged.
 *
 * @module
 */

import type { CallPort } from "./calls.ts"
import type { SyncFlushResult } from "./sync-runner.ts"
import { isRetryable } from "./calls.ts"
import { RealtimeRequestError } from "./errors.ts"
import { createIndexedDbOutboxStore } from "./outbox-indexeddb.ts"
import {
  type AbandonReason,
  createOutbox,
  createPromiseLock,
  type Outbox,
  type OutboxCommand,
  type OutboxEntry,
  type OutboxEntrySnapshot,
  type OutboxLock,
  type OutboxStore,
  type SendFailure,
} from "./outbox.ts"

/** An entity of a registered collection: what a child entry refers to. */
export interface EntityRef {
  /** The `name` of the collection. */
  collection: string
  entityId: string
}

/** A call to make: the name and payload the calls port is given. */
export interface CollectionCall {
  name: string
  payload: unknown
}

/**
 * How one aggregate becomes an offline-writable collection. `P` is the payload of a queued write,
 * `S` the server's entity (it carries the `version` the writes are based on), `Item` the row a list
 * shows (the entity itself unless the list shows something else).
 */
export interface CollectionDefinition<P, S extends { version: number }, Item = S> {
  /** Unique within the app; names the collection in {@link EntityRef} and {@link WaitingEntry}. */
  name: string
  /**
   * The IndexedDB database of the queue, for example `offline:user:7:outbox`. Used as given, so a
   * queue an app wrote earlier in the same database is read as it is. Name it for the user.
   */
  database: string
  /** A store to use instead of IndexedDB (tests, servers). `database` is then unused. */
  store?: OutboxStore<P, S>
  /** The command that sends one queued write. */
  toCall(command: OutboxCommand<P>): CollectionCall
  /** The query that reads the entity as the server has it now, for a write that was refused. */
  toQuery(entityId: string, payload: P): CollectionCall
  /** The entity in the answer to a command or a query, or `undefined` when it holds none. */
  entityFrom(answer: unknown): S | undefined
  /** Reads a failed call: retry later, or the server's refusal. See {@link classifyByCode}. */
  classify(error: unknown): SendFailure
  /** The wording of a conflict. Business wording belongs here, not in the library. */
  messages?: { version?: string; gone?: string; rejected?: string }
  /** Keeps the app's copy of server state in step with answers. */
  cache?: {
    put(server: S): Promise<void>
    remove(entityId: string): Promise<void>
  }
  /** The id of a row in a list. */
  itemId(item: Item): string
  /** The row a queued create shows in a list (version `0`, as the server has not seen it). */
  queuedItem(entry: OutboxEntry<P, S>): Item
  /** The row after a queued edit. */
  applyEdit(item: Item, entry: OutboxEntry<P, S>): Item
  /** Whether a queued entry belongs to a list's scope (a group, a folder). Default: all do. */
  inScope?(entry: OutboxEntry<P, S>, scope: string): boolean
  /** The parent entries this collection's entries refer to. */
  dependencies?: {
    /** Names of the collections that hold the parents; each must be registered before this one. */
    parents: readonly string[]
    /** The parent entries a queued entry refers to. A delete usually refers to none. */
    on(entry: OutboxEntry<P, S>): readonly EntityRef[]
    /**
     * The payload without the reference to a parent that will never exist. Return `payload`
     * itself when it holds no such reference. Also applied to the edits an entry has merged.
     */
    without(payload: P, parent: EntityRef): P
  }
}

/** Gives a definition its types. It returns the object it is given. */
export function defineCollection<P, S extends { version: number }, Item = S>(
  definition: CollectionDefinition<P, S, Item>,
): CollectionDefinition<P, S, Item> {
  return definition
}

/** Options of {@link classifyByCode}: the `details.code` of each refusal the server makes. */
export interface ErrorCodes {
  /** The write was based on a version the server has moved past. */
  version?: string
  /** The entity does not exist on the server. */
  notFound?: string
  /** A create hit an id that is taken. */
  alreadyExists?: string
}

/**
 * A `classify` for the common case: an error that is not a server answer, or that is worth a
 * retry (`isRetryable`), means unreachable; a {@link RealtimeRequestError} whose `details.code` is
 * one of `codes` is that kind of refusal; any other refusal is `rejected` with its message.
 */
export function classifyByCode(codes: ErrorCodes): (error: unknown) => SendFailure {
  return (error) => {
    if (!(error instanceof RealtimeRequestError) || isRetryable(error)) {
      return { kind: "unreachable" }
    }
    const code = (error.details as { code?: unknown } | undefined)?.code
    if (typeof code === "string") {
      if (code === codes.version) return { kind: "version" }
      if (code === codes.notFound) return { kind: "not-found" }
      if (code === codes.alreadyExists) return { kind: "already-exists" }
    }
    return { kind: "rejected", message: error.message }
  }
}

/** A collection as the app uses it. */
export interface Collection<P, S extends { version: number }, Item = S> {
  name: string
  /** The queue: `submit`, `withdraw`, `keepMine`, `useTheirs`, `entries`, `subscribe`. */
  outbox: Outbox<P, S>
  store: OutboxStore<P, S>
  /** `base` with the queue applied, the queue read from the store now. */
  overlay(base: readonly Item[], scope?: string): Promise<Item[]>
  /** `base` with `entries` applied: a pure `overlay`, for a screen that holds the entries. */
  applyQueued(
    base: readonly Item[],
    entries: readonly OutboxEntry<P, S>[],
    scope?: string,
  ): Item[]
}

/** A queued entry that is not sent because a parent entry is still ahead of it. */
export interface WaitingEntry {
  collection: string
  entityId: string
  /** The parent entries in the way, queued (`pending`) or `conflict`. */
  blockedBy: readonly { collection: string; entityId: string; status: "pending" | "conflict" }[]
  /**
   * `true` while a parent is in conflict: nothing moves until the person chooses. `false` while
   * the parents are only queued and go out first.
   */
  onPerson: boolean
}

/** What the layer tells the app when it removed a reference to a parent that will never exist. */
export interface ReferenceRemoved {
  /** The create that left the queue. */
  parent: EntityRef
  reason: AbandonReason
  /** The queued entries that referred to it and were rewritten. */
  children: readonly EntityRef[]
}

/** Options of {@link createCollections}. */
export interface CollectionsOptions {
  /** Registered in this order, parents first. */
  // deno-lint-ignore no-explicit-any
  collections: readonly CollectionDefinition<any, any, any>[]
  /** Carries every command and query. */
  calls: CallPort
  /**
   * Whether a write may leave now: the calls port is reachable and the page is signed in as the
   * queue's user. Supplied by the app.
   */
  canSend(): boolean
  /** The one lock for every collection. Default: a lock for this tab only. */
  lock?: OutboxLock
  /** The factory the queues open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
  newKey?(): string
  now?(): string
  /** Told after references were removed, so the app can tell the person. */
  onReferenceRemoved?(event: ReferenceRemoved): void
}

/** Several collections behind one ordered flush. */
export interface Collections {
  /** The collection registered from `definition`. */
  get<P, S extends { version: number }, Item>(
    definition: CollectionDefinition<P, S, Item>,
  ): Collection<P, S, Item>
  /** Reads every queue from its store. Call it on start. */
  reload(): Promise<void>
  /** Sends every queue in registration order, parents first. */
  flush(): Promise<void>
  /**
   * A flush for `createSyncRunner` (`@spy4x/realtime/sync-runner`): sends every queue in order,
   * then answers `"unreachable"` when an entry that is not held back by a parent is still pending,
   * so the runner retries with backoff. An entry waiting for a parent, or in conflict, waits for
   * the person or for that parent and does not count.
   */
  syncFlush(): Promise<SyncFlushResult>
  /** The entries held back by a parent, as of the last change to the queues. */
  waiting(): readonly WaitingEntry[]
  /** Calls `listener` after every change to any queue. Returns the way to stop. */
  subscribe(listener: () => void): () => void
}

// The layer handles every collection through erased types; the typed API above is the contract.
type AnyDefinition = CollectionDefinition<unknown, { version: number }, unknown>
type AnyEntry = OutboxEntry<unknown, { version: number }>
interface Runtime {
  name: string
  definition: AnyDefinition
  store: OutboxStore<unknown, { version: number }>
  outbox: Outbox<unknown, { version: number }>
  bound: Collection<unknown, { version: number }, unknown>
}

function sameRef(a: EntityRef, b: EntityRef): boolean {
  return a.collection === b.collection && a.entityId === b.entityId
}

/** The chain of merged edits with `change` applied to every payload. */
function mapChain<P>(
  snapshot: OutboxEntrySnapshot<P> | undefined,
  change: (payload: P) => P,
): OutboxEntrySnapshot<P> | undefined {
  if (!snapshot) return undefined
  return {
    ...snapshot,
    payload: change(snapshot.payload),
    before: mapChain(snapshot.before, change),
  }
}

/** Puts the collections behind one flush. See the module documentation. */
export function createCollections(options: CollectionsOptions): Collections {
  const { calls } = options
  const lock = options.lock ?? createPromiseLock()
  const definitions = options.collections as readonly unknown[] as readonly AnyDefinition[]
  const runtimes: Runtime[] = []
  const byName = new Map<string, Runtime>()
  const byDefinition = new Map<unknown, Runtime>()
  const listeners = new Set<() => void>()

  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Collection "${definition.name}" is registered twice`)
    }
    for (const parent of definition.dependencies?.parents ?? []) {
      if (!byName.has(parent)) {
        throw new Error(
          `Collection "${definition.name}" depends on "${parent}", which must be registered before it`,
        )
      }
    }
    const runtime = build(definition)
    runtimes.push(runtime)
    byName.set(definition.name, runtime)
    byDefinition.set(definition, runtime)
  }

  function build(definition: AnyDefinition): Runtime {
    const store = definition.store ?? createIndexedDbOutboxStore<unknown, { version: number }>({
      name: definition.database,
      indexedDB: options.indexedDB,
    })
    const outbox: Outbox<unknown, { version: number }> = createOutbox({
      store,
      lock,
      canSend: options.canSend,
      newKey: options.newKey,
      now: options.now,
      classify: definition.classify,
      messages: definition.messages,
      cache: definition.cache,
      async send(command, key) {
        const call = definition.toCall(command)
        const answer = await calls.command(call.name, call.payload, { idempotencyKey: key })
        return command.kind === "delete" ? undefined : definition.entityFrom(answer)
      },
      async fetchServer(entityId) {
        // The queue still holds the entry while the outbox asks; its payload says what to read.
        const entry = (await store.readOutbox()).find((queued) => queued.entityId === entityId)
        if (!entry) return null
        const call = definition.toQuery(entityId, entry.payload)
        try {
          return definition.entityFrom(await calls.query(call.name, call.payload)) ?? null
        } catch (error) {
          if (definition.classify(error).kind === "not-found") return null
          throw error
        }
      },
      ready: (entry) => isReady(definition, entry),
      onAbandoned: (entry, reason) => removeReferences(definition.name, entry, reason),
      flushQueues: flush,
    })
    outbox.subscribe(() => {
      for (const listener of [...listeners]) listener()
    })
    const applyQueued = (
      base: readonly unknown[],
      entries: readonly AnyEntry[],
      scope?: string,
    ): unknown[] => {
      let items = [...base]
      for (const entry of entries) {
        if (scope !== undefined && definition.inScope && !definition.inScope(entry, scope)) continue
        if (entry.kind === "delete") {
          items = items.filter((item) => definition.itemId(item) !== entry.entityId)
          continue
        }
        const at = items.findIndex((item) => definition.itemId(item) === entry.entityId)
        if (at !== -1) items[at] = definition.applyEdit(items[at], entry)
        else if (entry.kind === "create") items.unshift(definition.queuedItem(entry))
      }
      return items
    }
    return {
      name: definition.name,
      definition,
      store,
      outbox,
      bound: {
        name: definition.name,
        outbox,
        store,
        applyQueued,
        overlay: async (base, scope) => applyQueued(base, await store.readOutbox(), scope),
      },
    }
  }

  type Blocker = WaitingEntry["blockedBy"][number]

  /** The parent entries an entry waits for, looked up in `entriesOf`. */
  function blockersFrom(
    definition: AnyDefinition,
    entry: AnyEntry,
    entriesOf: (collection: string) => readonly AnyEntry[],
  ): Blocker[] {
    const dependencies = definition.dependencies
    if (!dependencies) return []
    const found: Blocker[] = []
    for (const ref of dependencies.on(entry)) {
      if (!dependencies.parents.includes(ref.collection)) {
        throw new Error(
          `Collection "${definition.name}" refers to "${ref.collection}", which is not one of its parents`,
        )
      }
      const parent = entriesOf(ref.collection).find((queued) => queued.entityId === ref.entityId)
      if (parent) found.push({ ...ref, status: parent.status })
    }
    return found
  }

  /** Whether nothing a write refers to is still queued, read from the stores now. */
  async function isReady(definition: AnyDefinition, entry: AnyEntry): Promise<boolean> {
    const stored = new Map<string, readonly AnyEntry[]>()
    for (const parent of definition.dependencies?.parents ?? []) {
      stored.set(parent, await byName.get(parent)!.store.readOutbox())
    }
    return blockersFrom(definition, entry, (collection) => stored.get(collection) ?? []).length ===
      0
  }

  /** Removes the reference to a create that left the queue unsent from every dependent entry. */
  async function removeReferences(
    collection: string,
    gone: AnyEntry,
    reason: AbandonReason,
  ): Promise<void> {
    const parent: EntityRef = { collection, entityId: gone.entityId }
    for (const runtime of runtimes) {
      const dependencies = runtime.definition.dependencies
      if (!dependencies?.parents.includes(collection)) continue
      const changed: EntityRef[] = []
      await lock(async () => {
        for (const queued of await runtime.store.readOutbox()) {
          if (!dependencies.on(queued).some((ref) => sameRef(ref, parent))) continue
          const payload = dependencies.without(queued.payload, parent)
          if (payload === queued.payload) continue
          await runtime.store.putEntry({
            ...queued,
            payload,
            before: mapChain(queued.before, (p) => dependencies.without(p, parent)),
            // `key` and `attempted` stay: a send of this entry may have reached the server, and the
            // outbox must go on treating the entity as possibly there (a delete is queued, a
            // withdraw refused). The server ignores ids it does not know, so a repeat of the old
            // key answers as the stripped write would.
          })
          changed.push({ collection: runtime.name, entityId: queued.entityId })
        }
      })
      if (changed.length === 0) continue
      await runtime.outbox.reload()
      options.onReferenceRemoved?.({ parent, reason, children: changed })
    }
  }

  async function flush(): Promise<void> {
    for (const runtime of runtimes) await runtime.outbox.flush()
  }

  function waiting(): WaitingEntry[] {
    const cached = (collection: string) => byName.get(collection)!.outbox.entries()
    const waiting: WaitingEntry[] = []
    for (const runtime of runtimes) {
      for (const entry of runtime.outbox.entries()) {
        if (entry.status !== "pending") continue
        const blockedBy = blockersFrom(runtime.definition, entry, cached)
        if (blockedBy.length === 0) continue
        waiting.push({
          collection: runtime.name,
          entityId: entry.entityId,
          blockedBy,
          onPerson: blockedBy.some((blocker) => blocker.status === "conflict"),
        })
      }
    }
    return waiting
  }

  async function syncFlush(): Promise<SyncFlushResult> {
    await flush()
    const held = new Set(waiting().map((w) => `${w.collection}\0${w.entityId}`))
    const stuck = runtimes.some((runtime) =>
      runtime.outbox.entries().some((entry) =>
        entry.status === "pending" && !held.has(`${runtime.name}\0${entry.entityId}`)
      )
    )
    return stuck ? "unreachable" : undefined
  }

  function get<P, S extends { version: number }, Item>(
    definition: CollectionDefinition<P, S, Item>,
  ): Collection<P, S, Item> {
    const runtime = byDefinition.get(definition)
    if (!runtime) throw new Error(`Collection "${definition.name}" is not registered`)
    return runtime.bound as unknown as Collection<P, S, Item>
  }

  return {
    get,
    async reload() {
      for (const runtime of runtimes) await runtime.outbox.reload()
    },
    flush,
    syncFlush,
    waiting,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
