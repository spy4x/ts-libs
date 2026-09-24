/**
 * Per-group monotonic cursors, and the gap rule that keeps a hint-only socket honest.
 *
 * ADR 002: a pushed change carries the per-group `next_change_sequence` it was committed at. A
 * client applies it only when that sequence is contiguous with the cursor it already holds, and on
 * any gap it discards the hint and pulls from its cursor over REST. Correctness therefore lives in
 * one path — the cursor pull — and a dropped frame, a duplicate or a reorder degrades to a
 * redundant pull instead of silently divergent local state.
 *
 * This module is the whole of that rule, with no transport, no storage and no framework in the
 * decision. {@link CursorTracker} is the arithmetic; {@link PersistentCursorStore} is the same
 * arithmetic with the cursor and the sync timestamp written through a {@link KeyValueStore}.
 *
 * @module
 */

import type { Clock } from "./clock.ts"
import type { KeyValueStore } from "./storage.ts"

/**
 * The empty cursor, and the "from the beginning" floor.
 *
 * Change sequences are 1-based (`next_change_sequence` starts at 1), so `0` can never be a real
 * sequence and is safe as the sentinel. It is *not* used to mean "no durable cursor": that case is
 * carried explicitly by {@link SyncRequest.fromStart}.
 */
export const SEQUENCE_START = 0

/** What the cursor tracker decided about one pushed sequence. */
export enum ApplyStatus {
  /** Contiguous with the cursor: safe to apply, cursor advanced. */
  Applied = 1,
  /** Already applied, or older than the cursor: ignored, cursor unchanged. */
  Duplicate = 2,
  /** Not contiguous: the payload must be discarded and a pull requested from `since`. */
  Gap = 3,
}

/** One group's applied sequence. */
export interface CursorSnapshot {
  groupId: string
  /** Highest contiguous sequence applied for this group; {@link SEQUENCE_START} when none has. */
  sequence: number
}

/** A pushed change, reduced to the only fields correctness depends on. */
export interface SequenceChange {
  groupId: string
  sequence: number
}

/** A non-contiguous sequence, with the cursor a pull must resume from. */
export interface GapReport {
  groupId: string
  /** Cursor the client holds: the `since` a pull is requested with. */
  since: number
  /** Sequence that arrived out of order, for logging and metrics. */
  received: number
}

/** Outcome of applying one pushed sequence. */
export type ApplyOutcome =
  | { status: ApplyStatus.Applied; groupId: string; cursor: number }
  | { status: ApplyStatus.Duplicate; groupId: string; cursor: number }
  | {
    status: ApplyStatus.Gap
    groupId: string
    cursor: number
    gap: GapReport
  }

/** What a client tells the server on connect, and what a pull resumes from. */
export interface SyncRequest {
  /** Every durable cursor the client holds; empty on a cold start. */
  cursors: CursorSnapshot[]
  /**
   * True when the client holds no durable cursor at all.
   *
   * Redundant by construction — it is `cursors.length === 0` — and carried explicitly so a server
   * never has to infer "start from the beginning" from an empty array, and so a cursor of `0`
   * recorded for a known group (which is a *warm* client) stays distinguishable from a cold one.
   */
  fromStart: boolean
}

/**
 * In-memory per-group cursor arithmetic.
 *
 * Every method is pure with respect to the map it owns: an out-of-order, duplicate or old sequence
 * can never move a cursor backwards, which is the property a reconnect storm would otherwise break.
 */
export class CursorTracker {
  readonly #cursors: Map<string, number>

  constructor(initial?: Iterable<readonly [string, number]>) {
    this.#cursors = new Map(initial)
  }

  /** Highest contiguous sequence applied for `groupId`; {@link SEQUENCE_START} when none has. */
  cursorFor(groupId: string): number {
    return this.#cursors.get(groupId) ?? SEQUENCE_START
  }

  /** Whether any sequence has been applied for `groupId`. */
  hasCursor(groupId: string): boolean {
    return this.#cursors.has(groupId)
  }

  /** Groups with a cursor, sorted, so a wire payload is deterministic. */
  groups(): string[] {
    return [...this.#cursors.keys()].sort()
  }

  /** Every cursor, sorted by group id. */
  snapshot(): CursorSnapshot[] {
    return this.groups().map((groupId) => ({
      groupId,
      sequence: this.cursorFor(groupId),
    }))
  }

  /**
   * Apply one pushed sequence.
   *
   * Contiguous advances the cursor. A duplicate, a repeat or anything older is reported as
   * {@link ApplyStatus.Duplicate} and leaves the cursor alone — the cursor never regresses. A jump
   * forward is reported as {@link ApplyStatus.Gap} together with the `since` a pull must use, and
   * again leaves the cursor alone: nothing is applied from a hint that cannot be shown contiguous.
   */
  apply(change: SequenceChange): ApplyOutcome {
    const cursor = this.cursorFor(change.groupId)

    if (change.sequence <= cursor) {
      return { status: ApplyStatus.Duplicate, groupId: change.groupId, cursor }
    }

    if (change.sequence > cursor + 1) {
      return {
        status: ApplyStatus.Gap,
        groupId: change.groupId,
        cursor,
        gap: {
          groupId: change.groupId,
          since: cursor,
          received: change.sequence,
        },
      }
    }

    this.#cursors.set(change.groupId, change.sequence)
    return {
      status: ApplyStatus.Applied,
      groupId: change.groupId,
      cursor: change.sequence,
    }
  }

  /**
   * Move a group's cursor to a sequence a pull reported.
   *
   * Monotonic for a group that already has a cursor: a pull answering a gap may carry a lower
   * sequence if another pull already moved forward, and that must not be a regression. A group with
   * no cursor yet accepts any sequence from {@link SEQUENCE_START} up, so a pull that reports `0` for
   * an empty group is recorded rather than silently dropped — which is what makes "this group is at
   * 0" distinguishable from "this client has never seen the group" in the next handshake.
   *
   * Returns whether the cursor moved.
   */
  advanceTo(groupId: string, sequence: number): boolean {
    if (sequence < SEQUENCE_START) return false
    const known = this.#cursors.has(groupId)
    if (known && sequence <= this.cursorFor(groupId)) return false
    this.#cursors.set(groupId, sequence)
    return true
  }

  /**
   * Set a cursor from durable state.
   *
   * Unconditional, unlike {@link CursorTracker.advanceTo}: this is the load path, where the stored
   * value *is* the cursor and a stored `0` must be representable. Never call it with a hint or a
   * pull result, or the monotonic guarantee is gone.
   */
  restore(groupId: string, sequence: number): void {
    this.#cursors.set(groupId, sequence)
  }

  /** Forget every cursor. The next lookup reports {@link SEQUENCE_START} again. */
  clear(): void {
    this.#cursors.clear()
  }
}

/** Options for {@link PersistentCursorStore}. */
export interface PersistentCursorStoreOptions {
  /** Durable store. A Web Storage `Storage` satisfies it structurally. */
  storage: KeyValueStore
  /** Key prefix, so two clients in one origin do not read each other's cursors. */
  namespace?: string
  /** Time source for {@link PersistentCursorStore.syncedAt}. */
  clock?: Clock
}

/**
 * A {@link CursorTracker} whose state survives a reload.
 *
 * Financy kept its sync checkpoint in an in-memory signal and sent a hardcoded `0` as the sync
 * floor, so every connect re-downloaded everything: a checkpoint that does not survive a reload is
 * not a checkpoint. Here the cursors and the last successful sync timestamp are written through an
 * injected {@link KeyValueStore}, the store is read lazily on first use rather than at import time,
 * and a corrupt or unreadable entry is treated as absent (fail closed to a full pull).
 */
export class PersistentCursorStore {
  readonly #tracker = new CursorTracker()
  readonly #storage: KeyValueStore
  readonly #prefix: string
  readonly #clock: Clock | undefined
  #loaded = false
  #syncedAt: number | null = null

  constructor(options: PersistentCursorStoreOptions) {
    this.#storage = options.storage
    this.#prefix = options.namespace ?? "realtime"
    this.#clock = options.clock
  }

  /** The arithmetic, for callers that only need the decision and not the write. */
  get tracker(): CursorTracker {
    return this.#tracker
  }

  /** Highest contiguous sequence applied for `groupId`; reads through to storage on first use. */
  cursorFor(groupId: string): number {
    this.#ensureLoaded()
    return this.#tracker.cursorFor(groupId)
  }

  /** Every durable cursor, sorted by group id. */
  cursors(): CursorSnapshot[] {
    this.#ensureLoaded()
    return this.#tracker.snapshot()
  }

  /** What to send on connect: the real cursors, or an explicit cold start. */
  syncRequest(): SyncRequest {
    const cursors = this.cursors()
    return { cursors, fromStart: cursors.length === 0 }
  }

  /** Apply a pushed sequence and persist the cursor when it advanced. */
  apply(change: SequenceChange): ApplyOutcome {
    this.#ensureLoaded()
    const outcome = this.#tracker.apply(change)
    if (outcome.status === ApplyStatus.Applied) {
      this.#writeCursor(change.groupId, outcome.cursor)
    }
    return outcome
  }

  /**
   * Apply a sequence a pull reported, persisting it only when the cursor moved.
   *
   * A pull that reports `0` for a group this client has not seen is recorded, so the next handshake
   * says "group-1 at 0" instead of reporting a cold start for it.
   */
  advanceTo(groupId: string, sequence: number): boolean {
    this.#ensureLoaded()
    if (!this.#tracker.advanceTo(groupId, sequence)) return false
    this.#writeCursor(groupId, sequence)
    return true
  }

  /** Milliseconds of the last successful sync, or `null` when none has ever been recorded. */
  syncedAt(): number | null {
    this.#ensureLoaded()
    return this.#syncedAt
  }

  /** Record a successful sync. Persisted, so it is still there after a reload. */
  markSynced(at?: number): number {
    this.#ensureLoaded()
    const value = at ?? this.#clock?.now() ?? 0
    this.#syncedAt = value
    this.#storage.setItem(this.#key("syncedAt"), String(value))
    return value
  }

  /**
   * Drop every cursor and the timestamp. The next connect is a cold start again.
   *
   * Reads durable state first: without that, a fresh instance that had never called another method
   * would iterate an empty in-memory map and leave every stored cursor behind as an orphan key,
   * which is precisely the stale-checkpoint state this store exists to prevent.
   */
  clear(): void {
    this.#ensureLoaded()
    for (const groupId of this.#tracker.groups()) {
      this.#storage.removeItem(this.#cursorKey(groupId))
    }
    this.#storage.removeItem(this.#key("groups"))
    this.#storage.removeItem(this.#key("syncedAt"))
    this.#tracker.clear()
    this.#syncedAt = null
    this.#loaded = true
  }

  /** Storage keys this store owns, sorted. Reads durable state first. */
  keys(): string[] {
    this.#ensureLoaded()
    return this.#tracker.groups().map((groupId) => this.#cursorKey(groupId))
  }

  #key(name: string): string {
    return `${this.#prefix}:${name}`
  }

  #cursorKey(groupId: string): string {
    return `${this.#prefix}:cursor:${groupId}`
  }

  /**
   * Read durable state once, on first use.
   *
   * The group index is written alongside the cursors because a key/value store cannot enumerate its
   * keys. An entry that does not parse is skipped rather than guessed at: resuming from a wrong
   * cursor is the failure this whole module exists to prevent.
   */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true

    const storedSyncedAt = this.#storage.getItem(this.#key("syncedAt"))
    if (storedSyncedAt !== null) {
      const parsed = Number(storedSyncedAt)
      if (Number.isFinite(parsed)) this.#syncedAt = parsed
    }

    const index = this.#storage.getItem(this.#key("groups"))
    if (index === null) return
    let groupIds: unknown
    try {
      groupIds = JSON.parse(index)
    } catch {
      return
    }
    if (!Array.isArray(groupIds)) return

    for (const groupId of groupIds) {
      if (typeof groupId !== "string") continue
      const raw = this.#storage.getItem(this.#cursorKey(groupId))
      if (raw === null) continue
      const sequence = Number(raw)
      if (!Number.isFinite(sequence) || sequence < SEQUENCE_START) continue
      this.#tracker.restore(groupId, sequence)
    }
  }

  #writeCursor(groupId: string, sequence: number): void {
    this.#storage.setItem(this.#cursorKey(groupId), String(sequence))
    this.#storage.setItem(
      this.#key("groups"),
      JSON.stringify(this.#tracker.groups()),
    )
  }
}
