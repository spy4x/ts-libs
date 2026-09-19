# `@ts-libs/caldav`

Dependency-free CalDAV/WebDAV primitives for Deno: an RFC 5545 builder and parser, WebDAV request
bodies as strings, a `fetch`-based client and a query engine that fans out over calendars.

Ported from `caldav-mcp/caldav/` (issue #13). Runtime dependencies: `@ts-libs/time/ics-core` and
nothing else. No XML library, no `ical.js`, no date library — the whole point of this package is that
a CalDAV client is a few hundred lines of string handling, and the interesting part is the interop
knowledge, not the parsing.

## Module map

| Module      | Exports                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`  | `Calendar`, `Todo`, `Event`, `RelatedTo`, `TodoQueryResult`, `EventQueryResult`, `CalDavResult`, `CalDavErrorCode`, `ok`/`fail`/`partial`                 |
| `ical.ts`   | `buildTodoIcal`, `buildEventIcal`, `parseIcal`, `parseTodos`, `parseEvents`, `toCalDavDate`, `toCalDavDateValue`, `fromCalDavDateValue`, `dueLine`        |
| `xml.ts`    | `propfindCalendars`, `propfindCalendarHomeSet`, `reportTodos`, `reportEvents`, `mkcalendar`, `proppatchCalendar`, `parseCalendarPropfind`, `extractEtags` |
| `client.ts` | `CalDavClient` — PROPFIND discovery, REPORT, GET, PUT with `If-Match`, DELETE, MKCALENDAR, PROPPATCH                                                      |
| `query.ts`  | `QueryEngine`, `aggregateTodos`, `aggregateEvents`, `filterByPriority`, `TODO_LIMIT`/`EVENT_LIMIT`                                                        |

`mod.ts` re-exports all of it. Import a subpath when you want one layer without the rest:
`@ts-libs/caldav/ical`, `@ts-libs/caldav/xml`, `@ts-libs/caldav/client`, `@ts-libs/caldav/query`.

## Shared ICS core

Line folding, unfolding and TEXT escaping are **not implemented here**. They live in
`@ts-libs/time/ics-core`, extracted by `#3`/`#26` for exactly this second consumer:

```ts
import {
  foldLine,
  formatIcsUtc,
  icsEscape,
  icsUnescape,
  joinContentLines,
  unfoldLines,
} from "@ts-libs/time/ics-core"
```

Names consumed by `ical.ts`: `foldLine`, `joinContentLines`, `unfoldLines`, `icsEscape`,
`icsUnescape`, `formatIcsUtc`, `CRLF`. Also available and _not_ used here: `icsEscapeParameter`,
`icsUnescapeParameter` (this layer does not write caller-supplied parameter values),
`stripControlCharacters`, `assertFoldable`, `FOLD_LIMIT`, `CONTINUATION_LIMIT`, `LF`.

The source's `foldLine` counted **characters** (`line.length`, `slice(i, i + 75)`) and its `unfold`
was a private copy. That character count is the bug the shared core fixes: a value whose UTF-8
encoding crosses the 75-octet boundary between two of its code points gets split mid-sequence and the
document becomes unreadable. `ical.test.ts` pins the delegation on both sides — the writer's folded
output must unfold back through `time/ics-core`'s `unfoldLines` to the literal value.

## Interop rules this encodes

These are the load-bearing bits; each one is a test, and each was a source bug.

- **Namespace prefixes do not matter.** `<D:response>`, `<d:response>`, `<A:response>` and
  `<response>` all parse, as do mismatched prefixes between the response and its children, an extra
  `xmlns` declaration, and a default `xmlns="DAV:"`. Radicale writes unprefixed children under a
  default namespace; Apple's CalendarServer writes `D:`/`C:`/`CS:`; SabreDAV writes lowercase. The
  source's response pattern was `/<(?:D:)?response>/i` in `client.ts` — hard-coded to one prefix, so a
  SabreDAV response parsed to zero calendars — while `query.ts` had the correct prefix-blind pattern
  under a second name. One implementation now.
- **An explicitly empty `supported-calendar-component-set` is trusted.** RFC 4791 §5.2.3 defines the
  property as the components the collection accepts; "none" is a legal answer. Substituting
  `[VEVENT, VTODO]` sends a REPORT to a collection that accepts neither. The default applies _only_
  when the property is absent, and that case is reported as a warning. Both the expanded and the
  self-closing empty forms are recognised.
- **One nested level at a time.** `<response>` contains `<propstat>` contains `<prop>` contains
  `<getetag>`; every pattern is non-greedy and anchored to its own element, because a capture that
  spanned siblings would return the first value for every entry — the failure mode
  `extractElementBlocks` is tested against.
- **A calendar is `<C:calendar/>` in `resourcetype`, not the substring `<calendar`.** The substring
  also matches `<CS:calendar-color>`, so the source reported a plain collection carrying only a colour
  as a calendar.
- **An absolute `href` path resolves against the base's origin**, not its path. `/remote.php/dav/...`
  from a server mounted on a subpath is a real shape, and appending it to the base's path produces a
  URL that does not exist.
- **`calendar-data` is XML-escaped iCalendar text.** `&amp;` must become `&` before the iCalendar
  parser runs, and `&#13;&#10;` must become CRLF. `decodeXmlEntities` handles named and numeric
  references; `CDATA` is _not_ unwrapped (see limitations).
- **`If-Match` must be echoed exactly**, weak marker and quotes included; the server's ETag is opaque.
- **A `STATUS` the RFC does not define is preserved.** `Todo.status` falls back to `NEEDS-ACTION` so
  the enum stays total, but `Todo.statusLabel` carries the wire value and the aggregator counts by it.
  The source mapped an unknown status to `NEEDS-ACTION`, reporting a cancelled task as open.

## Failure model

Every fallible operation returns the house envelope:

```ts
type CalDavResult<T> =
  | { success: true; output: T; warnings?: readonly string[] }
  | { success: false; error: CalDavError; output?: T }
```

The source had `catch { return { xml: "" } }`, so a transport failure, an auth failure and a calendar
holding no tasks all arrived as "no tasks". Here:

- a calendar whose REPORT fails is listed in `output.failures` with its error, while the other
  calendars' tasks are still returned;
- the envelope fails only when _every_ calendar failed — and still carries the partial aggregate;
- `getTodo`/`getEvent` return `ok(null)` for a genuine `404` and a `TRANSPORT`/`PARSE` failure for
  anything else;
- a malformed iCalendar document returns a `PARSE` failure rather than throwing out of the parser;
- a `DUE` that is present but unreadable is reported in `issues`, so it is not confused with a task
  that has no due date;
- a Radicale `/username/` fallback is reported in `warnings`, with the failure that triggered it.

## Injected transport and clock

`CalDavClient` takes everything it needs as options — `baseUrl`, `username`, `password`, `fetch`,
`now`. Nothing is read from `Deno.env` (the source's `client.ts` imported `../env.ts` at
module scope, which is why it was untestable) and nothing is read from the global `fetch`
unconditionally: the default is `(input, init) => fetch(input, init)`, so a test that passes a stub
never touches a socket and the suite runs under `deno test --allow-read --allow-env` with no
`--allow-net`.

`QueryEngine` takes `client` and `now`; `overdue` and `upcoming` are computed against the injected
instant, so no test depends on the host clock or the host `TZ`.

The credential itself is reachable through `client.authorizationHeader()` — a public accessor,
because the source's `QueryEngine` read `this.client["username"]` and `this.client["password"]`
through bracket syntax to build its own header.

## Out of scope

- **Recurrence.** No `RRULE`, `EXDATE`, `RDATE`, `RECURRENCE-ID`, and no expansion. A recurring
  event's first instance is all you get. This is the largest gap and the reason a task manager, not a
  scheduler, is the intended consumer.
- **`VTIMEZONE`/`TZID`.** Every `DATE-TIME` written is UTC (`Z`); a floating time read back stays
  floating. A `TZID` parameter is preserved in `IcalProperty.params` but not resolved.
- **`VALARM`, `DURATION`, `GEO`, `ATTACH`, `ORGANIZER`/`ATTENDEE` writing.** Read as properties, not
  modelled.
- **`VTODO`-specific CalDAV extensions** (`calendar-timezone`, `calendar-order`, `getctag` handling
  beyond reading it).
- **Tool bindings, MCP handlers and rate limiting.** Those are `#12`'s; this package is the protocol
  layer.
- **Paging.** `TODO_LIMIT`/`EVENT_LIMIT` are caps, not pages: there is no cursor, so a caller that
  hits one must narrow its filters.

### Known limitations inside the supported surface

- `parseIcal` keeps the **first** occurrence of a repeated property in `data`; every occurrence is
  available in `properties`. `RELATED-TO` is read from `properties`, so repeated edges survive.
- `CATEGORIES` items are trimmed after unescaping, so a category whose name is intentionally padded
  with spaces does not round-trip byte-exactly.
- `CDATA` is returned literally (`<![CDATA[…]]>` included), and `parseCalendarPropfind` does not
  entity-decode property text. Decoding it would require knowing whether a `calendar-data` payload
  must be decoded (it must) and other properties must not.
- The XML layer is regex-based. It handles nesting one level at a time and is not a conforming XML
  parser: a value containing a literal `</response>` would confuse it. Servers escape those.
- `DTEND` is required when writing an event; only the reader falls back to `DTSTART`.
- `makeCalendar` derives the collection URL from the display name, which RFC 4791 §5.3.1 lets a
  server reject with `403`; the failure is returned, not worked around.
- `PRODID` defaults to `-//ts-libs//caldav//EN` and is overridable, where the source hard-coded it.
