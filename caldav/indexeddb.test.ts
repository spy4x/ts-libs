import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { IDBFactory } from "npm:fake-indexeddb@6.2.5"
import {
  type CachedObject,
  createIndexedDbCalDavCache,
  IndexedDbUnavailableError,
} from "./indexeddb.ts"
import type { StoredCalendar, SyncObject } from "./sync.ts"

function freshFactory(): IDBFactory {
  return new IDBFactory()
}

const calendar = (href: string, syncedMarker?: string): StoredCalendar => ({
  href,
  completedLoaded: false,
  syncedMarker,
})
const object = (href: string, etag: string | null = `"1"`): SyncObject => ({
  href,
  etag,
  ics: `BEGIN:VCALENDAR\nEND:VCALENDAR`,
})

describe(`createIndexedDbCalDavCache`, () => {
  it(`returns the calendars it was given, and only those after a replace`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.replaceCalendars([calendar(`/a/`), calendar(`/b/`)])
    await cache.replaceCalendars([calendar(`/b/`, `m2`), calendar(`/c/`)])

    const hrefs = (await cache.listCalendars()).map((c) => c.href).sort()
    expect(hrefs).toEqual([`/b/`, `/c/`])
    expect((await cache.listCalendars()).find((c) => c.href === `/b/`)?.syncedMarker).toBe(`m2`)
  })

  it(`drops the objects of a calendar the server no longer lists, and keeps the others`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.applyChanges(calendar(`/a/`), {
      upsert: [object(`/a/1`), object(`/a/2`)],
      remove: [],
    })
    await cache.applyChanges(calendar(`/b/`), { upsert: [object(`/b/1`)], remove: [] })

    await cache.replaceCalendars([calendar(`/b/`)])

    expect((await cache.listObjects()).map((o) => o.href)).toEqual([`/b/1`])
    expect(await cache.listObjects(`/a/`)).toEqual([])
  })

  it(`lists objects of one calendar apart from the rest`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.applyChanges(calendar(`/a/`), { upsert: [object(`/a/1`)], remove: [] })
    await cache.applyChanges(calendar(`/b/`), { upsert: [object(`/b/1`)], remove: [] })

    expect((await cache.listObjects(`/a/`)).map((o) => o.href)).toEqual([`/a/1`])
    expect((await cache.listObjects()).length).toBe(2)
  })

  it(`lists the href and etag of each object of a calendar as versions`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.applyChanges(calendar(`/a/`), {
      upsert: [object(`/a/1`, `"x"`), object(`/a/2`, null)],
      remove: [],
    })
    await cache.applyChanges(calendar(`/b/`), { upsert: [object(`/b/1`)], remove: [] })

    const versions = (await cache.listVersions(`/a/`)).sort((p, q) => p.href < q.href ? -1 : 1)
    expect(versions).toEqual([{ href: `/a/1`, etag: `"x"` }, { href: `/a/2`, etag: null }])
  })

  it(`applies upserts, removals and the calendar together`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.applyChanges(calendar(`/a/`), {
      upsert: [object(`/a/1`), object(`/a/2`)],
      remove: [],
    })

    await cache.applyChanges(calendar(`/a/`, `m2`), {
      upsert: [object(`/a/1`, `"2"`)],
      remove: [`/a/2`],
    })

    expect(await cache.listVersions(`/a/`)).toEqual([{ href: `/a/1`, etag: `"2"` }])
    expect((await cache.listCalendars())[0].syncedMarker).toBe(`m2`)
  })

  it(`leaves the previous state when a batch of changes fails midway`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.applyChanges(calendar(`/a/`), { upsert: [object(`/a/1`)], remove: [] })

    // A function cannot be cloned into IndexedDB, so the put throws after the removal ran.
    const poisoned = { ...object(`/a/2`), bad: () => {} }
    await expect(
      cache.applyChanges(calendar(`/a/`, `m2`), { upsert: [poisoned], remove: [`/a/1`] }),
    ).rejects.toThrow()

    expect(await cache.listVersions(`/a/`)).toEqual([{ href: `/a/1`, etag: `"1"` }])
    expect((await cache.listCalendars())[0].syncedMarker).toBeUndefined()
  })

  it(`puts and deletes a single object`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.putObject({ ...object(`/a/1`), calendarHref: `/a/` })
    await cache.putObject({ ...object(`/a/1`, `"9"`), calendarHref: `/a/` })
    expect((await cache.listObjects(`/a/`)).map((o) => o.etag)).toEqual([`"9"`])

    await cache.deleteObject(`/a/1`)
    await cache.deleteObject(`/a/missing`)

    expect(await cache.listObjects()).toEqual([])
  })

  it(`stores extra fields the app builds from a synced object`, async () => {
    interface Task extends CachedObject {
      ics: string
      summary: string
    }
    const cache = createIndexedDbCalDavCache<StoredCalendar, Task>({
      indexedDB: freshFactory(),
      fromSyncObject: (o, calendarHref) => ({ ...o, calendarHref, summary: `parsed ${o.href}` }),
    })
    await cache.applyChanges(calendar(`/a/`), { upsert: [object(`/a/1`)], remove: [] })

    expect((await cache.listObjects(`/a/`))[0].summary).toBe(`parsed /a/1`)
  })

  it(`requires fromSyncObject when the cached object type has extra fields`, () => {
    interface Task extends CachedObject {
      summary: string
    }
    // @ts-expect-error a Task needs fromSyncObject, or `summary` would be missing at runtime
    createIndexedDbCalDavCache<StoredCalendar, Task>({ indexedDB: freshFactory() }).close()
  })

  it(`closes its connection on close`, async () => {
    const real = freshFactory()
    const opened: IDBDatabase[] = []
    const watching = {
      open(name: string, version?: number) {
        const request = real.open(name, version)
        request.addEventListener("success", () => opened.push(request.result as IDBDatabase))
        return request
      },
    } as unknown as IDBFactory
    const cache = createIndexedDbCalDavCache({ indexedDB: watching })
    await cache.replaceCalendars([calendar(`/a/`)])

    cache.close()

    expect(opened.length).toBe(1)
    expect(() => opened[0].transaction(`calendars`)).toThrow()
  })

  it(`keeps the data across a restart on the same database`, async () => {
    const indexedDB = freshFactory()
    const before = createIndexedDbCalDavCache({ indexedDB })
    await before.applyChanges(calendar(`/a/`), { upsert: [object(`/a/1`)], remove: [] })
    before.close()

    const after = createIndexedDbCalDavCache({ indexedDB })

    expect((await after.listObjects()).length).toBe(1)
  })

  it(`works again after close`, async () => {
    const cache = createIndexedDbCalDavCache({ indexedDB: freshFactory() })
    await cache.replaceCalendars([calendar(`/a/`)])
    cache.close()

    expect((await cache.listCalendars()).length).toBe(1)
  })

  it(`upgrades a database that holds other stores without throwing`, async () => {
    const indexedDB = freshFactory()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`legacy`, 1)
      request.onupgradeneeded = () => {
        // Same store names as the cache, other keys: creating them again would throw.
        request.result.createObjectStore(`calendars`, { keyPath: `id` })
        request.result.createObjectStore(`tasks`, { keyPath: `id` })
      }
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
    const cache = createIndexedDbCalDavCache({ name: `legacy`, version: 2, indexedDB })

    await cache.replaceCalendars([calendar(`/a/`)])

    expect((await cache.listCalendars()).length).toBe(1)
  })

  it(`rejects with IndexedDbUnavailableError when IndexedDB is missing`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, `indexedDB`)
    Object.defineProperty(globalThis, `indexedDB`, { value: undefined, configurable: true })
    try {
      const cache = createIndexedDbCalDavCache()
      await expect(cache.listCalendars()).rejects.toBeInstanceOf(IndexedDbUnavailableError)
    } finally {
      if (original) Object.defineProperty(globalThis, `indexedDB`, original)
      else delete (globalThis as Record<string, unknown>).indexedDB
    }
  })

  it(`rejects with IndexedDbUnavailableError when the browser refuses to open`, async () => {
    const refusing = {
      open() {
        throw new DOMException(`denied`, `SecurityError`)
      },
    } as unknown as IDBFactory
    const cache = createIndexedDbCalDavCache({ indexedDB: refusing })

    await expect(cache.listObjects()).rejects.toBeInstanceOf(IndexedDbUnavailableError)
  })
})
