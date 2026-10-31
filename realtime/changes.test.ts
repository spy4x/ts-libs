import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import {
  changesAfterSchema,
  type ChangesAnswer,
  changesAnswerSchema,
  type ChangesKinds,
  createChangesCopy,
  createChangesPull,
  planChangesPage,
} from "./changes.ts"

interface Note {
  id: string
  title: string
}
interface Tag {
  id: string
  name: string
}
interface Rows {
  notes: Note
  tags: Tag
}

const kinds: ChangesKinds<Rows> = {
  notes: { row: type({ id: "string", title: "string" }), id: (note) => note.id },
  tags: { row: type({ id: "string", name: "string" }), id: (tag) => tag.id },
}

/**
 * One group on a server: every row carries the sequence it was last written at, a deletion
 * leaves a tombstone at its sequence, and `forget` cuts the tombstones as a retention window does.
 */
function fakeServer(limit: number) {
  type Change =
    | { sequence: number; kind: keyof Rows; row: Note | Tag; gone?: never }
    | { sequence: number; kind: keyof Rows; gone: string; row?: never }
  let current = 0
  let oldest = 0
  let changes: Change[] = []
  const requests: number[] = []
  const latest = () => {
    const live = new Map<string, Change>()
    for (const change of changes) {
      live.set(`${change.kind}:${change.row?.id ?? change.gone}`, change)
    }
    return [...live.values()].sort((a, b) => a.sequence - b.sequence)
  }
  return {
    requests,
    /** Writes the rows (one sequence for all of them). */
    write(kind: keyof Rows, ...rows: (Note | Tag)[]) {
      current++
      for (const row of rows) changes.push({ sequence: current, kind, row })
    },
    remove(kind: keyof Rows, id: string) {
      current++
      changes.push({ sequence: current, kind, gone: id })
    },
    /** Forgets every deleted row and its tombstone: a cursor before now is too old. */
    forget() {
      const gone = new Set(
        latest().filter((change) => change.gone !== undefined).map((c) => `${c.kind}:${c.gone}`),
      )
      changes = changes.filter((change) =>
        change.gone === undefined && !gone.has(`${change.kind}:${change.row.id}`)
      )
      oldest = current
    },
    fetch(_groupId: string, after: number): Promise<ChangesAnswer> {
      requests.push(after)
      const after_ = latest().filter((change) => change.sequence > after)
      const plan = planChangesPage({
        after,
        current,
        // An empty copy needs no tombstones, so `0` is always answerable.
        oldest: after === 0 ? 0 : oldest,
        boundary: after_.length > limit ? after_[limit].sequence : null,
      })
      if (plan.status === "too-old") return Promise.resolve({ status: "too-old", current })
      const window = after_.filter((change) => change.sequence <= plan.through)
      const upserts: Record<string, unknown[]> = {}
      for (const change of window) {
        if (change.row) (upserts[change.kind] ??= []).push(change.row)
      }
      return Promise.resolve({
        status: "changes",
        after,
        through: plan.through,
        current,
        more: plan.more,
        upserts,
        tombstones: window.filter((change) => change.gone !== undefined && after !== 0)
          .map((change) => ({ kind: change.kind, id: change.gone! })),
      })
    },
  }
}

function setup(limit = 100) {
  const server = fakeServer(limit)
  const copy = createChangesCopy<Rows>({
    name: "changes:u1",
    kinds,
    indexedDB: new IDBFactory() as unknown as IDBFactory,
  })
  const pull = createChangesPull<Rows>({ kinds, copy, fetch: (g, a) => server.fetch(g, a) })
  return { server, copy, pull }
}

const note = (id: string, title = `note ${id}`): Note => ({ id, title })
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort()

describe("planChangesPage", () => {
  it("covers everything up to the current sequence when the changes fit one page", () => {
    expect(planChangesPage({ after: 3, current: 9, oldest: 0, boundary: null }))
      .toEqual({ status: "changes", through: 9, more: false })
  })

  it("stops before the sequence that does not fit, so a page never splits a sequence", () => {
    expect(planChangesPage({ after: 3, current: 9, oldest: 0, boundary: 7 }))
      .toEqual({ status: "changes", through: 6, more: true })
  })

  it("takes a whole sequence that alone is larger than a page", () => {
    expect(planChangesPage({ after: 3, current: 9, oldest: 0, boundary: 4 }))
      .toEqual({ status: "changes", through: 4, more: true })
  })

  it("answers too old for a cursor below the oldest it can answer", () => {
    expect(planChangesPage({ after: 2, current: 9, oldest: 3, boundary: null }))
      .toEqual({ status: "too-old" })
  })

  it("answers too old for a cursor ahead of the server, as after a restore", () => {
    expect(planChangesPage({ after: 10, current: 9, oldest: 0, boundary: null }))
      .toEqual({ status: "too-old" })
  })
})

describe("changesAfterSchema", () => {
  it("reads a non-negative integer in plain digits", () => {
    expect(changesAfterSchema("0")).toBe(0)
    expect(changesAfterSchema("4096")).toBe(4096)
  })

  it("rejects a sign, a fraction, an exponent, a leading zero and an unsafe integer", () => {
    for (const raw of ["-1", "+1", "1.5", "1e3", "01", "", " 1", "abc", "9007199254740993"]) {
      expect(changesAfterSchema(raw)).toBeInstanceOf(type.errors)
    }
  })
})

describe("changesAnswerSchema", () => {
  it("rejects a page with a negative cursor", () => {
    const page = {
      status: "changes",
      after: 0,
      through: -1,
      current: 0,
      more: false,
      upserts: {},
      tombstones: [],
    }
    expect(changesAnswerSchema(page)).toBeInstanceOf(type.errors)
  })
})

describe("createChangesPull", () => {
  it("reads a group in full from 0 when the device has no copy", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", note("a"), note("b"))
    server.write("tags", { id: "t", name: "home" })

    const result = await pull("g1")

    expect(result).toMatchObject({ mode: "full", cursor: 2, pages: 1, upserts: 3 })
    expect(server.requests).toEqual([0])
    expect(ids(await copy.read("notes", "g1"))).toEqual(["a", "b"])
    expect(ids(await copy.read("tags", "g1"))).toEqual(["t"])
    expect(await copy.cursor("g1")).toBe(2)
  })

  it("downloads only the one change made after the device's cursor", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", ...Array.from({ length: 50 }, (_, i) => note(`n${i}`)))
    await pull("g1")
    server.write("notes", note("n7", "edited"))

    const result = await pull("g1")

    expect(result).toEqual({ mode: "incremental", cursor: 2, pages: 1, upserts: 1, tombstones: 0 })
    expect(server.requests).toEqual([0, 1])
    const notes = await copy.read("notes", "g1")
    expect(notes).toHaveLength(50)
    expect(notes.find((n) => n.id === "n7")?.title).toBe("edited")
  })

  it("asks only for what came after the cursor when the copy is several changes behind", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", note("a"))
    await pull("g1")
    server.write("notes", note("b"))
    server.write("notes", note("c"))
    server.write("tags", { id: "t", name: "work" })

    await pull("g1")

    expect(server.requests).toEqual([0, 1])
    expect(ids(await copy.read("notes", "g1"))).toEqual(["a", "b", "c"])
    expect(await copy.cursor("g1")).toBe(4)
  })

  it("removes a row deleted on another device, without a full read", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", note("a"), note("b"))
    await pull("g1")
    server.remove("notes", "a")

    const result = await pull("g1")

    expect(result).toMatchObject({ mode: "incremental", tombstones: 1 })
    expect(ids(await copy.read("notes", "g1"))).toEqual(["b"])
  })

  it("follows every page until the server has no more, storing each page's cursor", async () => {
    const { server, copy, pull } = setup(2)
    server.write("notes", note("a"))
    await pull("g1")
    for (const id of ["b", "c", "d", "e", "f"]) server.write("notes", note(id))

    const result = await pull("g1")

    expect(server.requests).toEqual([0, 1, 3, 5])
    expect(result).toMatchObject({ mode: "incremental", pages: 3, cursor: 6, upserts: 5 })
    expect(ids(await copy.read("notes", "g1"))).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  it("reads every page of a full read, however many rows the group holds", async () => {
    const { server, copy, pull } = setup(100)
    for (let i = 0; i < 25; i++) {
      server.write("notes", ...Array.from({ length: 100 }, (_, j) => note(`n${i}-${j}`)))
    }

    const result = await pull("g1")

    expect(result).toMatchObject({ mode: "full", pages: 25, cursor: 25, upserts: 2500 })
    expect(await copy.read("notes", "g1")).toHaveLength(2500)
  })

  it("falls back to one full read when the cursor is too old, and drops what the copy lost", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", note("a"), note("b"))
    await pull("g1")
    server.remove("notes", "a")
    server.write("notes", note("c"))
    server.forget()

    const result = await pull("g1")

    expect(result).toMatchObject({ mode: "full", cursor: 3 })
    expect(server.requests).toEqual([0, 1, 0])
    expect(ids(await copy.read("notes", "g1"))).toEqual(["b", "c"])
    expect(await copy.cursor("g1")).toBe(3)
  })

  it("rejects an answer that does not match the wire and leaves the copy as it was", async () => {
    const copy = createChangesCopy<Rows>({
      name: "changes:u1",
      kinds,
      indexedDB: new IDBFactory() as unknown as IDBFactory,
    })
    await copy.replace("g1", { notes: [note("a")], tags: [] }, 1)
    const answers: unknown[] = [
      {
        status: "changes",
        after: 1,
        through: 2,
        current: 2,
        more: false,
        upserts: {},
        tombstones: [{ kind: "notes", id: 7 }],
      },
      {
        status: "changes",
        after: 1,
        through: 2,
        current: 2,
        more: false,
        upserts: { notes: [{ id: "b" }] },
        tombstones: [],
      },
    ]
    for (const answer of answers) {
      const pull = createChangesPull<Rows>({ kinds, copy, fetch: () => Promise.resolve(answer) })
      await expect(pull("g1")).rejects.toThrow()
    }
    expect(ids(await copy.read("notes", "g1"))).toEqual(["a"])
    expect(await copy.cursor("g1")).toBe(1)
  })

  it("rejects a page that claims more but does not move forward, instead of looping", async () => {
    const copy = createChangesCopy<Rows>({
      name: "changes:u1",
      kinds,
      indexedDB: new IDBFactory() as unknown as IDBFactory,
    })
    await copy.replace("g1", { notes: [], tags: [] }, 4)
    let calls = 0
    const pull = createChangesPull<Rows>({
      kinds,
      copy,
      fetch: (_g, after) => {
        calls++
        if (calls > 3) return Promise.reject(new Error(`looped`))
        return Promise.resolve({
          status: "changes",
          after,
          through: after,
          current: 9,
          more: true,
          upserts: {},
          tombstones: [],
        })
      },
    })

    await expect(pull("g1")).rejects.toThrow(/do not move forward/)
    expect(calls).toBe(1)
  })

  it("ignores rows and tombstones of a kind the app does not know", async () => {
    const copy = createChangesCopy<Rows>({
      name: "changes:u1",
      kinds,
      indexedDB: new IDBFactory() as unknown as IDBFactory,
    })
    await copy.replace("g1", { notes: [note("a")], tags: [] }, 1)
    const pull = createChangesPull<Rows>({
      kinds,
      copy,
      fetch: () =>
        Promise.resolve({
          status: "changes",
          after: 1,
          through: 2,
          current: 2,
          more: false,
          upserts: { budgets: [{ anything: true }], notes: [note("b")] },
          tombstones: [{ kind: "budgets", id: "a" }],
        }),
    })

    expect(await pull("g1")).toMatchObject({ upserts: 1, tombstones: 0 })
    expect(ids(await copy.read("notes", "g1"))).toEqual(["a", "b"])
  })

  it("runs two pulls of one group one after the other, so the later never goes first", async () => {
    const { server, copy } = setup()
    server.write("notes", note("a"))
    const seen: number[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => release = resolve)
    const pull = createChangesPull<Rows>({
      kinds,
      copy,
      fetch: async (g, after) => {
        seen.push(after)
        if (seen.length === 1) await held
        return server.fetch(g, after)
      },
    })

    const first = pull("g1")
    const second = pull("g1")
    // Let IndexedDB and the second pull run as far as they can while the first one waits.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([0])
    release()
    await Promise.all([first, second])

    expect(seen).toEqual([0, 1])
  })

  it("drops one group's rows and cursor, so its next pull reads in full", async () => {
    const { server, copy, pull } = setup()
    server.write("notes", note("a"))
    await pull("g1")
    await copy.drop("g1")

    expect(await copy.cursor("g1")).toBeUndefined()
    expect(await copy.read("notes", "g1")).toEqual([])
    expect((await pull("g1")).mode).toBe("full")
  })
})
