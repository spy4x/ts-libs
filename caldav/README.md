# `@spy4x/caldav`

CalDAV building blocks: a safe reader for WebDAV multistatus XML, request bodies that escape what
they write, and the URL rules a CalDAV client needs (resolving hrefs, comparing resources, sending
credentials only to the configured server). A CalDAV client built on them is planned.

| Module       | Exports                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caldav/xml` | `parseMultistatus`, `getProp`, `getPropText`, `parseXml`, `childElement`, `textContent`, `serializeXml`, `propfindBody`, `calendarQueryBody`, `calendarMultigetBody`, `mkcalendarBody`, `proppatchBody`, … |
| `caldav/url` | `resolveHref`, `sameResource`, `childUrl`, `isSameOrigin`                                                                                                                                                  |

## Install

```bash
deno add jsr:@spy4x/caldav
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

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
