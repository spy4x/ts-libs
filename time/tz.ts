/**
 * IANA timezone math on `Intl` — the platform's own tzdata, zero dependencies.
 *
 * Two different questions live in this module and conflating them is the usual
 * source of off-by-one-hour bugs:
 *
 * - a **wall clock in `tz`** — a `YYYY-MM-DD` + `HH:MM` pair as a human in that
 *   zone reads it (a booking time). This is not an instant on its own; it
 *   becomes one only once `tz` is attached. `zonedDateTime` converts it.
 * - an **instant** — a `Date`, one unambiguous point in UTC. Formatting an
 *   instant in a foreign `tz` (a guest's timezone, an email footer) is what the
 *   `*InTz` and `formatInstant*` functions do.
 *
 * Every function takes an explicit IANA zone. Nothing here reads the host `TZ`,
 * so results are identical on every machine and in every CI container.
 *
 * Locale comes for free: the formatters are `Intl`-based, so the only thing
 * that pins a language is the hard-coded `"en-GB"` tag below.
 *
 * Out of scope: date parsing, durations, recurring rules, `Date` arithmetic in
 * the host zone, and anything that needs sub-minute offset precision.
 */

/**
 * The `Intl` option sets this module uses, without the zone. Frozen so a caller
 * cannot mutate a shared option object, and named so each one appears once.
 *
 * `hourCycle: "h23"` is load-bearing wherever an hour is rendered: the `Intl`
 * default for a "24-hour" format is locale-dependent, `h23` counts `00:00`–`23:59`
 * while `h24` counts `01:00`–`24:00` and renders midnight as `"24:00"` — the same
 * day, one day later, to any reader. The `en-GB`/`en-US` data installed in Deno
 * today resolves to `h23`, but that is a locale-data accident: `h24` is one ICU
 * update away, and `hour12: false` is defined to mean "not 12-hour", not `h23`.
 */
const optionSets = {
  longDateTime: {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
  longDate: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  timeOfDay: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  shortDateTime: {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
  isoDate: { year: "numeric", month: "2-digit", day: "2-digit" },
  shortWeekday: { weekday: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>

type OptionSetName = keyof typeof optionSets

const formatterCache = new Map<string, Intl.DateTimeFormat>()

/**
 * A formatter for one option set and one zone, built once per process.
 *
 * `Intl.DateTimeFormat` construction costs tens of microseconds, this module
 * builds one per formatted booking, and the option sets are a small fixed list.
 *
 * Both halves belong in the cache key. A key that names only the option set —
 * the obvious first draft — hands the Berlin formatter to a Los Angeles call and
 * returns a confidently wrong answer for the rest of the process. The zone is
 * interpolated last and zones contain no `:` beyond a single `/`, so
 * `set:zone` cannot collide.
 *
 * The cache is process-local and the values are pure: a formatter holds no
 * mutable state and `format` never reads the host zone or clock, so this cannot
 * change a result, only how long it takes to get one.
 */
function zonedFormatter(set: OptionSetName, tz: string): Intl.DateTimeFormat {
  const key = `${set}:${tz}`
  const cached = formatterCache.get(key)
  if (cached) return cached

  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...optionSets[set] })
  formatterCache.set(key, formatter)
  return formatter
}

/**
 * Pull a named part out of a `formatToParts` result.
 *
 * Throws on a missing part rather than defaulting to `"0"`: an absent part means
 * the options and the parse disagree, and a silent `"00:00"` would be a wrong
 * answer that looks like a valid one.
 */
function requiredPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const part = parts.find((candidate) => candidate.type === type)
  if (!part) throw new Error(`Intl did not produce a "${type}" part`)
  return part.value
}

/** True when `tz` is a zone this runtime's tzdata knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * `tz` when it is a real IANA zone, `fallback` otherwise.
 *
 * Use this at every boundary where a zone arrives from user input or from a
 * stored record — a stored `"Not/A_Timezone"` must not reach `Intl`, which
 * throws a `RangeError` and takes the whole request down.
 */
export function validTimeZoneOr(tz: string | undefined, fallback: string): string {
  return tz && isValidTimeZone(tz) ? tz : fallback
}

/**
 * Format the wall clock `date` + `time` in `tz` as a long human string.
 *
 * Example: `formatDateTimeLong("2026-08-28", "10:00", "Europe/Berlin")` is
 * `"Friday, 28 August 2026 at 10:00"`. The separator is `" at "` — verified
 * against the `en-GB` locale data in the test suite, not assumed.
 */
export function formatDateTimeLong(date: string, time: string, tz: string): string {
  return formatInstantLong(zonedDateTime(date, time, tz), tz)
}

/** Format an instant in `tz` as a long human string: `"Friday, 28 August 2026 at 04:00"`. */
export function formatInstantLong(instant: Date, tz: string): string {
  return zonedFormatter("longDateTime", tz).format(instant)
}

/** Format a date as `"Friday, 28 August 2026"` — the date-only row of a confirmation view. */
export function formatDateLong(date: string, tz: string): string {
  return zonedFormatter("longDate", tz).format(zonedDateTime(date, "12:00", tz))
}

/**
 * Format a wall clock as 24-hour time-of-day, `"11:00"`.
 *
 * Midnight is `"00:00"`, never `"24:00"` — see the `hourCycle` note in
 * {@link hhmmInTz}.
 */
export function formatTimeOfDay(date: string, time: string, tz: string): string {
  return zonedFormatter("timeOfDay", tz).format(zonedDateTime(date, time, tz))
}

/** Compact form for email subjects and buttons: `"Fri 28 Aug 04:00"`. */
export function formatDateTimeShort(date: string, time: string, tz: string): string {
  return formatInstantShort(zonedDateTime(date, time, tz), tz)
}

/**
 * Compact form of an instant in `tz`: `"Fri 28 Aug 04:00"`.
 *
 * `Intl` emits `"Fri, 28 Aug, 04:00"`; the comma after the weekday is dropped
 * so the string reads as one phrase. Only that first comma is touched — a
 * locale that also separates the time with a comma is preserved.
 */
export function formatInstantShort(instant: Date, tz: string): string {
  const formatted = zonedFormatter("shortDateTime", tz).format(instant)
  return formatted.replace(/^([^,]+),/, "$1")
}

/** `YYYY-MM-DD` for today in `tz`. */
export function todayInTz(tz: string): string {
  return isoDateInTz(new Date(), tz)
}

/** `YYYY-MM-DD` as `tz` reads the instant `instant`. */
export function isoDateInTz(instant: Date, tz: string): string {
  const parts = zonedFormatter("isoDate", tz).formatToParts(instant)

  const year = requiredPart(parts, "year")
  const month = requiredPart(parts, "month")
  const day = requiredPart(parts, "day")
  return `${year}-${month}-${day}`
}

/**
 * `HH:MM` as `tz` reads the instant `instant`.
 *
 * `hourCycle: "h23"` is load-bearing here, see the note on {@link optionSets}.
 */
export function hhmmInTz(instant: Date, tz: string): string {
  const parts = zonedFormatter("timeOfDay", tz).formatToParts(instant)

  const hour = requiredPart(parts, "hour")
  const minute = requiredPart(parts, "minute")
  return `${hour}:${minute}`
}

/**
 * The instant at which `tz`'s wall clock reads `date` + `time`.
 *
 * The conversion must obey one invariant: the result, read back in `tz`, shows
 * the requested wall clock. Getting that wrong is invisible for most of the
 * year and off by an hour for the weeks around a DST transition.
 *
 * `Intl` takes an instant and answers with a wall clock, so the inverse needs a
 * guess. The obvious guess — subtract the offset that `tz` reports at `naive`,
 * the wall clock read as if it were UTC — reads the offset at an instant that
 * is one whole offset away from the answer. For most of the year both instants
 * sit inside the same offset period and the guess is right. Near a transition
 * they straddle it, and the answer is off by an hour: in Berlin,
 * `2026-03-29 03:30` asked for the offset at 02:30 UTC, was told CET (+60,
 * still true at that instant), and returned 02:30 UTC — 04:30 local, an hour
 * late, on the first morning of summer time.
 *
 * The fix is to screen the candidates instead of trusting the guess: for each
 * offset the zone uses near `naive` the candidate is `naive - offset`, and the
 * candidate is only accepted if reading it back reproduces the requested wall
 * clock. Berlin's `2026-10-25 02:30` yields +120 and +60, giving the two
 * candidates 00:30Z and 01:30Z, both of which read `02:30`; Berlin's
 * `2026-03-29 01:30` yields the same pair, of which only 00:30Z reads `01:30`.
 * That screening is what removes the entire class of off-by-one-offset bugs,
 * and probing `naive` plus one day either side of it reports both sides of any
 * transition inside the 25-hour window the answer can occupy — including zones
 * that shift twice within a day, like Lord Howe's half-hour DST.
 *
 * Two wall clocks are not invertible, and every such case has to pick:
 *
 * - **fall-back overlap** — the wall clock exists twice, both candidates read
 *   it, and the **earlier** instant wins: the daylight-time occurrence, 00:30Z
 *   for Berlin's `02:30`. That is the pre-DST reading a person means by "the
 *   02:30 I booked" and matches Temporal's `"compatible"` disambiguation.
 * - **spring-forward gap** — the wall clock does not exist, so no candidate
 *   reproduces it and the requested value falls strictly between two candidate
 *   readings. The earliest candidate that has moved past the requested wall
 *   clock wins: Berlin's nonexistent `02:30` resolves to 01:00Z, the instant
 *   the clock jumps to `03:00`. Also Temporal's `"compatible"` shift-forward,
 *   and it never returns a nonexistent local time.
 *
 * Both rules compare local date-times as `YYYY-MM-DD` + `HH:MM` strings, which
 * order identically to the values they denote precisely because the format is
 * fixed-width and zero-padded — so `time` is padded before use.
 *
 * `date` and `time` must name a wall clock that actually occurs on the
 * Gregorian calendar: `"2026-02-30"`, `"2026-13-01"` and `"25:00"` all throw,
 * as does a year outside 100–9999 (`Date.UTC` folds a two-digit year like
 * `99` into 1999 rather than rejecting it).
 */
export function zonedDateTime(date: string, time: string, tz: string): Date {
  const [year, month, day] = date.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0)

  // `Date.UTC` is permissive — `"2026-13-45"` rolls over into 2027 — so a
  // non-finite result is the only signal that the input was not a date and time
  // at all. Rejecting it here is what keeps `Infinity` from escaping as a
  // `Date` and the comparison below from being made against garbage.
  if (!Number.isFinite(naiveUtc)) {
    throw new RangeError(`Not a date and time: ${JSON.stringify({ date, time, tz })}`)
  }

  // `Date.UTC` is also permissive about a real-looking but impossible date: it
  // rolls "2026-02-30" into 2 March and "25:00" into 01:00 the next day rather
  // than rejecting either, and folds a two-digit year like `99` into 1999.
  // Reading the parts back off the UTC instant it produced and comparing them
  // against what was asked for is what turns that silent rollover into a
  // rejection.
  const probe = new Date(naiveUtc)
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute
  ) {
    throw new RangeError(`Not a real date and time: ${JSON.stringify({ date, time })}`)
  }

  // `naive - offset` for every offset the zone uses near `naive`, deduplicated:
  // one candidate on an ordinary day, two on a transition day, more only for a
  // zone that shifts twice within a day.
  const candidates: Date[] = []
  const seenOffsets = new Set<number>()

  for (const probeMs of [naiveUtc, naiveUtc - 86_400_000, naiveUtc + 86_400_000]) {
    const offsetMs = tzOffsetMinutes(new Date(probeMs), tz) * 60_000
    if (seenOffsets.has(offsetMs)) continue

    seenOffsets.add(offsetMs)
    candidates.push(new Date(naiveUtc - offsetMs))
  }

  const wallClock = (instant: Date): string =>
    `${isoDateInTz(instant, tz)} ${hhmmInTz(instant, tz)}`

  const requested = `${date} ${time.padStart(5, "0")}`

  // Reduce over epoch milliseconds, not `Date` objects: `new Date(Infinity)` is
  // an invalid date that compares false against everything, so a `Date`
  // sentinel would swallow the candidates it was meant to seed.
  const earliestMs = candidates
    .filter((instant) => wallClock(instant) >= requested)
    .reduce((earliest, candidate) => Math.min(earliest, candidate.getTime()), Infinity)

  if (earliestMs === Infinity) {
    // Unreachable for a valid zone: some candidate always lands at or after the
    // requested wall clock. Kept as a hard failure rather than an invalid date.
    throw new RangeError(`No instant reads as ${requested} in ${tz}`)
  }

  return new Date(earliestMs)
}

/**
 * Locale used only to read the numeric UTC offset out of ICU — never the
 * locale of any other formatter in this module.
 *
 * `tzOffsetMinutes` parses ICU's offset text with a `"GMT±H:MM"` pattern, and
 * that pattern is `en-GB`'s own rendering, not a locale-neutral one: `fr-FR`
 * renders the same offset as `"UTC+5:30"` and `ar-EG` with Arabic-indic
 * digits (`"غرينتش+٥:٣٠"`), neither of which the pattern reads, and an
 * unread offset silently becomes 0 (see below) — five and a half hours wrong
 * for `Asia/Kolkata`. `zonedDateTime` depends on this being correct, so this
 * formatter is deliberately kept outside {@link optionSets} and
 * {@link zonedFormatter}: a locale parameter added to the display formatters
 * later cannot reach this one by sharing its code path.
 */
const OFFSET_LOCALE = "en-GB"

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>()

/** A formatter that reads `tz`'s UTC offset text, always in {@link OFFSET_LOCALE}. */
function offsetFormatter(tz: string): Intl.DateTimeFormat {
  const cached = offsetFormatterCache.get(tz)
  if (cached) return cached

  const formatter = new Intl.DateTimeFormat(OFFSET_LOCALE, {
    timeZone: tz,
    timeZoneName: "shortOffset",
  })
  offsetFormatterCache.set(tz, formatter)
  return formatter
}

/**
 * Minutes east of UTC for `tz` at the instant `instant`. Positive east.
 *
 * ICU reports the offset as `"GMT+1"`, `"GMT-5"`, `"GMT+5:30"`, `"GMT+10:30"`
 * (Lord Howe) or `"GMT+12:45"` (Chatham), and plain `"GMT"` for zero — which
 * UTC, `Atlantic/Reykjavik` and every `GMT+x` zone's own baseline use. An
 * unmatched name is treated as 0 rather than throwing: the name is ICU's, so a
 * future rename should degrade to "no offset" instead of breaking every caller.
 * This reads {@link offsetFormatter}, pinned to {@link OFFSET_LOCALE}, and
 * nothing else — see that formatter's doc for why.
 *
 * Minute resolution only — historical LMT offsets carry seconds, which no
 * scheduling use case here needs.
 */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = offsetFormatter(tz).formatToParts(instant)

  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT"
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
  if (!match) return 0

  const sign = match[1] === "-" ? -1 : 1
  const hours = parseInt(match[2], 10)
  const minutes = parseInt(match[3] ?? "0", 10)
  return sign * (hours * 60 + minutes)
}

/** Abbreviated weekday name in `tz`, uppercased: `"FRI"`. Noon anchor, see {@link addDays}. */
export function dayOfWeek(date: string, tz: string): string {
  // Noon, because 00:00 of the transition day does not exist in every zone.
  return zonedFormatter("shortWeekday", tz)
    .format(zonedDateTime(date, "12:00", tz))
    .toUpperCase()
}

/**
 * Add `n` days to a `YYYY-MM-DD` date in `tz`. `n` may be negative.
 *
 * The noon anchor is the DST fix, not a detail. Calendar days are not 86,400
 * seconds: on a transition day a day is 23 or 25 hours long, so
 * `+ n * 86_400_000` lands an hour off. Starting from 12:00 local and moving the
 * *UTC* date by `n` keeps the same instant-of-day offset — up to 23 hours of
 * slack in either direction — and re-reading the resulting day in `tz` yields
 * the neighbouring calendar date. Midday is the anchor because no zone
 * transitions at noon, so no date arithmetic can fall inside a gap, and
 * March–April and September–November, which contain 02:00 transitions almost
 * everywhere, are both safe.
 *
 * Note the intent: this moves the *date*, not a duration. Adding a day to
 * `2026-03-28` yields `2026-03-29`, whose local length is 23 hours.
 */
export function addDays(date: string, n: number, tz: string): string {
  const noon = zonedDateTime(date, "12:00", tz)
  noon.setUTCDate(noon.getUTCDate() + n)
  return isoDateInTz(noon, tz)
}

/**
 * Minutes since midnight to a zero-padded `"HH:MM"`.
 *
 * The input is assumed to be inside a day (`0`–`1439`), as produced by slot
 * generation. Values outside it are passed through arithmetically rather than
 * clamped — `1440` is `"24:00"`, the exclusive end of a day, which callers use
 * as a range bound — so a negative or fractional input is a caller bug and
 * keeps its obviously-wrong output instead of being silently folded into a
 * plausible time.
 */
export function minToHHMM(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`
}
