/**
 * Reads the offset rules of a `VTIMEZONE` component (RFC 5545 §3.6.5), so `./ical.ts` can resolve
 * a `TZID` that is not an IANA name: a Windows name, or one a client made up.
 *
 * Supported: `STANDARD` and `DAYLIGHT` parts with `DTSTART`, `TZOFFSETFROM` and `TZOFFSETTO`,
 * one-off changes (`RDATE`), and the yearly rule every client writes: `FREQ=YEARLY` with one
 * `BYMONTH`, and either one numbered `BYDAY` (`-1SU`), a `BYMONTHDAY` list, or both a plain
 * `BYDAY` and a `BYMONTHDAY` list ("the Sunday on or after the 8th"), optionally ended by
 * `UNTIL`. A yearly rule with none of these parts repeats the day of `DTSTART`. A definition that
 * uses anything else is reported as unusable instead of being read approximately.
 *
 * Web-platform APIs only, no `Deno.*`, no dependencies.
 * @module
 */

import type { IcalComponent, IcalProperty } from "./ical.ts"

/** One change of offset: from `atMs` (epoch milliseconds) on, the zone is `to` ahead of UTC. */
interface Transition {
  atMs: number
  /** Offset before the change, in milliseconds east of UTC. */
  from: number
  /** Offset after the change, in milliseconds east of UTC. */
  to: number
}

/** Thrown inside this module for a definition outside the supported subset; never escapes. */
class Unusable extends Error {}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
const RULE_PARTS = new Set(["FREQ", "INTERVAL", "BYMONTH", "BYDAY", "BYMONTHDAY", "UNTIL", "WKST"])

/** A wall clock as if it were UTC, in epoch milliseconds. Years below 100 stay what they say. */
export function wallMs(year: number, month: number, day: number, h = 0, m = 0, s = 0): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(h, m, s, 0)
  return date.getTime()
}

/** `YYYYMMDDTHHMMSS`, with or without a trailing `Z`, as {@link wallMs}. */
function parseDateTime(text: string): { ms: number; utc: boolean } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(text.trim())
  if (!match) return undefined
  const [year, month, day, h, m, s] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || m > 59 || s > 60) return undefined
  return { ms: wallMs(year, month, day, h, m, s), utc: match[7] === "Z" }
}

/** `+HHMM` or `-HHMMSS` in milliseconds east of UTC. */
function parseOffset(text: string | undefined): number {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(text?.trim() ?? "")
  if (!match) throw new Unusable()
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)
  return (match[1] === "-" ? -seconds : seconds) * 1000
}

function property(component: IcalComponent, name: string): IcalProperty | undefined {
  return component.properties.find((item) => item.name.toUpperCase() === name)
}

/** The `VTIMEZONE` under `root` (or `root` itself) whose `TZID` is `tzid`. */
export function findTimezone(root: IcalComponent, tzid: string): IcalComponent | undefined {
  if (root.name.toUpperCase() === "VTIMEZONE" && property(root, "TZID")?.value === tzid) return root
  for (const child of root.components) {
    const found = findTimezone(child, tzid)
    if (found) return found
  }
  return undefined
}

/** Integers of a comma-separated rule part. */
function integers(text: string): number[] {
  const out = text.split(",").map((item) => /^[+-]?\d+$/.test(item) ? Number(item) : NaN)
  if (out.some(Number.isNaN)) throw new Unusable()
  return out
}

/**
 * The wall clocks (as {@link wallMs}) at which a yearly rule changes the offset in each of
 * `years`. `start` is the part's `DTSTART`, which gives the time of day and the defaults.
 */
function yearlyOnsets(rule: string, start: number, from: number, years: number[]): number[] {
  const parts = new Map<string, string>()
  for (const piece of rule.trim().split(";")) {
    const eq = piece.indexOf("=")
    const name = piece.slice(0, eq).toUpperCase()
    if (eq <= 0 || !RULE_PARTS.has(name) || parts.has(name)) throw new Unusable()
    parts.set(name, piece.slice(eq + 1).toUpperCase())
  }
  if (parts.get("FREQ") !== "YEARLY" || (parts.get("INTERVAL") ?? "1") !== "1") {
    throw new Unusable()
  }
  // Without BYMONTH, BYDAY counts weekdays of the whole year and BYMONTHDAY names every month.
  if (!parts.has("BYMONTH") && (parts.has("BYDAY") || parts.has("BYMONTHDAY"))) {
    throw new Unusable()
  }
  const first = new Date(start)
  const months = integers(parts.get("BYMONTH") ?? String(first.getUTCMonth() + 1))
  const month = months[0]!
  if (months.length !== 1 || month < 1 || month > 12) throw new Unusable()
  const byDay = parts.has("BYDAY") ? /^([+-]?[1-5])?([A-Z]{2})$/.exec(parts.get("BYDAY")!) : null
  if (parts.has("BYDAY") && (!byDay || !WEEKDAYS.includes(byDay[2]!))) throw new Unusable()
  const monthDays = parts.has("BYMONTHDAY") ? integers(parts.get("BYMONTHDAY")!) : undefined
  if (monthDays?.some((day) => day === 0 || Math.abs(day) > 31)) throw new Unusable()
  // A plain BYDAY alone would change the offset every week of the month.
  if (byDay && !byDay[1] && !monthDays) throw new Unusable()
  const until = parts.has("UNTIL") ? parseDateTime(parts.get("UNTIL")!) : undefined
  if (parts.has("UNTIL") && !until) throw new Unusable()
  const timeOfDay = start -
    wallMs(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate())

  const lastYear = until ? new Date(until.ms).getUTCFullYear() : undefined
  const wanted = new Set(years)
  if (lastYear !== undefined) [-1, 0, 1].forEach((step) => wanted.add(lastYear + step))
  const out: number[] = []
  for (const year of wanted) {
    const length = new Date(wallMs(year, month + 1, 0)).getUTCDate()
    let days = Array.from({ length }, (_, index) => index + 1)
    if (byDay) {
      const weekday = WEEKDAYS.indexOf(byDay[2]!)
      days = days.filter((day) => new Date(wallMs(year, month, day)).getUTCDay() === weekday)
      const nth = Number(byDay[1] ?? 0)
      const index = nth > 0 ? nth - 1 : days.length + nth
      if (nth !== 0) days = days[index] === undefined ? [] : [days[index]]
    }
    if (monthDays) {
      const allowed = monthDays.map((day) => day < 0 ? length + day + 1 : day)
      days = days.filter((day) => allowed.includes(day))
    } else if (!byDay) {
      days = days.filter((day) => day === first.getUTCDate())
    }
    if (days.length > 1) throw new Unusable()
    if (days.length === 0) continue
    const onset = wallMs(year, month, days[0]!) + timeOfDay
    if (onset < start) continue
    // UNTIL with a `Z` is an instant; the onset is a wall clock in the offset before the change.
    if (until && (until.utc ? onset - from : onset) > until.ms) continue
    out.push(onset)
  }
  return out
}

/** Every offset change of `timezone` that can decide a wall clock in `year`, earliest first. */
function transitions(timezone: IcalComponent, year: number): Transition[] {
  const out: Transition[] = []
  for (const part of timezone.components) {
    const kind = part.name.toUpperCase()
    if (kind !== "STANDARD" && kind !== "DAYLIGHT") continue
    const from = parseOffset(property(part, "TZOFFSETFROM")?.value)
    const to = parseOffset(property(part, "TZOFFSETTO")?.value)
    const start = parseDateTime(property(part, "DTSTART")?.value ?? "")
    if (!start || start.utc) throw new Unusable()
    const onsets = [start.ms]
    const rules = part.properties.filter((item) => item.name.toUpperCase() === "RRULE")
    if (rules.length > 1) throw new Unusable()
    if (rules[0]) {
      onsets.push(...yearlyOnsets(rules[0].value, start.ms, from, [year - 1, year, year + 1]))
    }
    for (const rdate of part.properties.filter((item) => item.name.toUpperCase() === "RDATE")) {
      for (const item of rdate.value.split(",")) {
        const at = parseDateTime(item)
        if (!at || at.utc) throw new Unusable()
        onsets.push(at.ms)
      }
    }
    for (const onset of onsets) out.push({ atMs: onset - from, from, to })
  }
  if (out.length === 0) throw new Unusable()
  return out.sort((a, b) => a.atMs - b.atMs)
}

/**
 * The instant, in epoch milliseconds, of the wall clock `date` (`YYYY-MM-DD`) `time`
 * (`HH:MM:SS`) in the zone that the `VTIMEZONE` named `tzid` under `root` defines. `undefined`
 * when `root` holds no such component or its rules are outside the supported subset.
 *
 * A wall clock that a clock change repeats resolves to the earlier instant, and one it skips to
 * the instant the same distance after the change, as `zonedDateTime` of `./tz.ts` does.
 */
export function vtimezoneInstant(
  root: IcalComponent,
  tzid: string,
  date: string,
  time: string,
): number | undefined {
  const timezone = findTimezone(root, tzid)
  const wall = parseDateTime(`${date.replaceAll("-", "")}T${time.replaceAll(":", "")}`)
  if (!timezone || !wall) return undefined
  let list: Transition[]
  try {
    list = transitions(timezone, new Date(wall.ms).getUTCFullYear())
  } catch (error) {
    if (error instanceof Unusable) return undefined
    throw error
  }
  // Each stretch between two changes has one offset; the wall clock is real in a stretch when
  // the instant that offset gives lies inside it.
  const stretches = [
    { offset: list[0]!.from, since: -Infinity, before: list[0]!.atMs },
    ...list.map((item, index) => ({
      offset: item.to,
      since: item.atMs,
      before: list[index + 1]?.atMs ?? Infinity,
    })),
  ]
  const real = stretches
    .map((stretch) => ({ ...stretch, instant: wall.ms - stretch.offset }))
    .filter((stretch) => stretch.instant >= stretch.since && stretch.instant < stretch.before)
    .map((stretch) => stretch.instant)
  if (real.length > 0) return Math.min(...real)
  const skipped = list.find((item) =>
    wall.ms - item.from >= item.atMs && wall.ms - item.to < item.atMs
  )
  return skipped ? wall.ms - skipped.from : undefined
}
