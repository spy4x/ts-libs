# `@ts-libs/time`

Time primitives with no application domain attached. Today that is one module:
[`tz.ts`](./tz.ts) — IANA timezone math on `Intl`, zero runtime dependencies.

```ts
import { formatDateTimeLong, validTimeZoneOr, zonedDateTime } from "@ts-libs/time/tz"

// A stored booking: a wall clock, the zone it was made in, the guest's zone.
const instant = zonedDateTime("2026-08-28", "10:00", "Europe/Berlin")
formatDateTimeLong("2026-08-28", "10:00", "Europe/Berlin") // "Friday, 28 August 2026 at 10:00"
```

## Why `Intl` and not a date library

Everything here is built on `Intl.DateTimeFormat`. Three consequences:

- **Zero dependencies, zero bundled tzdata.** `Intl` reads the runtime's own
  tzdata, which is already installed, already patched when a government changes
  its rules, and already correct for historical dates. The alternatives —
  `date-fns-tz`, Luxon, a Temporal polyfill — each carry a copy of the tz
  database and a release cadence to match. This module retires that dependency
  class rather than adding to it.
- **Locale comes for free.** The formatters are locale data, not string
  assembly, so the same code produces `"Friday, 28 August 2026 at 10:00"` in
  `en-GB` and `"Freitag, 28. August 2026 um 10:00"` in `de-DE`. One locale tag
  is fixed inside each formatter today; making it a parameter is the whole
  change needed for localisation, and it needs no new dependency.
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

## Not in scope

- **Parsing.** Input is `YYYY-MM-DD` and `HH:MM`, and anything else throws a
  `RangeError`. No ISO-8601 parser, no relative-date parser, no clock library.
- **Durations and arithmetic in the host zone.** `addDays` moves a calendar
  date. Elapsed-time math belongs on epoch milliseconds where no zone can
  interfere.
- **Recurrence rules (RRULE), calendars, iCal or CalDAV.** Those are separate
  packages; day-of-week and day-addition are the only pieces they need from here.
- **Sub-minute offsets.** `tzOffsetMinutes` is minute resolution, so historical
  LMT offsets (which carry seconds) are truncated. A scheduling library does not
  need them.
- **Validation of anything but a zone name.** `isValidTimeZone` answers whether
  the runtime knows the zone; it does not check that a date and time exist.
- **Localisation of the locale.** The locale tag is fixed to `"en-GB"` inside
  each formatter. `Intl` makes changing it trivial; no API exposes it yet
  because nothing consumes a second locale.
- **`Date` objects as the public currency for wall clocks.** They cannot
  represent one, which is the whole point.
