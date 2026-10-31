/**
 * The cursor pull of ADR 002: a device that holds a copy of a group's lists asks only for what
 * changed after the sequence it holds, instead of reading every list again on every start,
 * reconnect and hint. Generic over the list kinds: an app names its kinds (notes, tags, members,
 * transactions) and how to check and identify a row of each.
 *
 * - **The wire.** {@link changesAnswerSchema} is the answer to "changes of this group after `after`":
 *   either a {@link ChangesPage} (rows created or changed, {@link Tombstone tombstones} of rows
 *   deleted or gone from the group, the sequence the page is complete through, the group's current
 *   sequence and whether more pages follow), or a {@link CursorTooOld} answer when the server can no
 *   longer say what changed after that cursor (its deletion log was cut, the database was restored).
 * - **The server.** {@link changesAfterSchema} reads the `after` a request carries;
 *   {@link planChangesPage} decides which sequences one page covers. The queries stay in the app.
 * - **The device.** {@link createChangesCopy} keeps each group's rows and the sequence they are
 *   complete through in one IndexedDB database, written together. {@link createChangesPull} pulls
 *   `after=<cursor>`, applies each page and pages until done. It reads in full (from `0`) when the
 *   device has no copy of the group or the server answers {@link CursorTooOld}, and then replaces
 *   the copy once the last page is in.
 *
 * Sequences are the group's change sequence (1-based; `0` means "from the beginning"), as numbers:
 * a safe integer is far beyond what one group reaches.
 *
 * @module
 */

import { type Out, type Type, type } from "arktype"
import { createDataCache } from "@spy4x/platform/browser/data-cache"
import { createPromiseLock, type OutboxLock } from "./outbox.ts"

/** A row that was deleted, or left the group, after the cursor: its kind and id, nothing else. */
export interface Tombstone {
  kind: string
  id: string
}

/** One page of the changes of a group after a sequence. */
export interface ChangesPage {
  status: "changes"
  /** The `after` this page answers. */
  after: number
  /**
   * The page holds every change in `(after, through]`: the cursor to store once it is applied, and
   * the `after` of the next page.
   */
  through: number
  /** The group's current change sequence when the page was read. */
  current: number
  /** Whether changes after `through` remain: ask again with `after=through`. */
  more: boolean
  /** The current state of each row created or changed in the window, by kind. */
  upserts: Record<string, unknown[]>
  /** The rows deleted, or gone from the group, in the window. */
  tombstones: Tombstone[]
}

/** The server cannot say what changed after this cursor: read the group in full. */
export interface CursorTooOld {
  status: "too-old"
  /** The group's current change sequence. */
  current: number
}

/** The answer to a changes request. */
export type ChangesAnswer = ChangesPage | CursorTooOld

const sequence = "number.safe >= 0"

/**
 * The wire shape of {@link ChangesAnswer}. A server checks its own answer with it in tests; the
 * client checks every answer with it before applying anything. Rows are checked by each kind's own
 * type ({@link ChangesKind.row}), since only the app knows them.
 */
export const changesAnswerSchema: Type<ChangesAnswer> = type({
  status: "'changes'",
  after: sequence,
  through: sequence,
  current: sequence,
  more: "boolean",
  upserts: "Record<string, unknown[]>",
  tombstones: type({ kind: "string > 0", id: "string > 0" }).array(),
}).or({ status: "'too-old'", current: sequence })

/**
 * Reads the `after` of a request (a query parameter): a non-negative safe integer written in plain
 * digits, without a sign, a fraction, an exponent or a leading zero. Anything else is an error, and
 * the server answers it with a bad request.
 */
export const changesAfterSchema: Type<(In: string) => Out<number>> = type(/^(0|[1-9]\d{0,15})$/)
  .pipe((digits) => Number(digits))
  .to(sequence)

/** What {@link planChangesPage} is given: three numbers the app reads in one snapshot. */
export interface ChangesPagePlanInput {
  /** The cursor the device sent. */
  after: number
  /** The group's current change sequence (the last one taken, not the next free one). */
  current: number
  /**
   * The lowest `after` above `0` the server can still answer: below it, deletions were forgotten.
   * `0` while nothing was ever forgotten. `after=0` is always answered, whatever `oldest` is: a
   * device with no copy needs no tombstones.
   */
  oldest: number
  /**
   * The change sequence of the change after the first `limit` ones in `(after, current]`, across
   * every kind and tombstone, in sequence order; `null` when there are at most `limit`.
   */
  boundary: number | null
}

/** What one page covers, or that the cursor cannot be answered. */
export type ChangesPagePlan =
  | { status: "changes"; through: number; more: boolean }
  | { status: "too-old" }

/**
 * Decides the window of one page: `(after, through]`. A page never splits one sequence, so its
 * cursor is exact; the price is that a sequence with more than `limit` changes (one large import)
 * comes on one page, whatever its size. A cursor above `0` and below `oldest`, or above `current` (the server was
 * restored from an older backup), is too old.
 *
 * The app then reads every row and tombstone with `after < change_sequence <= through`, in the same
 * snapshot as `current` and `boundary` (a repeatable-read transaction), and answers
 * `{ status: "changes", after, through, current, more, upserts, tombstones }`.
 */
export function planChangesPage(input: ChangesPagePlanInput): ChangesPagePlan {
  const { after, current, oldest, boundary } = input
  if ((after > 0 && after < oldest) || after > current) return { status: "too-old" }
  if (boundary === null) return { status: "changes", through: current, more: false }
  const through = boundary - 1 > after ? boundary - 1 : boundary
  return { status: "changes", through, more: through < current }
}

/** How the device reads one kind of row. */
export interface ChangesKind<Row> {
  /** Checks a row of the answer; an arktype type fits. Throws when the row does not match. */
  row: { assert(value: unknown): Row }
  /** The row's id, unique within its kind and group. */
  id(row: Row): string
}

/** Every kind an app pulls, by name: the names the server uses in `upserts` and tombstones. */
export type ChangesKinds<Rows> = { readonly [K in keyof Rows]: ChangesKind<Rows[K]> }

/** Rows by kind. */
export type RowsByKind<Rows> = { [K in keyof Rows]: Rows[K][] }

/** One checked page, as the copy applies it. */
export interface ChangesApply<Rows> {
  upserts: RowsByKind<Rows>
  /** Tombstones of the kinds the app knows. */
  tombstones: { kind: keyof Rows & string; id: string }[]
  /** The cursor the copy is complete through once this is applied. */
  through: number
}

/** The device's copy of each group's rows and the sequence they are complete through. */
export interface ChangesCopy<Rows> {
  /** The sequence the copy of the group is complete through, or `undefined` when there is none. */
  cursor(groupId: string): Promise<number | undefined>
  /** Every row of one kind of the group. Order: a full read's, then rows added since. */
  read<K extends keyof Rows & string>(kind: K, groupId: string): Promise<Rows[K][]>
  /** Puts the upserts, removes the tombstoned rows and stores `through`, all or nothing. */
  apply(groupId: string, change: ChangesApply<Rows>): Promise<void>
  /** Makes the group's copy hold exactly `rows` at `through`, all or nothing. */
  replace(groupId: string, rows: RowsByKind<Rows>, through: number): Promise<void>
  /** Removes the group's copy and cursor, for a group the person may no longer read. */
  drop(groupId: string): Promise<void>
  /** Removes every copy and finishes the instance, for sign-out (`DataCache.finish`). */
  clear(): Promise<void>
}

/** Options of {@link createChangesCopy}. */
export interface ChangesCopyOptions<Rows> {
  /** The database name, for example `offline:user:7:changes`. One database per user. */
  name: string
  kinds: ChangesKinds<Rows>
  /** The factory to open with. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
}

interface Stored {
  key: string
  value: unknown
}

const CURSORS = "cursors"

/**
 * A {@link ChangesCopy} over IndexedDB (`createDataCache`): one scope per kind and group, and the
 * cursors in a scope of their own, so rows and cursor land in one transaction. A crash can never
 * leave a cursor ahead of its rows.
 */
export function createChangesCopy<Rows>(options: ChangesCopyOptions<Rows>): ChangesCopy<Rows> {
  const kinds = Object.keys(options.kinds) as (keyof Rows & string)[]
  const store = createDataCache<Stored>({
    name: options.name,
    getId: (stored) => stored.key,
    indexedDB: options.indexedDB,
  })
  const scope = (kind: string, groupId: string) => JSON.stringify([kind, groupId])
  const idOf = (kind: keyof Rows, row: unknown) =>
    (options.kinds[kind] as ChangesKind<unknown>).id(row)
  const putCursor = (groupId: string, through: number) => ({
    op: "put" as const,
    scope: CURSORS,
    item: { key: groupId, value: through },
  })

  return {
    async cursor(groupId) {
      const stored = await store.get(CURSORS, groupId)
      return typeof stored?.value === "number" ? stored.value : undefined
    },
    async read(kind, groupId) {
      return (await store.read(scope(kind, groupId))).map((stored) => stored.value) as never
    },
    apply(groupId, change) {
      return store.batch([
        ...kinds.flatMap((kind) =>
          (change.upserts[kind] ?? []).map((row) => ({
            op: "put" as const,
            scope: scope(kind, groupId),
            item: { key: idOf(kind, row), value: row },
          }))
        ),
        ...change.tombstones.map((gone) => ({
          op: "delete" as const,
          scope: scope(gone.kind, groupId),
          id: gone.id,
        })),
        putCursor(groupId, change.through),
      ])
    },
    replace(groupId, rows, through) {
      return store.batch([
        ...kinds.map((kind) => ({
          op: "replace" as const,
          scope: scope(kind, groupId),
          items: (rows[kind] ?? []).map((row) => ({ key: idOf(kind, row), value: row })),
        })),
        putCursor(groupId, through),
      ])
    },
    drop(groupId) {
      return store.batch([
        ...kinds.map((kind) => ({ op: "clear" as const, scope: scope(kind, groupId) })),
        { op: "delete", scope: CURSORS, id: groupId },
      ])
    },
    clear: () => store.finish(),
  }
}

/** Options of {@link createChangesPull}. */
export interface ChangesPullOptions<Rows> {
  kinds: ChangesKinds<Rows>
  copy: ChangesCopy<Rows>
  /**
   * Asks the server for the changes of `groupId` after `after` and resolves with its answer as
   * received, over REST or the socket. A refusal rejects, and reaches the caller of the pull.
   */
  fetch(groupId: string, after: number): Promise<unknown>
  /**
   * Runs one pull at a time, so two pulls never apply pages out of order. Default: one lock for
   * this tab. Tabs that share the copy share a Web Lock (`createWebLock` of `./outbox`).
   */
  lock?: OutboxLock
}

/** What one pull did. */
export interface ChangesPullResult {
  /** `incremental` from the stored cursor, or `full` from `0` (no copy, or the cursor too old). */
  mode: "incremental" | "full"
  /** The cursor the copy is complete through now. */
  cursor: number
  /** Answers read. */
  pages: number
  /** Rows put and tombstones applied (in a full read, every row the copy now holds). */
  upserts: number
  tombstones: number
}

/** A full read restarts once when the server cuts its log meanwhile; a second cut is an error. */
const FULL_READ_ATTEMPTS = 2

/**
 * The client side of the cursor pull: see the module documentation. The returned function pulls
 * one group and resolves when its copy is complete through the group's current sequence. It
 * rejects, leaving the copy as it was after the last page applied, when `fetch` rejects or an answer
 * does not match the wire shape, a row does not match its kind, or a page does not move forward.
 */
export function createChangesPull<Rows>(
  options: ChangesPullOptions<Rows>,
): (groupId: string) => Promise<ChangesPullResult> {
  const { copy } = options
  const lock = options.lock ?? createPromiseLock()
  const kinds = Object.keys(options.kinds) as (keyof Rows & string)[]

  async function page(groupId: string, after: number): Promise<ChangesApply<Rows> & ChangesPage> {
    const answer = changesAnswerSchema.assert(await options.fetch(groupId, after))
    if (answer.status === "too-old") throw new CursorTooOldSignal()
    if (
      answer.after !== after || answer.through < after || answer.through > answer.current ||
      (answer.more && answer.through === after) ||
      (!answer.more && answer.through !== answer.current)
    ) {
      throw new Error(
        `The changes of group ${groupId} after ${after} do not move forward: through ${answer.through}, current ${answer.current}, more ${answer.more}`,
      )
    }
    const upserts = {} as RowsByKind<Rows>
    for (const kind of kinds) {
      const check = options.kinds[kind] as ChangesKind<unknown>
      upserts[kind] = (answer.upserts[kind] ?? []).map((row) => check.row.assert(row)) as never
    }
    // A kind this app does not know (a newer server) is left out, rows and tombstones alike.
    const tombstones = answer.tombstones.filter((gone) =>
      (kinds as string[]).includes(gone.kind)
    ) as ChangesApply<Rows>["tombstones"]
    return { ...answer, upserts, tombstones }
  }

  async function full(groupId: string, attempt = 1): Promise<ChangesPullResult> {
    const rows = new Map(kinds.map((kind) => [kind, new Map<string, unknown>()]))
    let after = 0
    let pages = 0
    try {
      for (;;) {
        const next = await page(groupId, after)
        pages++
        for (const kind of kinds) {
          const id = (options.kinds[kind] as ChangesKind<unknown>).id
          for (const row of next.upserts[kind]) rows.get(kind)!.set(id(row), row)
        }
        for (const gone of next.tombstones) rows.get(gone.kind)!.delete(gone.id)
        after = next.through
        if (!next.more) break
      }
    } catch (error) {
      if (error instanceof CursorTooOldSignal && attempt < FULL_READ_ATTEMPTS) {
        return await full(groupId, attempt + 1)
      }
      if (error instanceof CursorTooOldSignal) {
        throw new Error(`The server answered "too old" to a full read of group ${groupId}`)
      }
      throw error
    }
    const result = {} as RowsByKind<Rows>
    let upserts = 0
    for (const kind of kinds) {
      result[kind] = [...rows.get(kind)!.values()] as never
      upserts += result[kind].length
    }
    await copy.replace(groupId, result, after)
    return { mode: "full", cursor: after, pages, upserts, tombstones: 0 }
  }

  async function incremental(groupId: string, held: number): Promise<ChangesPullResult> {
    let after = held
    let pages = 0
    let upserts = 0
    let tombstones = 0
    try {
      for (;;) {
        const next = await page(groupId, after)
        pages++
        await copy.apply(groupId, next)
        upserts += kinds.reduce((sum, kind) => sum + next.upserts[kind].length, 0)
        tombstones += next.tombstones.length
        after = next.through
        if (!next.more) return { mode: "incremental", cursor: after, pages, upserts, tombstones }
      }
    } catch (error) {
      if (error instanceof CursorTooOldSignal) return await full(groupId)
      throw error
    }
  }

  return (groupId) =>
    lock(async () => {
      const held = await copy.cursor(groupId)
      return held === undefined ? await full(groupId) : await incremental(groupId, held)
    })
}

/** Internal: the server answered {@link CursorTooOld}. Never leaves this module. */
class CursorTooOldSignal extends Error {}
