/**
 * The gap matrix: contiguous, duplicate, old, out-of-order and skipped sequences.
 *
 * This is the suite that justifies the package. ADR 002 makes the cursor pull the only path that
 * has to be correct, and makes a push safe exactly as long as a non-contiguous push is detected;
 * every case below pins one way a transport can lie about ordering.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { ApplyStatus, CursorTracker, PersistentCursorStore, SEQUENCE_START } from "./cursor.ts"
import { MemoryKeyValueStore } from "./testing.ts"

describe("CursorTracker", () => {
  it("applies a sequence contiguous with the cursor and advances it", () => {
    const tracker = new CursorTracker([["group-1", 41]])

    const outcome = tracker.apply({ groupId: "group-1", sequence: 42 })

    expect(outcome.status).toBe(ApplyStatus.Applied)
    expect(tracker.cursorFor("group-1")).toBe(42)
  })

  it("reports a gap when a pushed sequence skips ahead and keeps the cursor", () => {
    const tracker = new CursorTracker([["group-1", 41]])

    const outcome = tracker.apply({ groupId: "group-1", sequence: 44 })

    expect(outcome.status).toBe(ApplyStatus.Gap)
    expect(tracker.cursorFor("group-1")).toBe(41)
    if (outcome.status !== ApplyStatus.Gap) throw new Error("expected a gap")
    expect(outcome.gap).toEqual({
      groupId: "group-1",
      since: 41,
      received: 44,
    })
  })

  it("names the cursor it holds as the pull cursor when a frame was missed", () => {
    const tracker = new CursorTracker([["group-1", 7]])
    tracker.apply({ groupId: "group-1", sequence: 8 })

    const outcome = tracker.apply({ groupId: "group-1", sequence: 10 })

    if (outcome.status !== ApplyStatus.Gap) throw new Error("expected a gap")
    expect(outcome.gap.since).toBe(8)
  })

  it("ignores a duplicate sequence without regressing the cursor", () => {
    const tracker = new CursorTracker([["group-1", 12]])

    const outcome = tracker.apply({ groupId: "group-1", sequence: 12 })

    expect(outcome.status).toBe(ApplyStatus.Duplicate)
    expect(tracker.cursorFor("group-1")).toBe(12)
  })

  it("ignores a stale sequence that arrives after a newer one", () => {
    const tracker = new CursorTracker()
    tracker.apply({ groupId: "group-1", sequence: 1 })
    tracker.apply({ groupId: "group-1", sequence: 2 })
    tracker.apply({ groupId: "group-1", sequence: 3 })

    const outcome = tracker.apply({ groupId: "group-1", sequence: 2 })

    expect(outcome.status).toBe(ApplyStatus.Duplicate)
    expect(tracker.cursorFor("group-1")).toBe(3)
  })

  it("never moves a cursor backwards across an out-of-order burst", () => {
    const tracker = new CursorTracker()
    const cursors: number[] = []
    for (const sequence of [1, 2, 5, 3, 4, 2, 6]) {
      tracker.apply({ groupId: "group-1", sequence })
      cursors.push(tracker.cursorFor("group-1"))
    }

    // 5 is a gap, so it is discarded and the cursor stays at 2 until 3 and 4 arrive contiguously;
    // the repeat of 2 and the later 6 change nothing.
    expect(cursors).toEqual([1, 2, 2, 3, 4, 4, 4])
  })

  it("applies sequence one for an unknown group, because it is contiguous with the start", () => {
    const tracker = new CursorTracker()

    const outcome = tracker.apply({ groupId: "group-1", sequence: 1 })

    expect(outcome.status).toBe(ApplyStatus.Applied)
    expect(tracker.cursorFor("group-1")).toBe(1)
  })

  it("reports a gap instead of applying the first hint when it skips the start", () => {
    const tracker = new CursorTracker()

    const outcome = tracker.apply({ groupId: "group-1", sequence: 41 })

    expect(outcome.status).toBe(ApplyStatus.Gap)
    expect(tracker.cursorFor("group-1")).toBe(SEQUENCE_START)
  })

  it("keeps cursors independent per group", () => {
    const tracker = new CursorTracker()
    tracker.apply({ groupId: "group-1", sequence: 1 })
    tracker.apply({ groupId: "group-2", sequence: 1 })

    expect(tracker.apply({ groupId: "group-1", sequence: 2 }).status).toBe(
      ApplyStatus.Applied,
    )
    expect(tracker.cursorFor("group-2")).toBe(1)
  })

  it("advances to a sequence a pull reported", () => {
    const tracker = new CursorTracker([["group-1", 3]])

    expect(tracker.advanceTo("group-1", 9)).toBe(true)
    expect(tracker.cursorFor("group-1")).toBe(9)
  })

  it("refuses a pull that reports a lower sequence than the cursor", () => {
    const tracker = new CursorTracker([["group-1", 9]])

    expect(tracker.advanceTo("group-1", 4)).toBe(false)
    expect(tracker.cursorFor("group-1")).toBe(9)
  })

  it("records a zero cursor for a group a pull reports as empty", () => {
    const tracker = new CursorTracker()

    expect(tracker.advanceTo("group-1", 0)).toBe(true)
    expect(tracker.hasCursor("group-1")).toBe(true)
    expect(tracker.cursorFor("group-1")).toBe(SEQUENCE_START)
  })

  it("still refuses to regress a group that has a cursor, and refuses a negative sequence", () => {
    const tracker = new CursorTracker()

    expect(tracker.advanceTo("group-1", 5)).toBe(true)
    expect(tracker.advanceTo("group-1", 0)).toBe(false)
    expect(tracker.advanceTo("group-1", -1)).toBe(false)
    expect(tracker.cursorFor("group-1")).toBe(5)
  })

  it("snapshots cursors sorted by group id", () => {
    const tracker = new CursorTracker()
    tracker.apply({ groupId: "group-2", sequence: 1 })
    tracker.apply({ groupId: "group-1", sequence: 1 })

    expect(tracker.snapshot()).toEqual([
      { groupId: "group-1", sequence: 1 },
      { groupId: "group-2", sequence: 1 },
    ])
  })
})

describe("PersistentCursorStore", () => {
  it("sends the stored cursor on the handshake rather than zero", () => {
    const storage = new MemoryKeyValueStore()
    const store = new PersistentCursorStore({ storage })
    // A pull is what records a cursor; a hint may only continue from one.
    store.advanceTo("group-1", 42)

    expect(store.syncRequest()).toEqual({
      cursors: [{ groupId: "group-1", sequence: 42 }],
      fromStart: false,
    })
  })

  it("advances a stored cursor from a contiguous hint", () => {
    const storage = new MemoryKeyValueStore()
    const store = new PersistentCursorStore({ storage })
    store.advanceTo("group-1", 41)

    const outcome = store.apply({ groupId: "group-1", sequence: 42 })

    expect(outcome.status).toBe(ApplyStatus.Applied)
    expect(store.syncRequest()).toEqual({
      cursors: [{ groupId: "group-1", sequence: 42 }],
      fromStart: false,
    })
  })

  it("sends an explicit cold start when no cursor has ever been stored", () => {
    const store = new PersistentCursorStore({
      storage: new MemoryKeyValueStore(),
    })

    expect(store.syncRequest()).toEqual({ cursors: [], fromStart: true })
  })

  it("distinguishes a durably stored cursor of zero from a cold start", () => {
    const storage = new MemoryKeyValueStore()
    const store = new PersistentCursorStore({ storage })
    expect(store.advanceTo("group-1", 0)).toBe(true)

    const afterReload = new PersistentCursorStore({ storage })

    expect(afterReload.syncRequest()).toEqual({
      cursors: [{ groupId: "group-1", sequence: 0 }],
      fromStart: false,
    })
    expect(store.syncRequest().fromStart).toBe(false)
  })

  it("clears durable state from an instance that never read it", () => {
    const storage = new MemoryKeyValueStore()
    const writer = new PersistentCursorStore({ storage, namespace: "client-a" })
    writer.advanceTo("group-1", 9)
    writer.markSynced(1_000)

    const fresh = new PersistentCursorStore({ storage, namespace: "client-a" })
    expect(fresh.keys()).toEqual(["client-a:cursor:group-1"])

    fresh.clear()

    expect(storage.keys()).toEqual([])
    expect(new PersistentCursorStore({ storage, namespace: "client-a" }).cursors()).toEqual([])
  })

  it("reports the cursor it holds after a reload", () => {
    const storage = new MemoryKeyValueStore()
    const before = new PersistentCursorStore({ storage })
    before.advanceTo("group-1", 17)
    before.advanceTo("group-2", 3)

    const after = new PersistentCursorStore({ storage })

    expect(after.cursors()).toEqual([
      { groupId: "group-1", sequence: 17 },
      { groupId: "group-2", sequence: 3 },
    ])
    expect(after.syncRequest().fromStart).toBe(false)
  })

  it("keeps the sync timestamp across a reload", () => {
    const storage = new MemoryKeyValueStore()
    const before = new PersistentCursorStore({ storage })
    before.markSynced(1_700_000_000_000)

    const after = new PersistentCursorStore({ storage })

    expect(after.syncedAt()).toBe(1_700_000_000_000)
  })

  it("takes the sync timestamp from the injected clock", () => {
    const storage = new MemoryKeyValueStore()
    let now = 1_000
    const store = new PersistentCursorStore({
      storage,
      clock: {
        now: () => now,
        setInterval: () => ({ id: 0 }),
        clearInterval: () => {},
        setTimeout: () => ({ id: 0 }),
        clearTimeout: () => {},
      },
    })

    now = 2_500

    expect(store.markSynced()).toBe(2_500)
    expect(storage.getItem("realtime:syncedAt")).toBe("2500")
  })

  it("writes nothing when a hint is a gap", () => {
    const storage = new MemoryKeyValueStore()
    const store = new PersistentCursorStore({ storage })
    store.advanceTo("group-1", 1)

    const outcome = store.apply({ groupId: "group-1", sequence: 5 })

    expect(outcome.status).toBe(ApplyStatus.Gap)
    expect(store.cursorFor("group-1")).toBe(1)
    expect(storage.getItem("realtime:cursor:group-1")).toBe("1")
  })

  it("treats a corrupt stored cursor as absent instead of resuming from a guess", () => {
    const storage = new MemoryKeyValueStore()
    storage.setItem("realtime:groups", JSON.stringify(["group-1"]))
    storage.setItem("realtime:cursor:group-1", "not-a-number")

    const store = new PersistentCursorStore({ storage })

    expect(store.cursors()).toEqual([])
    expect(store.syncRequest()).toEqual({ cursors: [], fromStart: true })
  })

  it("treats a negative stored cursor as absent instead of restoring it", () => {
    // #74: the load path (`#ensureLoaded`) already guards `sequence < SEQUENCE_START`, but nothing
    // pinned it — only the non-numeric case above was covered, and a negative number passes
    // `Number.isFinite` on its own. A stored `-1` reaching `CursorTracker.restore` unrejected would
    // resume gap detection from a cursor no real sequence can ever be contiguous with.
    const storage = new MemoryKeyValueStore()
    storage.setItem("realtime:groups", JSON.stringify(["group-1"]))
    storage.setItem("realtime:cursor:group-1", "-1")

    const store = new PersistentCursorStore({ storage })

    expect(store.cursors()).toEqual([])
    expect(store.syncRequest()).toEqual({ cursors: [], fromStart: true })
  })

  it("treats an unreadable group index as a cold start", () => {
    const storage = new MemoryKeyValueStore()
    storage.setItem("realtime:groups", "{not json")

    const store = new PersistentCursorStore({ storage })

    expect(store.cursors()).toEqual([])
  })

  it("drops every cursor and the timestamp on clear", () => {
    const storage = new MemoryKeyValueStore()
    const store = new PersistentCursorStore({ storage })
    store.advanceTo("group-1", 9)
    store.markSynced(1_000)

    store.clear()

    expect(store.cursors()).toEqual([])
    expect(store.syncedAt()).toBeNull()
    expect(storage.keys()).toEqual([])
  })

  it("separates two clients by namespace in one origin", () => {
    const storage = new MemoryKeyValueStore()
    const first = new PersistentCursorStore({ storage, namespace: "client-a" })
    const second = new PersistentCursorStore({
      storage,
      namespace: "client-b",
    })
    first.advanceTo("group-1", 5)

    expect(second.cursors()).toEqual([])
  })
})
