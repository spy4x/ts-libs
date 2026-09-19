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
`@ts-libs/caldav/types`, `@ts-libs/caldav/ical`, `@ts-libs/caldav/xml`, `@ts-libs/caldav/client`,
`@ts-libs/caldav/query`.

## Shared ICS core

Line folding, unfolding and TEXT escaping are **not implemented here**. They live in
`@ts-libs/time/ics-core`, extracted by `#3`/`#26` for exactly this second consumer:

```ts
import {
  formatIcsUtc,
  icsEscape,
  icsUnescape,
  joinContentLines,
  unfoldLines,
} from "@ts-libs/time/ics-core"
```

Five names, exactly as imported above: `formatIcsUtc`, `icsEscape`, `icsUnescape`,
`joinContentLines` (which folds every line through `foldLine` internally), `unfoldLines`.

Available and _not_ used by `caldav/`: `foldLine` (reached through `joinContentLines`),
`icsEscapeParameter` / `icsUnescapeParameter` (this layer writes no caller-supplied parameter values),
`stripControlCharacters`, `assertFoldable`, `CRLF`, `CONTINUATION_LIMIT`, `LF`. `FOLD_LIMIT` is not
imported by `caldav/` sources but **is** imported by `ical.test.ts`, which asserts the writer's output
against it instead of against a repeated literal `75`.

The source's `foldLine` counted **characters** (`line.length <= 75`, `slice(i, i + 75)`) and its
`unfold` was a private copy. That character count is the bug the shared core fixes: a value whose UTF-8
encoding crosses the 75-octet boundary between two of its code points gets split mid-sequence and the
document becomes unreadable. `ical.test.ts` pins the delegation on both sides — the writer's folded
output must unfold back through `time/ics-core`'s `unfoldLines` to the literal value.

## Interop rules this encodes

These are the load-bearing bits; each one is a test, and each was a source bug.

- **Namespace prefixes do not matter.** `<D:response>`, `<d:response>`, `<A:response>` and
  `<response>` all parse, as do mismatched prefixes between the response and its children, an extra
  `xmlns` declaration, and a default `xmlns="DAV:"`. Radicale writes unprefixed children under a
  default namespace; Apple's CalendarServer writes `D:`/`C:`/`CS:`. The source's response pattern was
  `/<(?:D:)?response>/i` in `client.ts` — hard-coded to the single prefix `D:` — while `query.ts` had
  the correct prefix-blind pattern under a second name. One implementation now. The narrowing was
  measured on the source: lowercase `d:` and an unprefixed `<response>` both parsed (the `i` flag and
  the optional group save them), so only a **non-`D` prefix** such as `<A:response>` broke.
- **A response's status comes from the group that answers for the property.** A `<response>` carries
  one `<propstat>` per status group, and the groups arrive in any order: a server that does not
  implement `CS:getctag` answers `404` for that property and `200` for the rest. The status is taken
  from the `<response>`-level `<status>` when present, otherwise from the `<propstat>` whose `<prop>`
  carries the property the caller asked for — never from the first `<status>` in the block, which is a
  sibling group's answer and made `listCalendars()` report an empty account.
- **An explicitly empty `supported-calendar-component-set` is trusted.** RFC 4791 §5.2.3 defines the
  property as the components the collection accepts; "none" is a legal answer. Substituting
  `[VEVENT, VTODO]` sends a REPORT to a collection that accepts neither. The default applies _only_
  when the property is absent, and that case is reported as a warning. Both the expanded and the
  self-closing empty forms are recognised.
- **One nested level at a time.** `<response>` contains `<propstat>` contains `<prop>` contains
  `<getetag>`; every pattern is non-greedy and anchored to its own element, because a capture that
  spanned siblings would return the first value for every entry — the failure mode
  `extractElementBlocks` is tested against.
- **A calendar is a `<calendar>` element in `resourcetype`, not the substring `<calendar`.** The
  loose form — `/<[^>]*\bcalendar\b[^>]*\/?>/i` against the resourcetype's inner XML — matches any
  `calendar-*` element written inside `<resourcetype>`: `calendar-color` prefixed or unprefixed
  (`\b` holds between `<` and `c`, so the prefix is irrelevant), `calendar-description`,
  `calendar-home-set`. Such a collection was reported as a calendar. The match is now on the element
  name, which also stops it matching the tail of `supported-calendar-component-set`.
- **An absolute `href` path resolves against the base's origin**, not its path. `/remote.php/dav/...`
  from a server mounted on a subpath is a real shape, and appending it to the base's path produces a
  URL that does not exist.
- **`calendar-data` is XML-escaped iCalendar text.** `&amp;` must become `&` before the iCalendar
  parser runs, and `&#13;&#10;` must become CRLF. `decodeXmlEntities` handles named and numeric
  references; `CDATA` is _not_ unwrapped (see limitations).
- **Entity decoding is total and is bounded by the XML 1.0 `Char` production.** It never throws and
  never returns a code point that is not an XML 1.0 `Char`: `&#x110000;` (above `#x10FFFF`),
  `&#xD800;` (a surrogate), `&#xFFFF;` (a non-character), `&#x0;`, `&#x8;`, `&#x7F;` all become
  `U+FFFD`, and so does an unpaired surrogate sitting in the payload with no reference at all. This
  is the one place substitution is used rather than removal — a decoded payload is a _report_ of what
  the server sent, so a corrupt byte becomes a visible `U+FFFD` instead of vanishing. `escapeXml`, on
  the request-writing side, **removes** what it cannot write, except for an unpaired surrogate, which
  it also replaces.
- **Credentials go only to the origin the caller configured.** A server-named `calendar-home-set` is
  resolved and then checked against `baseUrl`'s `scheme://host:port`; a cross-origin value is refused
  with a warning and the `/username/` convention is used in its place, exactly as for a missing home
  set. It is not followed with the header stripped: a request an attacker still gets to answer is not
  a safe outcome. The check covers absolute URLs, protocol-relative `//host/path`, and a same-host URL
  on another port. This bounds what a _server_ can redirect a credential to; it does not vet the
  `baseUrl` a caller chose, and a consumer that takes a server URL from an untrusted user should vet
  it with `validatePublicUrl` from `@ts-libs/net/url-policy`.
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

That accessor is why the origin rule lives in the client rather than in a caller: every request the
client builds takes its `Authorization` from the same place, so the rule "credentials only ever go to
the configured origin" is enforceable at one point. A cross-origin `calendar-home-set` is refused
with a warning and the `/username/` fallback is used, which keeps the second PROPFIND on the
configured origin; a caller that passes a foreign `calendarUrl` to `queryTodos` is sending its own
credential somewhere it chose, which is not this rule's business.

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
- **`makeCalendar` reports a `207` whose only `propstat` is a `403` as success.** The transport layer
  sees `response.ok` and does not parse the MKCALENDAR body, and the body is a `multistatus` on some
  servers and absent on others (RFC 4791 §5.3.1 specifies `201`), so the collection URL it returns is
  a _request_, not an observation. Pinned by a test so a future change to the `207` handling is a
  deliberate one; honouring the refusal would mean parsing that body and treating its absence as an
  answer, which is a different contract.
- `PRODID` defaults to `-//ts-libs//caldav//EN` and is overridable, where the source hard-coded it.
