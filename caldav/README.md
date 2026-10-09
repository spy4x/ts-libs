# `@spy4x/caldav`

A CalDAV client that finds the user's calendars and changes tasks and events without overwriting
someone else's edit, plus the building blocks it uses: a safe reader for WebDAV multistatus XML,
request bodies that escape what they write, and the URL rules a CalDAV client needs (resolving
hrefs, comparing resources, sending credentials only to the configured server).

| Module         | Exports                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caldav`       | `createCalDavClient`, `CalDavErrorCode`, `CalDavClient`, `CalDavCalendar`, `CalDavObject`, …                                                                                                               |
| `caldav/xml`   | `parseMultistatus`, `getProp`, `getPropText`, `parseXml`, `childElement`, `textContent`, `serializeXml`, `propfindBody`, `calendarQueryBody`, `calendarMultigetBody`, `mkcalendarBody`, `proppatchBody`, … |
| `caldav/url`   | `resolveHref`, `sameResource`, `childUrl`, `isSameOrigin`                                                                                                                                                  |
| `caldav/sync`  | `createCalDavSync`, `createClientTransport`, `CalDavSyncTransport`, `CalDavSyncStore`, …                                                                                                                   |
| `caldav/write` | `createCalDavWriteTransport`, `classifyCalDavError`, `objectUrl`, `CalDavWriteError`, …                                                                                                                    |

## Install

```bash
deno add jsr:@spy4x/caldav
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## The client

```ts
import { CalDavErrorCode, createCalDavClient } from "@spy4x/caldav"

const client = createCalDavClient({
  serverUrl: "https://dav.example.com/", // the bare host or `…/dav/cal/` both work
  auth: { username: "user@example.com", password: "…" },
})

const found = await client.discover() // .well-known → current-user-principal → calendar-home-set
if (!found.success) throw new Error(found.error.message)
const calendars = await client.listCalendars(found.output.homeUrls[0])
// Each: url, displayName, components, color?, ctag?, syncToken?

const inbox = "https://dav.example.com/dav/cal/user%40example.com/inbox/"
const open = await client.listObjects(inbox, { component: "VTODO" }) // completed tasks left out
const all = await client.listObjects(inbox, { component: "VTODO", includeCompleted: true })

const created = await client.createObject(inbox, ics) // a UUID name, `If-None-Match: *`
if (!created.success) throw new Error(created.error.message)
// A server may answer a PUT without an ETag (`etag: null`); then read the object to get one.
const current = await client.getObject(created.output.url)
if (!current.success || current.output.etag === null) throw new Error("no etag to update with")
const updated = await client.updateObject(current.output.url, changed, current.output.etag)
if (!updated.success && updated.error.code === CalDavErrorCode.Conflict) {
  // Someone changed it since it was read: read it again, merge, retry with the new etag.
}
```

What the client guarantees:

- **Credentials stay on the server.** `Authorization` goes only to the configured origin. A URL
  argument or a server href on another host, port or scheme is refused with `OutsideServer` before
  any request. Redirects are followed by hand: on the same origin up to `maxRedirects` (default 5),
  to another origin never, failing with `CrossOriginRedirect` and the target in `error.target`.
- **No blind writes.** `createObject` sends `If-None-Match: *` and names the object with a UUID,
  never the UID. `updateObject` and `deleteObject` need the etag, sent exactly as received, and
  without one are refused with `InvalidArgument` before any request. The etag must be one quoted
  entity tag: `*` or a list would match any version, so both are refused, and a server etag of
  that kind reads as `null`. A stale etag fails with
  `Conflict`, a code no other failure uses; a UID clash fails with `UidConflict`.
- **Failures are not empty lists.** A missing calendar is `NotFound`, never `[]`. Stalwart
  answers a `calendar-query` on an empty calendar, and on a calendar that does not exist, with 207
  and only the calendar's own entry at 404; `listObjects` then asks the calendar's `resourcetype`
  (`PROPFIND`, depth 0) and returns `[]` for a calendar, `NotFound` for anything else.
  `deleteCalendar` checks the collection is a calendar first, so it cannot delete the home.
- **Bounded.** One `timeoutMs` (default 30 s) covers a whole call; no body is read past
  `maxResponseBytes` (default 10 MiB).

Every method returns `{ success, output, error }` and never throws for a server or network failure.
In a browser, `fetch` hides redirect targets, so a redirect fails with `Server`.

## Reading a multistatus response

```ts
import {
  CALDAV_NS,
  calendarQueryBody,
  DAV_NS,
  getPropText,
  parseMultistatus,
} from "@spy4x/caldav/xml"
import { resolveHref } from "@spy4x/caldav/url"

const calendarUrl = "https://dav.example.com/dav/cal/user%40example.com/inbox/"
const response = await fetch(calendarUrl, {
  method: "REPORT",
  headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
  body: calendarQueryBody({ component: "VTODO" }),
})
const parsed = parseMultistatus(await response.text())
if (!parsed.success) throw new Error(parsed.error.message)

for (const item of parsed.output) {
  const url = resolveHref(item.href, calendarUrl) // `%40` and `%2F` kept as sent
  const etag = getPropText(item, DAV_NS, "getetag") // `"123"`, never `&quot;123&quot;`
  const ics = getPropText(item, CALDAV_NS, "calendar-data")
}
```

What the reader guarantees:

- **Namespaces, not prefixes.** Stalwart writes `D:` and `A:`, Radicale a default namespace; both
  resolve to the same `{ namespace, name }`.
- **Decoded text.** The five predefined entities, numeric references and CDATA are decoded, so an
  etag arrives as `"…"`. Line breaks are kept as sent, so `calendar-data` keeps its CRLF.
- **Per-propstat status.** Each `propstat` keeps its own status. `getProp` and `getPropText` read
  only 2xx propstats, so a property listed under a 404 propstat reads as missing.
- **Refuses what it should.** A `<!DOCTYPE`, any other entity, a document over `maxBytes` (default
  10 MiB) or nested deeper than `maxDepth` (default 64) is refused with an `XmlErrorCode`. The
  reader is one forward pass, so its time is linear in the input.

## Building requests

`propfindBody`, `calendarQueryBody`, `calendarMultigetBody`, `mkcalendarBody` and `proppatchBody`
return a complete XML document. Every value they write — a display name, an href, a component name
— is escaped, so a display name cannot inject an element.

## Keeping a local copy in step

`createCalDavSync(transport, store)` brings a device's copy of the calendars up to date. It has two
ports and no signals, wording or storage engine of its own:

- `CalDavSyncTransport` reaches the server: `listCalendars`, `listObjects` (bodies included) and,
  optionally, the pair `listVersions` + `getObjects` that lists only etags and fetches the bodies
  of the changed objects. A call reports `{ ok: false, offline }` instead of throwing; `offline`
  means no answer at all, and the run stops asking.
  `createClientTransport(client, { homeUrl, component })` builds one over a `CalDavClient`.
- `CalDavSyncStore` holds the copy: `listCalendars`, `listVersions(calendarHref)`,
  `replaceCalendars` and `applyChanges(calendar, { upsert, remove })`. The last two are atomic. A
  generic keyed cache with an index on the calendar can satisfy it.

`refresh()` lists the calendars, skips each one whose change marker equals the marker its stored
objects came from, and for the others writes only the objects whose etag is new or different (an
object without an etag always counts as different) and removes stored ones the server no longer
lists. A calendar the server no longer lists is dropped with its objects. Overlapping calls share
one run. `loadCompleted(href)` fetches one calendar with its completed tasks, which later refreshes
keep. Writes (PUT with `If-Match`, DELETE) are not part of it; they go through the client.

## URL rules

```ts
import { childUrl, isSameOrigin, resolveHref, sameResource } from "@spy4x/caldav/url"

const server = "https://dav.example.com/dav/"
sameResource(
  "https://dav.example.com/cal/user%40example.com/",
  "https://dav.example.com/cal/user@example.com",
) // true: segments are compared decoded, a trailing slash is ignored
sameResource("https://dav.example.com/a%2Fb", "https://dav.example.com/a/b") // false

const newTask = childUrl("https://dav.example.com/cal/inbox/", `${crypto.randomUUID()}.ics`)

// Attach credentials only to the configured origin, and check every redirect target too.
const target = resolveHref("https://elsewhere.example.org/cal/", server)
isSameOrigin(target!, server) // false: another host, port or scheme never gets the login
```

Never derive an address from a display name or from an event's iCalendar `URL` property: pass a
generated name to `childUrl` and resolve only hrefs the server sent.

## Offline writes

`caldav/write` fills the `send`, `fetchServer` and `classify` ports of the outbox in
`@spy4x/realtime/outbox`, so a queue of offline edits reaches a CalDAV server without overwriting
anyone's change. A create is `PUT` with `If-None-Match: *` to `<entityId>.ics` (a repeat after a
lost answer finds its own object, by its UID, and succeeds even if the server reordered the text);
an update is `PUT` with `If-Match: <etag>`; a delete is `DELETE` with `If-Match`. Only a create
needs the entity id to be a plain file name: an update or delete goes to the address `urlOf` gives.
The app supplies the calendar, the object's address, the etag a write is based on, the iCalendar
text, and how to turn an object into its entity.

| Server answer                                                                         | The queue sees                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 412 on an update or delete                                                            | `version`; the outbox then calls `fetchServer` |
| 412 on a create (address taken, different content)                                    | `already-exists`                               |
| 404 or 410 on an update                                                               | `not-found`                                    |
| 404 or 410 on a delete                                                                | success                                        |
| network error, timeout, 5xx, 401, 403, 408, 429                                       | `unreachable`: keep the entry, retry later     |
| other 4xx (not 401, 403, 408, 429), a UID clash, a bad entity id on a create, no etag | `rejected`, with the message                   |

```ts
const writer = createCalDavClient({ serverUrl, auth }) // or an adapter with the same results
const transport = createCalDavWriteTransport({
  writer,
  calendarUrl,
  urlOf,
  etagOf,
  toIcs,
  toEntity,
})
const outbox = createOutbox({ store, ...transport, lock, canSend })
```
