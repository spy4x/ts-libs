import { expect } from "@std/expect"
import { type CalDavClient, CalDavErrorCode } from "./client.ts"
import {
  type CalDavSyncStore,
  type CalDavSyncTransport,
  createCalDavSync,
  createClientTransport,
  type StoredCalendar,
  type SyncCalendar,
  type SyncChanges,
  type SyncObject,
  type SyncTransportResult,
} from "./sync.ts"

const A = `/cal/a/`
const B = `/cal/b/`

const obj = (href: string, etag: string | null, ics = `ics-${href}-${etag}`): SyncObject => ({
  href,
  etag,
  ics,
})

/** A server: calendars with markers, objects per calendar, and counters of what was asked. */
function fakeServer() {
  const server = {
    calendars: [{ href: A, changeMarker: `m1` }, { href: B, changeMarker: `m1` }] as SyncCalendar[],
    objects: new Map<string, SyncObject[]>([[A, []], [B, []]]),
    completed: new Map<string, SyncObject[]>(),
    down: false,
    failing: new Set<string>(),
    calls: [] as string[],
    bodiesFetched: [] as string[],
    withVersions: false,
  }
  const visible = (href: string, includeCompleted: boolean) => [
    ...server.objects.get(href) ?? [],
    ...includeCompleted ? server.completed.get(href) ?? [] : [],
  ]
  const transport: CalDavSyncTransport = {
    listCalendars: () => {
      server.calls.push(`calendars`)
      return Promise.resolve(
        server.down
          ? { ok: false, offline: true } as const
          : { ok: true, data: structuredClone(server.calendars) } as const,
      )
    },
    listObjects: (calendar, { includeCompleted }) => {
      server.calls.push(`objects ${calendar.href} completed=${includeCompleted}`)
      return Promise.resolve(
        answer(server, calendar.href, visible(calendar.href, includeCompleted)),
      )
    },
  }
  const withVersions: CalDavSyncTransport = {
    ...transport,
    listVersions: (calendar, { includeCompleted }) => {
      server.calls.push(`versions ${calendar.href}`)
      const versions = visible(calendar.href, includeCompleted).map(({ href, etag }) => ({
        href,
        etag,
      }))
      return Promise.resolve(answer(server, calendar.href, versions))
    },
    getObjects: (calendar, hrefs) => {
      server.calls.push(`get ${calendar.href} ${hrefs.join(`,`)}`)
      server.bodiesFetched.push(...hrefs)
      const all = visible(calendar.href, true)
      return Promise.resolve(
        answer(server, calendar.href, all.filter((o) => hrefs.includes(o.href))),
      )
    },
  }
  return { server, transport, withVersions }
}

function answer<T>(
  server: { down: boolean; failing: Set<string> },
  calendar: string,
  data: T,
): SyncTransportResult<T> {
  if (server.down) return { ok: false, offline: true }
  if (server.failing.has(calendar)) return { ok: false, offline: false }
  return { ok: true, data }
}

/** A store in memory that records every write. */
function fakeStore() {
  const calendars = new Map<string, StoredCalendar>()
  const objects = new Map<string, Map<string, SyncObject>>()
  const writes: { calendar: string; changes: SyncChanges }[] = []
  const store: CalDavSyncStore = {
    listCalendars: () => Promise.resolve([...calendars.values()]),
    listVersions: (href) =>
      Promise.resolve(
        [...objects.get(href)?.values() ?? []].map(({ href, etag }) => ({ href, etag })),
      ),
    replaceCalendars: (list) => {
      const keep = new Set(list.map((c) => c.href))
      for (const href of [...calendars.keys()]) {
        if (!keep.has(href)) {
          calendars.delete(href)
          objects.delete(href)
        }
      }
      for (const c of list) calendars.set(c.href, c)
      return Promise.resolve()
    },
    applyChanges: (calendar, changes) => {
      writes.push({ calendar: calendar.href, changes })
      calendars.set(calendar.href, calendar)
      const bucket = objects.get(calendar.href) ?? new Map()
      for (const href of changes.remove) bucket.delete(href)
      for (const o of changes.upsert) bucket.set(o.href, o)
      objects.set(calendar.href, bucket)
      return Promise.resolve()
    },
  }
  const held = (href: string) => [...objects.get(href)?.keys() ?? []].sort()
  return { store, calendars, writes, held, objects }
}

Deno.test(`an unchanged change marker skips the object fetch, a changed one fetches again`, async () => {
  const { server, transport } = fakeServer()
  const { store } = fakeStore()
  server.objects.set(A, [obj(`${A}1`, `"1"`)])
  const sync = createCalDavSync(transport, store)

  await sync.refresh()
  server.calls.length = 0
  await sync.refresh()
  expect(server.calls).toEqual([`calendars`])

  server.calls.length = 0
  server.calendars[0].changeMarker = `m2`
  await sync.refresh()
  expect(server.calls).toEqual([`calendars`, `objects ${A} completed=false`])
})

Deno.test(`a calendar with no change marker is fetched on every refresh`, async () => {
  const { server, transport } = fakeServer()
  const { store } = fakeStore()
  server.calendars = [{ href: A }]
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  await sync.refresh()
  expect(server.calls.filter((c) => c.startsWith(`objects`)).length).toBe(2)
})

Deno.test(`only new or changed objects are written, and objects the server dropped are removed`, async () => {
  const { server, transport } = fakeServer()
  const { store, writes, held } = fakeStore()
  server.objects.set(A, [obj(`${A}keep`, `"k"`), obj(`${A}edit`, `"e1"`), obj(`${A}gone`, `"g"`)])
  const sync = createCalDavSync(transport, store)
  await sync.refresh()

  server.objects.set(A, [obj(`${A}keep`, `"k"`), obj(`${A}edit`, `"e2"`), obj(`${A}new`, `"n"`)])
  server.calendars[0].changeMarker = `m2`
  const outcome = await sync.refresh()

  const last = writes.at(-1)!
  expect(last.changes.upsert.map((o) => o.href).sort()).toEqual([`${A}edit`, `${A}new`])
  expect(last.changes.remove).toEqual([`${A}gone`])
  expect(held(A)).toEqual([`${A}edit`, `${A}keep`, `${A}new`])
  expect(outcome).toEqual({ answered: true, failed: [], written: 2, removed: 1 })
})

Deno.test(`an object without an etag is written again on every changed refresh`, async () => {
  const { server, transport } = fakeServer()
  const { store, writes } = fakeStore()
  server.calendars = [{ href: A }]
  server.objects.set(A, [obj(`${A}1`, null)])
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  await sync.refresh()
  expect(writes.map((w) => w.changes.upsert.length)).toEqual([1, 1])
})

Deno.test(`with etag listing and multiget, only the bodies of changed objects are fetched`, async () => {
  const { server, withVersions } = fakeServer()
  const { store, held } = fakeStore()
  server.objects.set(A, [obj(`${A}1`, `"1"`), obj(`${A}2`, `"2"`), obj(`${A}3`, `"3"`)])
  const sync = createCalDavSync(withVersions, store)
  await sync.refresh()
  server.bodiesFetched.length = 0

  server.objects.set(A, [obj(`${A}1`, `"1"`), obj(`${A}2`, `"2b"`)])
  server.calendars[0].changeMarker = `m2`
  await sync.refresh()

  expect(server.bodiesFetched).toEqual([`${A}2`])
  expect(held(A)).toEqual([`${A}1`, `${A}2`])
})

Deno.test(`a calendar the server no longer lists is dropped with its objects`, async () => {
  const { server, transport } = fakeServer()
  const { store, calendars, held } = fakeStore()
  server.objects.set(B, [obj(`${B}1`, `"1"`)])
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  expect(held(B)).toEqual([`${B}1`])

  server.calendars = [server.calendars[0]]
  await sync.refresh()
  expect([...calendars.keys()]).toEqual([A])
  expect(held(B)).toEqual([])
})

Deno.test(`with no answer to the calendar list nothing is touched and the outcome says so`, async () => {
  const { server, transport } = fakeServer()
  const { store, calendars, writes } = fakeStore()
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  const before = writes.length
  server.down = true
  const outcome = await sync.refresh()
  expect(outcome.answered).toBe(false)
  expect(writes.length).toBe(before)
  expect(calendars.size).toBe(2)
})

Deno.test(`a calendar that fails is skipped and the next one is still fetched`, async () => {
  const { server, transport } = fakeServer()
  const { store, held } = fakeStore()
  server.objects.set(A, [obj(`${A}1`, `"1"`)])
  server.objects.set(B, [obj(`${B}1`, `"1"`)])
  server.failing.add(A)
  const outcome = await createCalDavSync(transport, store).refresh()
  expect(outcome.failed).toEqual([A])
  expect(held(A)).toEqual([])
  expect(held(B)).toEqual([`${B}1`])
})

Deno.test(`when the network drops mid-run the remaining calendars are not asked`, async () => {
  const { server, transport } = fakeServer()
  const { store } = fakeStore()
  const original = transport.listObjects
  transport.listObjects = (calendar, options) => {
    server.down = true
    return original(calendar, options)
  }
  const outcome = await createCalDavSync(transport, store).refresh()
  expect(outcome.failed).toEqual([A])
  expect(server.calls.filter((c) => c.startsWith(`objects`)).length).toBe(1)
})

Deno.test(`overlapping refreshes share one run, and a later one starts a new run`, async () => {
  const { server, transport } = fakeServer()
  const { store } = fakeStore()
  const sync = createCalDavSync(transport, store)
  const [one, two] = [sync.refresh(), sync.refresh()]
  expect(one).toBe(two)
  await one
  expect(server.calls.filter((c) => c === `calendars`).length).toBe(1)
  await sync.refresh()
  expect(server.calls.filter((c) => c === `calendars`).length).toBe(2)
})

Deno.test(`a store failure rejects the refresh, and the next refresh still runs`, async () => {
  const { transport } = fakeServer()
  const { store } = fakeStore()
  let broken = true
  const original = store.replaceCalendars
  store.replaceCalendars = (calendars) =>
    broken ? Promise.reject(new Error(`disk full`)) : original(calendars)
  const sync = createCalDavSync(transport, store)
  await expect(sync.refresh()).rejects.toThrow(`disk full`)
  broken = false
  expect((await sync.refresh()).answered).toBe(true)
})

Deno.test(`completed tasks come only after a calendar asks, and later refreshes keep them`, async () => {
  const { server, transport } = fakeServer()
  const { store, held } = fakeStore()
  server.objects.set(A, [obj(`${A}open`, `"o"`)])
  server.completed.set(A, [obj(`${A}done`, `"d"`)])
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  expect(held(A)).toEqual([`${A}open`])

  expect(await sync.loadCompleted(A)).toBe(true)
  expect(held(A)).toEqual([`${A}done`, `${A}open`])

  server.calendars[0].changeMarker = `m2`
  await sync.refresh()
  expect(held(A)).toEqual([`${A}done`, `${A}open`])
  expect(server.calls.at(-1)).toBe(`objects ${A} completed=true`)
})

Deno.test(`loading completed tasks of an unknown calendar resolves false, of a silent server too`, async () => {
  const { server, transport } = fakeServer()
  const { store } = fakeStore()
  const sync = createCalDavSync(transport, store)
  await sync.refresh()
  expect(await sync.loadCompleted(`/cal/nope/`)).toBe(false)
  server.down = true
  expect(await sync.loadCompleted(A)).toBe(false)
})

Deno.test(`the client transport maps calendars and objects, and reads a lost network as offline`, async () => {
  const calls: unknown[] = []
  let failWith: CalDavErrorCode | null = null
  const fail = (code: CalDavErrorCode) => ({
    success: false as const,
    output: null,
    error: { code, message: `x` },
  })
  const client = {
    listCalendars: (home: string) => {
      calls.push(home)
      if (failWith) return Promise.resolve(fail(failWith))
      return Promise.resolve({
        success: true as const,
        error: null,
        output: [
          { url: `https://d/a/`, displayName: `A`, components: [], ctag: `c1`, syncToken: `t1` },
          { url: `https://d/b/`, displayName: `B`, components: [], syncToken: `t2` },
        ],
      })
    },
    listObjects: (url: string, options: unknown) => {
      calls.push([url, options])
      return Promise.resolve({
        success: true as const,
        error: null,
        output: [{ url: `https://d/a/1.ics`, etag: `"1"`, data: `ics` }],
      })
    },
  } as unknown as CalDavClient
  const transport = createClientTransport(client, { homeUrl: `https://d/`, component: `VTODO` })

  const listed = await transport.listCalendars()
  expect(listed).toEqual({
    ok: true,
    data: [
      { href: `https://d/a/`, displayName: `A`, changeMarker: `c1` },
      { href: `https://d/b/`, displayName: `B`, changeMarker: `t2` },
    ],
  })
  const objects = await transport.listObjects(listed.ok ? listed.data[0] : never(), {
    includeCompleted: true,
  })
  expect(objects).toEqual({
    ok: true,
    data: [{ href: `https://d/a/1.ics`, etag: `"1"`, ics: `ics` }],
  })
  expect(calls[1]).toEqual([`https://d/a/`, { component: `VTODO`, includeCompleted: true }])

  failWith = CalDavErrorCode.Network
  expect(await transport.listCalendars()).toEqual({ ok: false, offline: true })
  failWith = CalDavErrorCode.Unauthorized
  expect(await transport.listCalendars()).toEqual({ ok: false, offline: false })
})

function never(): never {
  throw new Error(`unreachable`)
}
