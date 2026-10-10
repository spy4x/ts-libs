import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import type { CallPort } from "./calls.ts"
import { ConnectionLostError } from "./client-transport.ts"
import {
  classifyByCode,
  type Collections,
  type CollectionsOptions,
  createCollections,
  defineCollection,
  type ReferenceRemoved,
} from "./collections.ts"
import { RealtimeRequestError } from "./errors.ts"
import { createIndexedDbOutboxStore } from "./outbox-indexeddb.ts"
import {
  createMemoryOutboxStore,
  createPromiseLock,
  type OutboxEntry,
  type OutboxLock,
} from "./outbox.ts"

// Two fake aggregates. A "tag" is the parent; a "note" is the child and names tags by id.

interface Tag {
  id: string
  version: number
  name: string
}
interface TagPayload {
  name: string
}
interface Note {
  id: string
  version: number
  title: string
  tagIds: string[]
  group: string
}
interface NotePayload {
  title: string
  tagIds: string[]
  group: string
}

const VERSION_CONFLICT = "VERSION_CONFLICT"
const REFUSED = "REFUSED"

function refusal(code: string): RealtimeRequestError {
  return new RealtimeRequestError("conflict", `the server said ${code}`, { code })
}

/** A calls port the test steers: it records every call and answers like a small server. */
function fakeServer() {
  const calls: { name: string; payload: Record<string, unknown>; key?: string }[] = []
  const state = {
    /** The page cannot send: `canSend` is false and nothing leaves. */
    offline: false,
    /** A send is made but the connection drops before an answer. */
    lose: false,
    /** Refuses a command; return the error to throw. */
    refuse: undefined as
      | undefined
      | ((name: string, payload: Record<string, unknown>) => Error | undefined),
    /** What a query for an entity answers with. */
    tags: new Map<string, Tag>(),
  }
  const port: CallPort = {
    command(name, payload, options) {
      const body = payload as Record<string, unknown>
      calls.push({ name, payload: body, key: options?.idempotencyKey })
      if (state.lose) return Promise.reject(new ConnectionLostError(`lost`))
      const error = state.refuse?.(name, body)
      if (error) return Promise.reject(error)
      if (name.endsWith(`.delete`)) return Promise.resolve({})
      const version = (body.version as number | undefined ?? 0) + 1
      return Promise.resolve(
        name.startsWith(`tag.`) ? { tag: { ...body, version } } : { note: { ...body, version } },
      )
    },
    query(_name, payload) {
      const tag = state.tags.get((payload as { id: string }).id)
      return tag ? Promise.resolve({ tag }) : Promise.reject(refusal(`NOT_FOUND`))
    },
  }
  return { calls, state, port, names: () => calls.map((call) => call.name) }
}

const classify = classifyByCode({
  version: VERSION_CONFLICT,
  notFound: `NOT_FOUND`,
  alreadyExists: `ID_TAKEN`,
})

function tagDefinition(
  options: {
    store?: ReturnType<typeof createMemoryOutboxStore<TagPayload, Tag>>
    database?: string
  } = {},
) {
  return defineCollection<TagPayload, Tag>({
    name: `tags`,
    database: options.database ?? `tags`,
    store: options.store,
    toCall: (command) => ({
      name: `tag.${command.kind}`,
      payload: { id: command.entityId, ...command.payload, version: command.baseVersion },
    }),
    toQuery: (entityId) => ({ name: `tag.get`, payload: { id: entityId } }),
    entityFrom: (answer) => (answer as { tag?: Tag }).tag,
    classify,
    messages: { version: `Someone else changed this tag.` },
    itemId: (tag) => tag.id,
    queuedItem: (entry) => ({ id: entry.entityId, version: 0, name: entry.payload.name }),
    applyEdit: (tag, entry) => ({ ...tag, name: entry.payload.name }),
  })
}

function noteDefinition(
  options: { store?: ReturnType<typeof createMemoryOutboxStore<NotePayload, Note>> } = {},
) {
  return defineCollection<NotePayload, Note>({
    name: `notes`,
    database: `notes`,
    store: options.store,
    toCall: (command) => ({
      name: `note.${command.kind}`,
      payload: { id: command.entityId, ...command.payload, version: command.baseVersion },
    }),
    toQuery: (entityId) => ({ name: `note.get`, payload: { id: entityId } }),
    entityFrom: (answer) => (answer as { note?: Note }).note,
    classify,
    itemId: (note) => note.id,
    queuedItem: (entry) => ({ id: entry.entityId, version: 0, ...entry.payload }),
    applyEdit: (note, entry) => ({ ...note, ...entry.payload }),
    inScope: (entry, group) => entry.payload.group === group,
    dependencies: {
      parents: [`tags`],
      on: (entry) =>
        entry.kind === `delete`
          ? []
          : entry.payload.tagIds.map((entityId) => ({ collection: `tags`, entityId })),
      without: (payload, parent) =>
        payload.tagIds.includes(parent.entityId)
          ? { ...payload, tagIds: payload.tagIds.filter((id) => id !== parent.entityId) }
          : payload,
    },
  })
}

function note(title: string, tagIds: string[] = [], group = `g1`): NotePayload {
  return { title, tagIds, group }
}

/** Two collections over memory stores, a fake server, a counting key source and a fixed clock. */
function setup(overrides: Partial<CollectionsOptions> = {}) {
  const server = fakeServer()
  const stores = {
    tags: createMemoryOutboxStore<TagPayload, Tag>(),
    notes: createMemoryOutboxStore<NotePayload, Note>(),
  }
  const tagsDefinition = tagDefinition({ store: stores.tags })
  const notesDefinition = noteDefinition({ store: stores.notes })
  const removed: ReferenceRemoved[] = []
  let keys = 0
  const layer: Collections = createCollections({
    collections: [tagsDefinition, notesDefinition],
    calls: server.port,
    canSend: () => !server.state.offline,
    newKey: () => `key-${++keys}`,
    now: () => `2026-10-10T00:00:00.000Z`,
    onReferenceRemoved: (event) => removed.push(event),
    ...overrides,
  })
  return {
    server,
    stores,
    removed,
    layer,
    tags: layer.get(tagsDefinition),
    notes: layer.get(notesDefinition),
    /** The note queue as a list of `[id, tag ids]`. */
    queuedNotes: () =>
      layer.get(notesDefinition).outbox.entries().map((e) => [e.entityId, e.payload.tagIds]),
  }
}

/** A tag create the server will keep refusing for good, so it ends as a conflict after a flush. */
function refuseTagCreates(server: ReturnType<typeof fakeServer>) {
  server.state.refuse = (name) => name === `tag.create` ? refusal(REFUSED) : undefined
}

describe(`a collection's overlay of its queue on a list`, () => {
  it(`shows a queued create at the top of the list`, async () => {
    const { server, tags } = setup()
    server.state.offline = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `New` } })

    const list = await tags.overlay([{ id: `t1`, version: 2, name: `One` }])

    expect(list).toEqual([
      { id: `t-new`, version: 0, name: `New` },
      { id: `t1`, version: 2, name: `One` },
    ])
  })

  it(`hides the row of a queued delete`, async () => {
    const { server, tags } = setup()
    server.state.offline = true
    await tags.outbox.submit({
      kind: `delete`,
      entityId: `t1`,
      payload: { name: `One` },
      version: 2,
    })

    const list = await tags.overlay([
      { id: `t1`, version: 2, name: `One` },
      { id: `t2`, version: 1, name: `Two` },
    ])

    expect(list.map((tag) => tag.id)).toEqual([`t2`])
  })

  it(`replaces the row with a queued edit`, async () => {
    const { server, tags } = setup()
    server.state.offline = true
    await tags.outbox.submit({
      kind: `update`,
      entityId: `t1`,
      payload: { name: `Renamed` },
      version: 2,
    })

    const list = await tags.overlay([{ id: `t1`, version: 2, name: `One` }])

    expect(list).toEqual([{ id: `t1`, version: 2, name: `Renamed` }])
  })

  it(`leaves out the queued writes of another scope`, async () => {
    const { server, notes } = setup()
    server.state.offline = true
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`In g1`, [], `g1`) })
    await notes.outbox.submit({ kind: `create`, entityId: `n2`, payload: note(`In g2`, [], `g2`) })

    const list = await notes.overlay([], `g2`)

    expect(list.map((n) => n.id)).toEqual([`n2`])
  })

  it(`applies the entries it is given, without reading the store`, async () => {
    const { server, tags } = setup()
    server.state.offline = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `New` } })

    const list = tags.applyQueued([], tags.outbox.entries())

    expect(list.map((tag) => tag.id)).toEqual([`t-new`])
  })
})

describe(`a collection over a queue an app wrote before`, () => {
  it(`sends an entry found in the database the adapter names, with its stored key`, async () => {
    const indexedDB = new IDBFactory() as unknown as IDBFactory
    const database = `offline:user:7:outbox`
    const earlier = createIndexedDbOutboxStore<TagPayload, Tag>({ name: database, indexedDB })
    const entry: OutboxEntry<TagPayload, Tag> = {
      key: `stored-key`,
      entityId: `t-old`,
      kind: `create`,
      payload: { name: `From before` },
      baseVersion: 0,
      attempted: false,
      status: `pending`,
      queuedAt: `2026-10-01T00:00:00.000Z`,
    }
    await earlier.putEntry(entry)
    const server = fakeServer()
    const layer = createCollections({
      collections: [tagDefinition({ database })],
      calls: server.port,
      canSend: () => true,
      indexedDB,
    })

    await layer.reload()
    await layer.flush()

    expect(server.calls).toEqual([{
      name: `tag.create`,
      payload: { id: `t-old`, name: `From before`, version: 0 },
      key: `stored-key`,
    }])
    expect(await earlier.readOutbox()).toEqual([])
  })
})

describe(`collections sent through one ordered flush`, () => {
  it(`sends a parent's queue before a child's, whatever order they were queued in`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.offline = true
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`, [`t-new`]) })
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })

    server.state.offline = false
    await layer.flush()

    expect(server.names()).toEqual([`tag.create`, `note.create`])
  })

  it(`holds a note made online back while a tag it names is still queued`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.lose = true
    const tagOutcome = await tags.outbox.submit({
      kind: `create`,
      entityId: `t-new`,
      payload: { name: `Tag` },
    })
    expect(tagOutcome.kind).toBe(`queued`)

    const outcome = await notes.outbox.submit({
      kind: `create`,
      entityId: `n1`,
      payload: note(`Note`, [`t-new`]),
    })

    expect(outcome.kind).toBe(`queued`)
    expect(server.names()).toEqual([`tag.create`, `tag.create`])
    server.state.lose = false
    await layer.flush()
    expect(server.names().slice(2)).toEqual([`tag.create`, `note.create`])
  })

  it(`sends the whole queue, parents first, when a write is made online`, async () => {
    const { server, tags, notes } = setup()
    server.state.offline = true
    await notes.outbox.submit({
      kind: `create`,
      entityId: `n1`,
      payload: note(`Queued`, [`t-new`]),
    })
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    server.state.offline = false

    const outcome = await notes.outbox.submit({
      kind: `create`,
      entityId: `n2`,
      payload: note(`Made online`, [`t-new`]),
    })

    expect(outcome.kind).toBe(`sent`)
    expect(server.calls.map((c) => [c.name, c.payload.id])).toEqual([
      [`tag.create`, `t-new`],
      [`note.create`, `n1`],
      [`note.create`, `n2`],
    ])
  })

  it(`sends nothing while the app says it cannot send`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.offline = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`) })

    await layer.flush()

    expect(server.calls).toEqual([])
    expect(tags.outbox.entries().length + notes.outbox.entries().length).toBe(2)
  })

  it(`runs every collection's steps under the one lock it was given`, async () => {
    let holders = 0
    let mostAtOnce = 0
    const inner = createPromiseLock()
    const lock: OutboxLock = (work) =>
      inner(async () => {
        holders++
        mostAtOnce = Math.max(mostAtOnce, holders)
        try {
          return await work()
        } finally {
          holders--
        }
      })
    let used = 0
    const counted: OutboxLock = (work) => {
      used++
      return lock(work)
    }
    const { server, tags, notes } = setup({ lock: counted })
    server.state.offline = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`, [`t-new`]) })
    server.state.offline = false
    used = 0

    await Promise.all([tags.outbox.flush(), notes.outbox.flush()])

    expect(used).toBeGreaterThan(0)
    expect(mostAtOnce).toBe(1)
    expect(server.names()).toEqual([`tag.create`, `note.create`])
  })
})

describe(`a child waiting for its parent`, () => {
  it(`reports a note behind a queued tag as waiting, not on the person`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.lose = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`, [`t-new`]) })

    expect(layer.waiting()).toEqual([{
      collection: `notes`,
      entityId: `n1`,
      blockedBy: [{ collection: `tags`, entityId: `t-new`, status: `pending` }],
      onPerson: false,
    }])
  })

  it(`holds a note back while a tag it names is in conflict, and says the person must choose`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.tags.set(`t1`, { id: `t1`, version: 5, name: `Theirs` })
    server.state.offline = true
    await tags.outbox.submit({
      kind: `update`,
      entityId: `t1`,
      payload: { name: `Mine` },
      version: 2,
    })
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`, [`t1`]) })
    server.state.offline = false
    server.state.refuse = (name) => name === `tag.update` ? refusal(VERSION_CONFLICT) : undefined

    await layer.flush()

    expect(tags.outbox.entries()[0].status).toBe(`conflict`)
    expect(tags.outbox.entries()[0].conflict?.message).toBe(`Someone else changed this tag.`)
    expect(server.names()).toEqual([`tag.update`])
    expect(layer.waiting()).toEqual([{
      collection: `notes`,
      entityId: `n1`,
      blockedBy: [{ collection: `tags`, entityId: `t1`, status: `conflict` }],
      onPerson: true,
    }])
  })

  it(`sends the note once the person keeps their tag`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.tags.set(`t1`, { id: `t1`, version: 5, name: `Theirs` })
    server.state.offline = true
    await tags.outbox.submit({
      kind: `update`,
      entityId: `t1`,
      payload: { name: `Mine` },
      version: 2,
    })
    await notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`Note`, [`t1`]) })
    server.state.offline = false
    server.state.refuse = (name) => name === `tag.update` ? refusal(VERSION_CONFLICT) : undefined
    await layer.flush()
    server.state.refuse = undefined

    await tags.outbox.keepMine(tags.outbox.entries()[0])

    expect(server.names()).toEqual([`tag.update`, `tag.update`, `note.create`])
    expect(layer.waiting()).toEqual([])
    expect(notes.outbox.entries()).toEqual([])
  })

  it(`still sends a note that names no waiting tag`, async () => {
    const { server, tags, notes, layer } = setup()
    server.state.lose = true
    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    server.state.lose = false
    server.state.refuse = (name) => name === `tag.create` ? refusal(REFUSED) : undefined
    await notes.outbox.submit({
      kind: `create`,
      entityId: `n-waits`,
      payload: note(`Waits`, [`t-new`]),
    })
    await notes.outbox.submit({ kind: `create`, entityId: `n-free`, payload: note(`Free`) })

    await layer.flush()

    expect(server.calls.filter((c) => c.name === `note.create`).map((c) => c.payload.id)).toEqual([
      `n-free`,
    ])
    expect(layer.waiting().map((w) => w.entityId)).toEqual([`n-waits`])
  })

  it(`tells subscribers when a queue changes`, async () => {
    const { server, tags, layer } = setup()
    server.state.offline = true
    let told = 0
    const stop = layer.subscribe(() => told++)

    await tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    const afterSubmit = told
    stop()
    await tags.outbox.withdraw(`t-new`)

    expect(afterSubmit).toBeGreaterThan(0)
    expect(told).toBe(afterSubmit)
  })
})

describe(`a parent that will never exist`, () => {
  /** A tag create and two notes naming it, queued offline. */
  async function queued() {
    const h = setup()
    h.server.state.offline = true
    await h.tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await h.notes.outbox.submit({
      kind: `create`,
      entityId: `n1`,
      payload: note(`One`, [`t-new`, `t-old`]),
    })
    await h.notes.outbox.submit({ kind: `create`, entityId: `n2`, payload: note(`Two`, [`t-old`]) })
    return h
  }

  it(`removes the tag from the queued notes when its create is withdrawn`, async () => {
    const h = await queued()

    const withdrawn = await h.tags.outbox.withdraw(`t-new`)

    expect(withdrawn).toBe(true)
    expect(h.queuedNotes()).toEqual([[`n1`, [`t-old`]], [`n2`, [`t-old`]]])
    expect(h.removed).toEqual([{
      parent: { collection: `tags`, entityId: `t-new` },
      reason: `withdrawn`,
      children: [{ collection: `notes`, entityId: `n1` }],
    }])
  })

  it(`removes the tag from the queued notes when it is created and deleted before any send`, async () => {
    const h = await queued()

    const outcome = await h.tags.outbox.submit({
      kind: `delete`,
      entityId: `t-new`,
      payload: { name: `Tag` },
      version: 1,
    })

    expect(outcome.kind).toBe(`dropped`)
    expect(h.queuedNotes()).toEqual([[`n1`, [`t-old`]], [`n2`, [`t-old`]]])
    expect(h.removed.map((e) => e.reason)).toEqual([`dropped`])
  })

  it(`removes the tag from the queued notes when the person discards a refused create`, async () => {
    const h = await queued()
    refuseTagCreates(h.server)
    h.server.state.offline = false
    await h.layer.flush()
    expect(h.tags.outbox.entries()[0].status).toBe(`conflict`)
    // Note two names no tag in the way and went; note one waits for the person's choice.
    expect(h.server.calls.map((c) => [c.name, c.payload.id])).toEqual([
      [`tag.create`, `t-new`],
      [`note.create`, `n2`],
    ])

    await h.tags.outbox.useTheirs(h.tags.outbox.entries()[0])
    h.server.state.refuse = undefined
    await h.layer.flush()

    expect(h.removed.map((e) => e.reason)).toEqual([`discarded`])
    expect(h.server.calls.at(-1)).toMatchObject({
      name: `note.create`,
      payload: { id: `n1`, tagIds: [`t-old`] },
    })
  })

  it(`removes the tag from the queued notes when the create is refused to the person who made it`, async () => {
    const h = setup()
    h.server.state.offline = true
    await h.notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`One`, [`t-new`]) })
    h.server.state.offline = false
    refuseTagCreates(h.server)

    const outcome = await h.tags.outbox.submit({
      kind: `create`,
      entityId: `t-new`,
      payload: { name: `Tag` },
    })

    expect(outcome.kind).toBe(`failed`)
    expect(h.removed.map((e) => e.reason)).toEqual([`discarded`])
    expect(h.server.calls.find((c) => c.name === `note.create`)?.payload.tagIds).toEqual([])
  })

  it(`sends the notes without the tag once it is gone`, async () => {
    const h = await queued()
    await h.tags.outbox.withdraw(`t-new`)
    h.server.state.offline = false

    await h.layer.flush()

    expect(h.server.calls.map((c) => [c.name, c.payload.tagIds])).toEqual([
      [`note.create`, [`t-old`]],
      [`note.create`, [`t-old`]],
    ])
  })

  it(`gives a note whose send may have reached the server a new key when its text changes`, async () => {
    const h = setup()
    h.server.state.offline = true
    await h.tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    const seeded = await h.stores.notes.putEntry({
      key: `old-key`,
      entityId: `n1`,
      kind: `create`,
      payload: note(`One`, [`t-new`]),
      baseVersion: 0,
      attempted: true,
      status: `pending`,
      queuedAt: `2026-10-10T00:00:00.000Z`,
    })
    await h.layer.reload()

    await h.tags.outbox.withdraw(`t-new`)

    const [entry] = await h.stores.notes.readOutbox()
    expect(entry.seq).toBe(seeded.seq)
    expect(entry.payload.tagIds).toEqual([])
    expect(entry.key).not.toBe(`old-key`)
    expect(entry.attempted).toBe(false)
  })

  it(`keeps the key of a note that was never sent`, async () => {
    const h = await queued()
    const before = h.notes.outbox.entries().map((e) => e.key)

    await h.tags.outbox.withdraw(`t-new`)

    expect(h.notes.outbox.entries().map((e) => e.key)).toEqual(before)
  })

  it(`also removes the tag from the earlier text of an edited note, so withdrawing the edit does not bring it back`, async () => {
    const h = setup()
    h.server.state.offline = true
    await h.tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await h.notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`One`, [`t-new`]) })
    await h.notes.outbox.submit({
      kind: `update`,
      entityId: `n1`,
      payload: note(`One, edited`, [`t-new`, `t-old`]),
      version: 0,
    })

    await h.tags.outbox.withdraw(`t-new`)
    await h.notes.outbox.withdraw(`n1`)

    expect(h.queuedNotes()).toEqual([[`n1`, []]])
  })

  it(`leaves a note that does not name the tag untouched`, async () => {
    const h = setup()
    h.server.state.offline = true
    await h.tags.outbox.submit({ kind: `create`, entityId: `t-new`, payload: { name: `Tag` } })
    await h.notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`One`, [`t-old`]) })

    await h.tags.outbox.withdraw(`t-new`)

    expect(h.removed).toEqual([])
    expect(h.queuedNotes()).toEqual([[`n1`, [`t-old`]]])
  })

  it(`does not touch the notes when a queued tag edit is withdrawn`, async () => {
    const h = setup()
    h.server.state.offline = true
    await h.tags.outbox.submit({
      kind: `update`,
      entityId: `t1`,
      payload: { name: `Mine` },
      version: 2,
    })
    await h.notes.outbox.submit({ kind: `create`, entityId: `n1`, payload: note(`One`, [`t1`]) })

    await h.tags.outbox.withdraw(`t1`)

    expect(h.queuedNotes()).toEqual([[`n1`, [`t1`]]])
  })
})

describe(`registering collections`, () => {
  it(`refuses a child registered before its parent`, () => {
    const server = fakeServer()

    expect(() =>
      createCollections({
        collections: [noteDefinition(), tagDefinition()],
        calls: server.port,
        canSend: () => true,
      })
    ).toThrow(`depends on "tags", which must be registered before it`)
  })

  it(`refuses two collections of one name`, () => {
    const server = fakeServer()

    expect(() =>
      createCollections({
        collections: [tagDefinition(), tagDefinition()],
        calls: server.port,
        canSend: () => true,
      })
    ).toThrow(`registered twice`)
  })

  it(`refuses a definition that was not registered`, () => {
    const server = fakeServer()
    const layer = createCollections({
      collections: [tagDefinition()],
      calls: server.port,
      canSend: () => true,
    })

    expect(() => layer.get(noteDefinition())).toThrow(`not registered`)
  })
})

describe(`classifyByCode`, () => {
  const read = classifyByCode({ version: `V`, notFound: `N`, alreadyExists: `E` })
  const coded = (code: string) => new RealtimeRequestError(`conflict`, `no: ${code}`, { code })

  it(`reads the server's codes as the kinds of refusal they name`, () => {
    expect(read(coded(`V`))).toEqual({ kind: `version` })
    expect(read(coded(`N`))).toEqual({ kind: `not-found` })
    expect(read(coded(`E`))).toEqual({ kind: `already-exists` })
  })

  it(`reads any other refusal as final, with the server's message`, () => {
    expect(read(coded(`OTHER`))).toEqual({ kind: `rejected`, message: `no: OTHER` })
  })

  it(`reads a lost connection, a late answer and a foreign error as unreachable`, () => {
    expect(read(new ConnectionLostError(`lost`))).toEqual({ kind: `unreachable` })
    expect(read(new RealtimeRequestError(`timeout`, `late`))).toEqual({ kind: `unreachable` })
    expect(read(new TypeError(`fetch failed`))).toEqual({ kind: `unreachable` })
  })
})
