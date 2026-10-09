/**
 * An offline outbox for client commands: an ordered queue of writes made while the connection was
 * down, sent later with idempotency keys. It knows nothing about what an entity is: the payload is
 * a type parameter, the entity id is a string the caller chooses, and the transport, the cache of
 * server state, the lock and the storage are ports.
 *
 * The rules, each found as a lost edit in a product that copied the queue by hand:
 *
 * - **One entry per entity.** A later edit of an entity that has not been sent replaces the earlier
 *   one, so the queue holds what the person wants and nothing to replay in between.
 * - **A fresh key after an unknown outcome.** Every send carries the entry's idempotency key. An
 *   entry whose send may have reached the server (`attempted`) gets a new key when it is changed
 *   again, because the server would answer the old key with the first result and drop the new
 *   text. If the first send had in fact been applied, the result is a visible conflict.
 * - **Clear only while the key still matches.** After a send, the entry is removed or marked a
 *   conflict only if the queue still holds it with the key that was sent. An edit another tab made
 *   meanwhile has a new key and stays queued.
 * - **One writer at a time.** Every step on the queue runs under a {@link OutboxLock}: a promise
 *   chain in one tab, Web Locks across the tabs of one browser.
 * - **Conflicts wait for a person.** A write the server refuses as stale or for another reason is
 *   marked, never applied over the other side. The person chooses `keepMine` or `useTheirs`.
 *
 * @module
 */

/** What an outgoing write does to an entity. */
export type OutboxKind = "create" | "update" | "delete"

/**
 * Why a write stopped the queue for its entity and now waits for a person:
 * - `version`: the entity changed on the server since this write was based on it;
 * - `gone`: the entity was deleted on the server;
 * - `rejected`: the server refused the write (for example the role no longer allows it).
 */
export type ConflictReason = "version" | "gone" | "rejected"

/** The parts of an {@link OutboxEntry} that an edit merged into it changes. */
export interface OutboxEntrySnapshot<P> {
  key: string
  kind: OutboxKind
  payload: P
  baseVersion: number
  attempted: boolean
  /** The snapshot's own step back, so `withdraw` walks back one merged edit at a time. */
  before?: OutboxEntrySnapshot<P>
}

/** Whether a send of this write, or of any write merged into it, was started. */
function mayHaveReachedServer<P>(entry: OutboxEntrySnapshot<P>): boolean {
  for (let step: OutboxEntrySnapshot<P> | undefined = entry; step; step = step.before) {
    if (step.attempted) return true
  }
  return false
}

/**
 * One write made while offline, waiting to be sent. `P` is the caller's payload (what the person
 * wrote), `S` the server's snapshot of the entity.
 */
export interface OutboxEntry<P, S> {
  /** Send order. Assigned by the store when the entry is first saved. */
  seq?: number
  /** The idempotency key the write is sent with, so a send that is repeated runs once. */
  key: string
  entityId: string
  kind: OutboxKind
  /** The entity's content as this person wrote it; for a delete, what it had when deleted. */
  payload: P
  /** The version the write was made on top of; `0` for a create. */
  baseVersion: number
  /** Whether a send was started: its outcome may be unknown, so the key must not be reused. */
  attempted: boolean
  status: "pending" | "conflict"
  /**
   * What the entry was just before the latest edit was merged into it, so `withdraw` can take that
   * edit back and keep the write before it. Each snapshot carries its own `before`, a chain back to
   * the first write. Absent on an entry no edit was merged into.
   */
  before?: OutboxEntrySnapshot<P>
  conflict?: { reason: ConflictReason; message: string; server: S | null }
  queuedAt: string
}

/**
 * Where the queue is kept. Browsers back it with IndexedDB; {@link createMemoryOutboxStore} serves
 * tests and servers. A store belongs to one signed-in user: never share one across users.
 */
export interface OutboxStore<P, S> {
  /** Every waiting write, in send order. */
  readOutbox(): Promise<OutboxEntry<P, S>[]>
  /** Saves an entry; one without `seq` goes to the end of the queue. Resolves the saved entry. */
  putEntry(entry: OutboxEntry<P, S>): Promise<OutboxEntry<P, S>>
  removeEntry(seq: number): Promise<void>
}

/** Runs `work` while no other caller holds the queue. */
export type OutboxLock = <T>(work: () => Promise<T>) => Promise<T>

/** The part of a browser's `LockManager` the outbox uses. `navigator.locks` fits it. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

/**
 * How the outbox reads a failed send:
 * - `unreachable`: the outcome is unknown or the server was busy; keep the entry and stop;
 * - `version`: the write was based on a version the server has moved past;
 * - `not-found`: the entity does not exist on the server;
 * - `already-exists`: a create hit an id that is taken;
 * - `rejected`: the server refused it for good; `message` says why.
 */
export type SendFailure =
  | { kind: "unreachable" }
  | { kind: "version" }
  | { kind: "not-found" }
  | { kind: "already-exists" }
  | { kind: "rejected"; message: string }

/** The conflict a person was shown: an {@link OutboxEntry} from `entries()` fits. */
export interface ConflictRef {
  /** Saved entries have one; an entry without it matches nothing. */
  seq?: number
  key: string
}

/** The command the app sends for one entry. */
export interface OutboxCommand<P> {
  kind: OutboxKind
  entityId: string
  payload: P
  /** The version the write is based on; `0` for a create. */
  baseVersion: number
}

/** What a person did to an entity. A change to an existing entity names the version it saw. */
export type Change<P> =
  | { kind: "create"; entityId: string; payload: P }
  | { kind: "update" | "delete"; entityId: string; payload: P; version: number }

/** How a change ended for the person who made it. */
export type Outcome<S> =
  /** The server took it. `server` is its answer (none for a delete). */
  | { kind: "sent"; server?: S }
  /** It is saved on this device and goes out when the connection is back. */
  | { kind: "queued" }
  /** It never reached the server: created and deleted before any send. */
  | { kind: "dropped" }
  /** The server refused it. Nothing is queued; `error` is what the send threw. */
  | { kind: "failed"; error: unknown }

/** What the outbox needs from the outside. Injected so tests need no network or IndexedDB. */
export interface OutboxPorts<P, S extends { version: number }> {
  store: OutboxStore<P, S>
  /**
   * Sends one command over the connection with the idempotency key. One try; the outbox retries.
   * Resolves the server's entity as it is after the write, or nothing (a delete has none).
   * It runs under the lock, so it must settle or time out: one that never does blocks every
   * `submit` in every tab that shares the lock.
   */
  send(command: OutboxCommand<P>, idempotencyKey: string): Promise<S | undefined | void>
  /** The server's entity as it is now, or `null` when it is gone. Rejects when unreachable. */
  fetchServer(entityId: string): Promise<S | null>
  /** Reads a thrown error: retry later, or the server's refusal. */
  classify(error: unknown): SendFailure
  /** See {@link OutboxLock}. */
  lock: OutboxLock
  /**
   * Whether a write may start now: the connection is open and the page is signed in as the
   * queue's user. A write is not started while it is not: nothing left the device, and a queue
   * must never be sent as someone else.
   */
  canSend(): boolean
  /**
   * Keeps the app's cache of server state in step with answers: `put` after a send returns the
   * entity or after a conflict choice, `remove` after a delete.
   */
  cache?: {
    put(server: S): Promise<void>
    remove(entityId: string): Promise<void>
  }
  /** A fresh idempotency key. Defaults to `crypto.randomUUID`. */
  newKey?(): string
  /** The current time as an ISO string. Defaults to the system clock. */
  now?(): string
  /** Replaces the default English wording of a conflict. */
  messages?: Partial<Record<ConflictReason, string>>
}

const DEFAULT_MESSAGES: Record<ConflictReason, string> = {
  version: "This item changed on the server while you were offline.",
  gone: "This item was deleted on the server while you were offline.",
  rejected: "The server did not accept this change.",
}

/** A lock for one tab: runs the work one piece at a time, in the order asked. */
export function createPromiseLock(): OutboxLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>) => {
    const run = tail.then(work)
    tail = run.catch(() => {})
    return run
  }
}

/**
 * A lock shared by every tab of one browser, through Web Locks. Name it for the user, so two users
 * of one browser do not wait for each other: `createWebLock(navigator.locks, `outbox:${userId}`)`.
 */
export function createWebLock(locks: LockManagerLike, name: string): OutboxLock {
  return <T>(work: () => Promise<T>) => locks.request(name, work)
}

/** A store in memory, with the behaviour of the IndexedDB one that the queue relies on. */
export function createMemoryOutboxStore<P, S>(): OutboxStore<P, S> {
  let outbox: OutboxEntry<P, S>[] = []
  let nextSeq = 1
  return {
    readOutbox: () => Promise.resolve(structuredClone(outbox)),
    putEntry(entry) {
      const saved = structuredClone({ ...entry, seq: entry.seq ?? nextSeq++ })
      const at = outbox.findIndex((existing) => existing.seq === saved.seq)
      if (at === -1) outbox.push(saved)
      else outbox[at] = saved
      return Promise.resolve(structuredClone(saved))
    },
    removeEntry(seq) {
      outbox = outbox.filter((entry) => entry.seq !== seq)
      return Promise.resolve()
    },
  }
}

/** The outbox as the app uses it. */
export interface Outbox<P, S extends { version: number }> {
  /** The waiting writes as of the last change to the queue. */
  entries(): readonly OutboxEntry<P, S>[]
  /** Calls `listener` after every change to the queue. Returns the way to stop. */
  subscribe(listener: (entries: readonly OutboxEntry<P, S>[]) => void): () => void
  /** Reads the queue from the store, for example after a restart. */
  reload(): Promise<OutboxEntry<P, S>[]>
  /** Records a change and sends it when the connection allows. */
  submit(change: Change<P>): Promise<Outcome<S>>
  /**
   * Sends every waiting write in order, stopping at the first that cannot reach the server.
   * Call it after a change, after a reconnect and after every push that is news.
   */
  flush(): Promise<void>
  /**
   * Takes back the waiting write of an entity, for example an "Undo" of a delete made offline.
   * Takes back the latest change and resolves `true`. When that change was merged into an earlier
   * waiting write (an edit, then a delete), only the delete is taken back and the edit stays
   * queued, as it was, key included. Each call takes back one more merged change. Otherwise the
   * entry is removed and will never be sent.
   * Resolves `false`, changing nothing, when there is nothing to take back or it cannot be: the
   * entry's send was started (its outcome may be unknown, so the server may have it) or it is a
   * conflict (settle it with `keepMine` or `useTheirs`). A create that was deleted before any send
   * leaves nothing queued: submit the create again. The caller otherwise falls back to asking the
   * server, for example an online restore.
   */
  withdraw(entityId: string): Promise<boolean>
  /** Sends the person's version again on the server's: see `ConflictRef`. Stale cards do nothing. */
  keepMine(shown: ConflictRef): Promise<void>
  /** Drops the person's version and shows the server's. Stale cards do nothing. */
  useTheirs(shown: ConflictRef): Promise<void>
}

/** The queue: see the module documentation for the rules it keeps. */
export function createOutbox<P, S extends { version: number }>(
  ports: OutboxPorts<P, S>,
): Outbox<P, S> {
  const { store, cache } = ports
  const newKey = ports.newKey ?? (() => crypto.randomUUID())
  const now = ports.now ?? (() => new Date().toISOString())
  const messages = { ...DEFAULT_MESSAGES, ...ports.messages }
  const locked = ports.lock
  type Entry = OutboxEntry<P, S>
  let current: readonly Entry[] = []
  const listeners = new Set<(entries: readonly Entry[]) => void>()
  const interactive = new Set<number>()
  const outcomes = new Map<number, Outcome<S>>()

  async function find(seq: number): Promise<Entry | undefined> {
    return (await store.readOutbox()).find((entry) => entry.seq === seq)
  }

  /** The entry, only while it is still the conflict the caller was shown. */
  async function findConflict(shown: ConflictRef): Promise<Entry | undefined> {
    if (shown.seq === undefined) return undefined
    const entry = await find(shown.seq)
    return entry?.status === "conflict" && entry.key === shown.key ? entry : undefined
  }

  /** Whether the queue still holds the entry as it was sent: same entry, same idempotency key. */
  async function unchanged(sent: Entry): Promise<boolean> {
    return (await find(sent.seq!))?.key === sent.key
  }

  async function reload(): Promise<Entry[]> {
    const all = await store.readOutbox()
    current = all
    for (const listener of listeners) listener(all)
    return all
  }

  async function save(entry: Entry): Promise<Entry> {
    const saved = await store.putEntry(entry)
    await reload()
    return saved
  }

  async function drop(seq: number): Promise<void> {
    await store.removeEntry(seq)
    await reload()
  }

  /** Records a change in the queue, merging it with the entity's waiting entry. */
  async function enqueue(change: Change<P>): Promise<Entry | null> {
    const existing = (await store.readOutbox()).find((entry) => entry.entityId === change.entityId)
    if (!existing) {
      return await save({
        key: newKey(),
        entityId: change.entityId,
        kind: change.kind,
        payload: change.payload,
        baseVersion: change.kind === "create" ? 0 : change.version,
        attempted: false,
        status: "pending",
        queuedAt: now(),
      })
    }
    // A deleted entity is not edited again.
    if (existing.kind === "delete" || change.kind === "create") return existing
    const before: OutboxEntrySnapshot<P> = {
      key: existing.key,
      kind: existing.kind,
      payload: existing.payload,
      baseVersion: existing.baseVersion,
      attempted: existing.attempted,
      before: existing.before,
    }
    const renewed = existing.attempted
      ? { key: newKey(), attempted: false }
      : { key: existing.key, attempted: false }
    if (change.kind === "update") {
      return await save({ ...existing, payload: change.payload, ...renewed, before })
    }
    if (existing.kind === "create") {
      // A create is on the server only if a send of it, before or after a merged edit, was started.
      if (!mayHaveReachedServer(existing)) {
        await drop(existing.seq!)
        return null
      }
      // The create may have reached the server, so the entity may exist there: delete version 1.
      return await save({
        ...existing,
        payload: change.payload,
        kind: "delete",
        baseVersion: 1,
        key: newKey(),
        attempted: false,
        status: "pending",
        conflict: undefined,
        before,
      })
    }
    return await save({
      ...existing,
      payload: change.payload,
      kind: "delete",
      ...renewed,
      before,
    })
  }

  /** Marks an entry as waiting for a person's decision. */
  async function markConflict(
    entry: Entry,
    reason: ConflictReason,
    server: S | null,
    message = messages[reason],
  ): Promise<void> {
    await save({ ...entry, status: "conflict", conflict: { reason, message, server } })
  }

  /** Sends one entry. Resolves `false` when the queue must stop here. */
  async function sendOne(seq: number): Promise<boolean> {
    const entry = await find(seq)
    if (!entry || entry.status !== "pending") return true
    if (!ports.canSend()) return false
    const wants = interactive.has(seq)
    // Saved before the send: a page closed mid-send must not repeat it under a new key.
    const sending = await save({ ...entry, attempted: true })
    try {
      const server = await ports.send({
        kind: sending.kind,
        entityId: sending.entityId,
        payload: sending.payload,
        baseVersion: sending.baseVersion,
      }, sending.key) ?? undefined
      if (sending.kind === "delete") await cache?.remove(sending.entityId)
      else if (server) await cache?.put(server)
      // Another tab may have replaced the entry with a newer edit while this send ran: that edit
      // has its own key and must stay queued.
      if (await unchanged(sending)) await drop(seq)
      if (wants) {
        outcomes.set(seq, { kind: "sent", server: sending.kind === "delete" ? undefined : server })
      }
      return true
    } catch (error) {
      const failure = ports.classify(error)
      if (failure.kind === "unreachable") return false
      return await refuse(sending, error, failure, wants)
    }
  }

  /** Handles a refusal by the server. Resolves `false` when the server could not be asked more. */
  async function refuse(
    entry: Entry,
    error: unknown,
    failure: Exclude<SendFailure, { kind: "unreachable" }>,
    wants: boolean,
  ): Promise<boolean> {
    if (!await unchanged(entry)) return true
    if (failure.kind === "not-found" && entry.kind === "delete") {
      await cache?.remove(entry.entityId)
      await drop(entry.seq!)
      if (wants) outcomes.set(entry.seq!, { kind: "sent" })
      return true
    }
    if (wants) {
      // The person is looking at the screen: the app shows the refusal itself.
      await drop(entry.seq!)
      outcomes.set(entry.seq!, { kind: "failed", error })
      return true
    }
    let reason: ConflictReason = "rejected"
    let server: S | null = null
    const stale = failure.kind === "version" ||
      (failure.kind === "already-exists" && entry.kind === "create")
    if (stale || failure.kind === "not-found") {
      try {
        server = await ports.fetchServer(entry.entityId)
      } catch (_unreachable) {
        return false
      }
      // The answer took a round trip: an edit made meanwhile has a new key and must stay queued.
      if (!await unchanged(entry)) return true
      reason = server ? "version" : "gone"
    }
    await markConflict(
      entry,
      reason,
      server,
      reason === "rejected" && failure.kind === "rejected" ? failure.message : undefined,
    )
    return true
  }

  /**
   * Sends every waiting write in order, stopping at the first that cannot reach the server.
   * Call it after a change, after a reconnect and after every push that is news.
   */
  async function flush(): Promise<void> {
    // `sendOne` skips an entry that is not pending, as the queue stands when its turn comes.
    for (const entry of await locked(reload)) {
      const goOn = await locked(() => sendOne(entry.seq!))
      if (!goOn) return
    }
  }

  /** Records a change and sends it when the connection allows. */
  async function submit(change: Change<P>): Promise<Outcome<S>> {
    const entry = await locked(async () => {
      const queued = await enqueue(change)
      // Marked inside the same step, so no send can settle the entry before it is watched.
      if (queued) interactive.add(queued.seq!)
      return queued
    })
    if (!entry) return { kind: "dropped" }
    try {
      await flush()
      return outcomes.get(entry.seq!) ?? { kind: "queued" }
    } finally {
      interactive.delete(entry.seq!)
      outcomes.delete(entry.seq!)
    }
  }

  /**
   * Sends the person's version again, on top of the server's current one. `shown` is the conflict
   * the person saw; nothing happens unless the queue still holds that conflict under that key
   * (another tab may have settled it, or the person edited again). Does nothing for a `gone` or
   * `rejected` conflict, which has no server entity to build on: use `useTheirs` there.
   */
  async function keepMine(shown: ConflictRef): Promise<void> {
    await locked(async () => {
      const entry = await findConflict(shown)
      const server = entry?.conflict?.server
      if (!entry || !server) return
      await cache?.put(server)
      await save({
        ...entry,
        kind: entry.kind === "delete" ? "delete" : "update",
        baseVersion: server.version,
        key: newKey(),
        attempted: false,
        status: "pending",
        conflict: undefined,
        before: undefined,
      })
    })
    await flush()
  }

  /**
   * Drops the person's version and shows the server's. `shown` is the conflict the person saw;
   * nothing happens unless the queue still holds that conflict under that key, so a stale screen
   * cannot delete a newer edit.
   */
  async function useTheirs(shown: ConflictRef): Promise<void> {
    await locked(async () => {
      const entry = await findConflict(shown)
      if (!entry) return
      const server = entry.conflict?.server
      if (server) await cache?.put(server)
      else if (entry.conflict?.reason === "gone") await cache?.remove(entry.entityId)
      await drop(entry.seq!)
    })
  }

  async function withdraw(entityId: string): Promise<boolean> {
    return await locked(async () => {
      const entry = (await store.readOutbox()).find((e) => e.entityId === entityId)
      if (!entry || entry.attempted || entry.status !== "pending") return false
      if (!entry.before) {
        await drop(entry.seq!)
        return true
      }
      // An edit was merged into the entry: take back that edit only, and keep the write before it
      // (with its key and `attempted`, so a send that may have happened is repeated idempotently).
      // The restored write keeps its own step back, so the next withdraw takes back one more edit.
      await save({ ...entry, ...entry.before, before: entry.before.before })
      return true
    })
  }

  return {
    /** The waiting writes as of the last change to the queue. */
    entries: (): readonly Entry[] => current,
    /** Calls `listener` after every change to the queue. Returns the way to stop. */
    subscribe(listener: (entries: readonly Entry[]) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Reads the queue from the store, for example after a restart. */
    reload: () => locked(reload),
    submit,
    flush,
    withdraw,
    keepMine,
    useTheirs,
  }
}
