# `@spy4x/time`

Time and calendar primitives with no application domain attached. IANA timezone math on `Intl`,
plus an RFC 5545 iCalendar writer. Zero runtime dependencies.

| Module          | Exports                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `time/date`     | Zone-free arithmetic on `YYYY-MM-DD`: `parseIsoDate`, `formatIsoDate`, `shiftMonth`, `startOfMonth`, `endOfMonth`, `daysInMonth`, `dayInMonth`, `monthFirstWeekday`, quarter and year bounds, `isSameDay`, `isValidDateRange`, `DateRange` |
| `time/locale`   | Calendar labels from `Intl`: `localeFirstWeekday`, `monthLabel`, `dayLabel`, `weekdayLabels`, `WeekdayLabel`                                                                                                                               |
| `time/tz`       | IANA zone helpers: `zonedDateTime`, `resolveWallClock`, `formatInstantLong`, `addDays` (zone optional), …                                                                                                                                  |
| `time/ics`      | `generateIcs(event, options)` — RFC 5545 VCALENDAR/VEVENT writer                                                                                                                                                                           |
| `time/ics-core` | RFC 5545 wire primitives: `foldLine`, `unfoldLines`, `icsEscape`, …                                                                                                                                                                        |

```ts
import { formatDateTimeLong, zonedDateTime } from "@spy4x/time/tz"

// A stored booking: a wall clock, the zone it was made in, the guest's zone.
const instant = zonedDateTime("2026-08-28", "10:00", "Europe/Berlin")
formatDateTimeLong("2026-08-28", "10:00", "Europe/Berlin") // "Friday, 28 August 2026 at 10:00"
```

```ts
import { generateIcs, IcsEventStatus } from "@spy4x/time/ics"
import { zonedDateTime } from "@spy4x/time/tz"

const start = zonedDateTime("2026-08-28", "10:00", "Europe/Berlin")
const ics = generateIcs(
  {
    uid: "01HXYZBK8M@calendar.example.com",
    start,
    end: new Date(start.getTime() + 30 * 60_000),
    summary: "Meeting with Jane Doe",
    organizer: { email: "jane@example.com", name: "Jane Doe" },
    attendees: [{ email: "client@example.com", name: "Client", rsvp: true }],
  },
  { prodid: "-//example.com//booking//EN", dtstamp: new Date() },
)
```

```ts
import { endOfQuarter, startOfQuarter } from "@spy4x/time/date"
import { addDays, isoDateInTz } from "@spy4x/time/tz"

// "This quarter" for a user in Tokyo, the same on a server as in their browser.
const today = isoDateInTz(new Date(), "Asia/Tokyo")
const range = { from: startOfQuarter(today), to: endOfQuarter(today) }
addDays(today, -6) // the first day of "the last 7 days", no zone needed
```

## Install

```bash
deno add jsr:@spy4x/time
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## Plain dates and zones

`time/date` does arithmetic on a calendar date and never asks which zone it is in: a `YYYY-MM-DD`
string has none, so adding a day or finding the end of a quarter is fixed-step UTC maths that no DST
change can move. The only zone-aware step is deciding which date "today" is, and that is
`isoDateInTz` in `time/tz`. Every function rejects a date the calendar does not have
(`2026-02-31`) instead of rolling it into March, and throws past `9999-12-31` instead of answering a
six-digit year.

`addDays` is one function with an optional zone rather than two functions. Without a zone it is the
`time/date` day step. With a zone it moves the date as that zone's calendar does, which differs only
where a zone skipped a whole day: `Pacific/Apia` has no `2011-12-30`, so `addDays("2011-12-29", 1,
"Pacific/Apia")` is `2011-12-31`, and `addDays("2011-12-29", 1)` is `2011-12-30`.

`@spy4x/platform`'s `normalizeCalendarDate` is not a second copy of `parseIsoDate`: it also accepts
`YYYY.MM.DD` and returns the normalised string or `null`, where `parseIsoDate` accepts only
`YYYY-MM-DD`, returns midnight UTC in milliseconds and throws.

## Why `Intl` and not a date library

Everything in `time/tz` is built on `Intl.DateTimeFormat`, not `Temporal`.
`Temporal` is newer, has a cleaner API, and is already built into Deno (2.9.7
needs no flag) — but this module is meant to run in browsers too, and browser
support for `Temporal` is not yet reliable enough to depend on. `Intl` is what
every target runtime already has. Revisit this once `Temporal` is broadly
available in browsers; until then, `Intl` stays.

Three more consequences of the `Intl` choice:

- **Zero dependencies, zero bundled tzdata.** `Intl` reads the runtime's own
  tzdata, which is already installed, already patched when a government changes
  its rules, and already correct for historical dates outside the fractional-
  minute LMT era (see [Not in scope](#not-in-scope)). The alternatives —
  `date-fns-tz`, Luxon — each carry a copy of the tz database and a release
  cadence to match. This module retires that dependency class rather than
  adding to it.
- **A display-locale parameter is genuinely safe to add, because two other
  formatters can never see it.** The display formatters (`formatDateTimeLong`
  and friends, including `isoDateInTz`/`hhmmInTz`) are built on locale data,
  not string assembly, so the same code could produce
  `"Friday, 28 August 2026 at 10:00"` in `en-GB` and
  `"Freitag, 28. August 2026 um 10:00"` in `de-DE` if a locale parameter were
  added — the locale tag is fixed inside each formatter today because nothing
  yet consumes a second one, not because it would be hard to add. Two
  computations must never see that parameter, because they turn `Intl`'s
  output back into data instead of displaying it, and `Intl` renders both
  differently per locale: the UTC offset `zonedDateTime` derives its instant
  from (`en-GB` renders `Asia/Kolkata`'s offset as `"GMT+5:30"`, `fr-FR` as
  `"UTC+5:30"`, `ar-EG` with Arabic-indic digits — an unread offset silently
  becomes zero), and the wall clock `zonedDateTime` screens its candidates
  against (the same digit substitution would apply to a year, month, day,
  hour and minute compared as ASCII text). Both live in their own formatters
  — `time/tz.ts`'s `offsetFormatter` and `canonicalWallClockFormatter`, both
  pinned to `en-GB` — outside the option-set table `formatDateTimeLong` and
  `isoDateInTz`/`hhmmInTz` share, so a locale parameter added to that table
  cannot reach either one. Verified by forcing `zonedFormatter`'s own locale
  to `ar-EG`: `zonedDateTime` keeps resolving every case in its test suite
  correctly, because it depends on neither `zonedFormatter` nor the display
  functions built on it.
- **Determinism is the caller's job, and here it is enforced.** The runtime's
  tzdata is the ICU build, not the host. Every function takes an explicit IANA
  zone and none of them read the host `TZ` or the host clock, so the suite
  produces identical results on a laptop in Asia/Bangkok and in a UTC CI
  container. The only two functions that read the clock are `todayInTz`, and
  `isoDateInTz`/`hhmmInTz` when given a `Date` the caller made.

Cost: output text is ICU's, not yours. A different ICU version can change a
separator or an abbreviation. Where that matters, the tests pin the exact string
— `formatInstantLong` asserting `" at "` is a pinned contract, not decoration.

## Two things that are not the same thing

Most timezone bugs are one of these being used as the other.

**A wall clock in `tz`** is a `YYYY-MM-DD` plus `HH:MM` that a human in that zone
reads off a calendar and a clock face: `"2026-08-28"` `"10:00"` in
`Europe/Berlin`. It is _not_ an instant until a zone is attached to it — the same
pair means a different moment in every zone, and there is no tzdata-independent
answer. `zonedDateTime(date, time, tz)` attaches the zone and returns the UTC
`Date`. All the formatters that take a `date` + `time` + `tz` triple are built on
it, and `addDays`, `dayOfWeek`, `formatDateLong` anchor at noon for the same
reason.

**An instant** is a `Date`: one unambiguous point on the timeline, no zone
attached. `formatInstantLong` / `formatInstantShort` render an instant _as_ a
particular zone — the guest's, the host's, the recipient's. The rendering is a
display choice and the instant is unchanged by it. `isoDateInTz` and `hhmmInTz`
are the raw pieces of that rendering when you need the value rather than a
sentence.

So: `zonedDateTime` goes wall clock → instant. `formatInstant*` goes instant →
wall clock. `formatDateTimeLong` composes both and is a no-op round trip, which
is exactly what makes it a good assertion in a test.

## DST anchoring

Two functions depend on an anchor, and both would be subtly wrong without it.

**`addDays` anchors at noon**, and that anchoring _is_ the DST fix. Calendar days
are not 86,400 seconds: on a transition day a day is 23 or 25 hours long.
Adding `n * 86_400_000` to a local midnight crosses the transition and lands an
hour into the wrong day — Berlin's `2026-03-28 00:00` is 23:00Z on the 27th, and
`+ 86_400_000` from there is 01:00 on the 29th, so the 29th gets skipped
entirely. Anchoring at local noon and moving the _UTC_ date by `n` stays within
12 hours of the transition in either direction, so the resulting instant is
always inside the intended local day, and re-reading that day in `tz` yields the
neighbouring calendar date. Midday is the anchor because no populated zone
transitions at noon, so no date arithmetic can land in a gap. The tests cover
both directions — forward over the spring transition and backward over the
fall-back transition — because the bug is directional and a test that only
walks one way passes with the anchor removed.

**`dayOfWeek`, `formatDateLong` anchor at noon** for the same reason, one step
weaker. Nothing transitions at noon, so a date-only conversion anchored there
has twelve hours of margin on either side and can never land in a gap; anchored
at `00:00` it would be inside the gap for a zone that jumps at or near midnight.
`America/Santiago` does: its `2026-09-06 00:00` does not exist, and a
date-anchored conversion there reports `01:00`.

**`zonedDateTime` has no anchor, because a booking time cannot be moved.** It
resolves the requested wall clock by screening candidates rather than shifting
to a safe hour. Where the wall clock is ambiguous or nonexistent, the convention
is explicit and tested:

| Case                                        | Example                   | Result                                              |
| ------------------------------------------- | ------------------------- | --------------------------------------------------- |
| Fall-back overlap, wall clock occurs twice  | Berlin `2026-10-25 02:30` | earlier instant, `00:30Z` (CEST)                    |
| Spring-forward gap, wall clock never occurs | Berlin `2026-03-29 02:30` | shifted forward by the gap, `01:30Z`, reads `03:30` |
| Ordinary wall clock                         | Berlin `2026-08-28 10:00` | the only instant reading it, `08:00Z`               |

That is Temporal's `"compatible"` disambiguation in both branch cases. It is
also the fix for the source's single-pass conversion, which read the zone offset
at the wall clock treated as UTC — an instant one whole offset away from the
answer — and was an hour late or early for the weeks around a transition. See
the PR body for the file and line of each such defect.

**`resolveWallClock` says which case applies.** A caller that must know whether
a wall clock is skipped or repeated — a booking page hiding slots in the gap, a
range picker offering both occurrences of a repeated hour — asks
`resolveWallClock(date, time, tz)`. It shares `zonedDateTime`'s candidate
screening, so its `instant` is always `zonedDateTime`'s answer and its errors
are the same `RangeError`s:

```ts
import { resolveWallClock, WallClockKind } from "@spy4x/time/tz"

resolveWallClock("2026-10-25", "02:30", "Europe/Berlin")
// { kind: WallClockKind.Overlap, instant: 00:30Z, later: 01:30Z }
resolveWallClock("2026-03-29", "02:30", "Europe/Berlin")
// { kind: WallClockKind.Gap, instant: 01:30Z } — the shifted-forward instant only
```

`Gap` means a forward clock change skipped the wall clock, and `Overlap` means a
backward clock change repeats it. The change need not be daylight saving: Apia
skipped 2011-12-30 and Kwajalein 1993-08-21 by changing their standard offset.
A gap carries only the shifted-forward instant; a caller who wants the reading
before the change subtracts the gap itself.

`zonedDateTime` also rejects a `date` + `time` that does not exist on the
Gregorian calendar — `"2026-02-30"`, `"2026-13-01"`, `"25:00"`, and a year
`Date.UTC` would fold into 19xx (`"0099"` becomes 1999) all throw a
`RangeError` rather than silently landing on the nearest date `Date.UTC`
happens to roll over into. It separately rejects a historical wall clock whose
zone offset is not aligned to a whole minute (`Africa/Monrovia` before 1972,
for example): this module is minute resolution only, so such a request is
refused rather than answered up to a minute wrong.

## Timezone contract

`generateIcs` takes **absolute instants** (`Date`) and always writes UTC
(`DTSTART:20260828T080000Z`), never a local wall clock and never a `TZID`. It does not import
`time/tz.ts` and never reads the host `TZ`.

Converting a wall-clock date + time + IANA zone into an instant is the caller's one line:
`zonedDateTime("2026-08-28", "10:00", "Europe/Berlin")`. Keeping that out of the writer is what
makes the writer dependency-free and testable — UTC output is an absolute instant, so every client
renders it in the viewer's own zone anyway, and there is no `VTIMEZONE` component to get wrong.

Because `dtstamp` is a required option rather than `new Date()` read internally, two calls with the
same arguments produce byte-identical documents.

**The trap is on the caller's side, not in this API.** `start` and `end` must be `Date` objects — a
string throws (`TypeError: event.start.getTime is not a function`), so nothing is silently converted
for you. What _is_ silent is how you make that `Date`: `new Date("2026-08-28T10:00:00")` — no offset —
is parsed by JavaScript as **host-local**, so the same call means different instants on a laptop and
in CI. Always name the zone explicitly, with `zonedDateTime(date, time, zone)` from `time/tz` or a
`Z`-suffixed ISO string:

```ts
// Wrong: host-local, differs per machine.
generateIcs({ ...event, start: new Date("2026-08-28T10:00:00") }, options)
// Right: the wall clock is tied to a zone, or the instant is given outright.
generateIcs({ ...event, start: zonedDateTime("2026-08-28", "10:00", "Europe/Berlin") }, options)
```

```ts
generateIcs(event, { prodid, dtstamp })
```

## Not in scope

**Across the package.** Inputs are typed values, and anything outside the type throws rather than
being coerced: `generateIcs` rejects a non-`Date` instant, a missing `uid`, a `sequence` that is not
a non-negative integer and an empty mail address. There is no silent conversion anywhere in `time/`.

**`time/ics` — calendar features.** Not implemented, and not planned here. Do not assume otherwise:

- **No recurrence.** No `RRULE`, no `EXDATE`, no `RDATE`, no `RECURRENCE-ID`. One VEVENT, one
  occurrence.
- **No `VTIMEZONE` and no `TZID`.** All times are UTC with a `Z` suffix.
- **No alarms and no explicit duration.** No `VALARM`, no `DURATION` (`DTEND` is always written).
- **No other components.** No VTODO, no VJOURNAL, no VFREEBUSY, no multiple VEVENTs in one
  VCALENDAR.
- **No parsing of a calendar.** The writer is write-only, and no ISO-8601 or relative-date parser
  feeds it. A calendar client (`caldav/`) used to read one; it was removed from ts-libs (#63).
- **No CalDAV wire concerns.** `RELATED-TO`, `ETag`/`If-Match` and HTTP transport are not this
  package's job.
- **No product domain.** No bookings, hosts, guests, availability, rate limits or cancel tokens —
  callers map their own types onto `IcsEvent`. `meetingSummary()` and the `Booking`/`Config`
  coupling from the source are deliberately not ported; a human-readable summary of an instant is
  `formatInstantLong(start, zone)` from `time/tz`, not a calendar concern.

**`time/tz` — timezone features.**

- **Durations and arithmetic in the host zone.** `addDays` moves a calendar date. Elapsed-time math
  belongs on epoch milliseconds where no zone can interfere.
- **Sub-minute offsets.** `tzOffsetMinutes` is minute resolution, so historical LMT offsets (which
  carry seconds) are not resolved to the minute; `zonedDateTime` rejects a wall clock that would need
  one rather than answering up to a minute wrong. A scheduling library does not need them.
- **Validation of anything but a zone name.** `isValidTimeZone` answers whether the runtime knows the
  zone; it does not check that a date and time exist — that is `zonedDateTime`'s own, separate check.
- **Localisation of the display locale, never the two formatters `zonedDateTime` reads back as
  data.** The display formatters' locale tag — including `isoDateInTz`'s and `hhmmInTz`'s — is
  fixed to `"en-GB"` today, and adding a parameter is genuinely straightforward: `zonedDateTime`
  does not call either of them. It reads its own offset formatter and its own wall-clock
  formatter, both pinned to `en-GB` permanently and on purpose, because parsing `Intl`'s output
  back into data only works for the one locale the parser was written against — see
  [Why `Intl` and not a date library](#why-intl-and-not-a-date-library).
- **`Date` objects as the public currency for wall clocks.** They cannot represent one, which is the
  whole point.

## Design notes

### `ics-core` is its own module

`time/ics-core.ts` holds the byte-level RFC 5545 primitives: 75-octet folding, unfolding, TEXT
escaping, RFC 6868 parameter escaping, control-character stripping and the UTC DATE-TIME format.
`time/ics.ts` builds VCALENDAR/VEVENT on top of it. The split originally let the removed `caldav/`
package (#13) import the same module instead of carrying a third copy; `caldav/` is gone (#63), but
`time/ics.ts` still needs the split, so `ics-core.ts` stays. `caldav-mcp`'s `ical.ts` — a separate
repo, not part of this library — slices folded lines by character (`ical.ts:10-19`), which splits
multi-byte UTF-8; `ics-core.ts` does not.

### Folding

`foldLine` folds at 75 **octets** _excluding_ the CRLF line break, counting the one-octet
continuation space toward the limit (so continuation lines carry at most 74 octets of content). It
iterates by code point and measures each with `TextEncoder`, so a multi-byte sequence is never split.
`String.prototype.length` is never consulted: 25 CJK code points are 25 characters but 75 octets.

Control characters are stripped before escaping; `HTAB` is the one C0 character kept in a TEXT
value, and a mail address is stripped harder (no C0 at all) because it sits in the property _value_
position where no escaping helper applies.

## Tests

```bash
deno test time/
```

Colocated `*.test.ts`, deterministic: explicit UTC instants, explicit `dtstamp`, explicit IANA
zones, no reliance on the host clock or `TZ`.
