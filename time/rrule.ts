/**
 * Repeat rules (RFC 5545 `RRULE`) for the subset Tasks.org writes, with a typed refusal for
 * everything else.
 *
 * {@link parseRrule} accepts `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYDAY` with
 * ordinals (`2MO`, `-1FR`), `BYMONTHDAY`, `BYMONTH`, `COUNT`, `UNTIL` and `WKST`. Any other part
 * (`BYSETPOS`, `BYHOUR`, `FREQ=HOURLY`, a vendor `X-` part) is refused with the part's name, so an
 * app can say "complete this one in Tasks.org" instead of guessing. {@link nextOccurrence} steps
 * the wall clock of the start value and keeps its kind (date, floating, UTC, zoned); zone maths
 * go through `./tz.ts`. {@link occurrencesBetween} lists every occurrence in a range with the same
 * stepping. {@link describeRrule} gives a label, in English or in the words of a translator made
 * from the catalogs in `./rrule-words/`. {@link formatRrule} writes a rule back to its `RRULE` value.
 *
 * A date a month does not have (the 31st in April, 29 February in a common year) is skipped, as
 * RFC 5545 section 3.3.10 requires, with one exception that follows Tasks.org: a plain monthly
 * rule (no `BYDAY`, no `BYMONTH`, no `BYMONTHDAY` or one positive day) is anchored on that day, or
 * on the start's day without one, and uses the month's last day when a month is shorter than the
 * anchor, so 31 January is followed by 28 February. {@link RruleMonthEnd.Skip} turns the exception
 * off, for an app that follows RFC 5545 to the letter. A wall clock a zone skips (a spring-forward
 * gap) is kept: the occurrence keeps its date and wall clock, which `resolveInstant` shifts
 * forward, so a task due at 02:30 is not lost on that day.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`, no dependencies.
 * @module
 */

import { IcalDateKind, type IcalDateValue, resolveInstant } from "./ical.ts"
import { formatIsoDate, parseIsoDate } from "./date.ts"
import { wallMs } from "./ical-timezone.ts"
import { isoDateInTz, isValidTimeZone } from "./tz.ts"
import { dayLabel, localeFirstWeekday, monthLabels, weekdayLabels } from "./locale.ts"
import en from "./rrule-words/en.ts"

/** How often the rule repeats. Hourly and finer frequencies are outside the subset. */
export enum RruleFreq {
  Daily = 1,
  Weekly,
  Monthly,
  Yearly,
}

/** A day of the week, numbered like ISO 8601: Monday is 1, Sunday is 7. */
export enum RruleWeekday {
  Monday = 1,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
  Saturday,
  Sunday,
}

/** One `BYDAY` entry: a weekday, with an ordinal in a month (`2MO` is 2, `-1FR` is -1). */
export interface RruleDay {
  weekday: RruleWeekday
  /** 1 to 5 counts from the start of the month, -1 to -5 from its end. Absent: every such day. */
  ordinal?: number
}

/** A parsed repeat rule. */
export interface Rrule {
  freq: RruleFreq
  /** Repeat every this many periods. At least 1. */
  interval: number
  /** Empty when the rule has no `BYDAY`. */
  byDay: RruleDay[]
  /** 1 to 31 from the start of the month, -1 to -31 from its end. Empty when absent. */
  byMonthDay: number[]
  /** 1 to 12. Empty when absent. */
  byMonth: number[]
  /** Total number of occurrences; the rule has no `UNTIL` then. */
  count?: number
  /** Inclusive end: a date, a floating time or a UTC time. */
  until?: IcalDateValue
  /** The day a week starts on. Default Monday. */
  weekStart: RruleWeekday
}

/** Why an operation of this module failed. */
export enum RruleErrorCode {
  /** The text is not a well-formed rule, or a value is out of range. */
  Malformed = 1,
  /** The rule is well formed but uses a part, a frequency or a combination outside the subset. */
  Unsupported,
  /** The start value or the time zone is not usable. */
  InvalidStart,
  /** No occurrence turned up within the search limit; the rule almost certainly never matches. */
  SearchLimit,
}

/** The error half of {@link RruleResult}. */
export interface RruleError {
  code: RruleErrorCode
  /** The rule part at fault, upper-case, such as `BYSETPOS` or `FREQ`. */
  part?: string
  message: string
}

/** `{ success, output, error }`: the output, or why there is none. */
export type RruleResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: RruleError }

const ok = <T>(output: T): RruleResult<T> => ({ success: true, output, error: null })
const fail = (code: RruleErrorCode, message: string, part?: string): RruleResult<never> => ({
  success: false,
  output: null,
  error: part === undefined ? { code, message } : { code, part, message },
})

const SUPPORTED_PARTS = new Set([
  `FREQ`,
  `INTERVAL`,
  `BYDAY`,
  `BYMONTHDAY`,
  `BYMONTH`,
  `COUNT`,
  `UNTIL`,
  `WKST`,
])
const FREQ_BY_NAME: Record<string, RruleFreq> = {
  DAILY: RruleFreq.Daily,
  WEEKLY: RruleFreq.Weekly,
  MONTHLY: RruleFreq.Monthly,
  YEARLY: RruleFreq.Yearly,
}
const FREQ_NOT_SUPPORTED = new Set([`SECONDLY`, `MINUTELY`, `HOURLY`])
const WEEKDAY_BY_CODE: Record<string, RruleWeekday> = {
  MO: RruleWeekday.Monday,
  TU: RruleWeekday.Tuesday,
  WE: RruleWeekday.Wednesday,
  TH: RruleWeekday.Thursday,
  FR: RruleWeekday.Friday,
  SA: RruleWeekday.Saturday,
  SU: RruleWeekday.Sunday,
}
const MAX_INTERVAL = 100_000
const MAX_COUNT = 1_000_000
/** Consecutive periods without a match one search looks at. A rule without a match inside it is reported, not looped on. */
const SEARCH_LIMIT = 100_000

/**
 * Parse the value of an `RRULE` property (a leading `RRULE:` is accepted). Names and
 * enumerated values are case-insensitive. Returns {@link RruleErrorCode.Unsupported} naming the
 * first part, in text order, that is outside the subset, and {@link RruleErrorCode.Malformed}
 * for a broken value.
 */
export function parseRrule(text: string): RruleResult<Rrule> {
  const body = text.trim().replace(/^RRULE:/i, ``)
  if (body === ``) return fail(RruleErrorCode.Malformed, `empty rule`)
  const parts = new Map<string, string>()
  const order: string[] = []
  for (const piece of body.split(`;`)) {
    const eq = piece.indexOf(`=`)
    if (eq <= 0) return fail(RruleErrorCode.Malformed, `"${piece}" is not NAME=VALUE`)
    const name = piece.slice(0, eq).toUpperCase()
    if (parts.has(name)) return fail(RruleErrorCode.Malformed, `${name} appears twice`, name)
    parts.set(name, piece.slice(eq + 1))
    order.push(name)
  }
  for (const name of order) {
    if (!SUPPORTED_PARTS.has(name)) {
      return fail(RruleErrorCode.Unsupported, `${name} is not supported`, name)
    }
    const value = parts.get(name)!.toUpperCase()
    if (name === `FREQ` && FREQ_NOT_SUPPORTED.has(value)) {
      return fail(RruleErrorCode.Unsupported, `FREQ=${value} is not supported`, `FREQ`)
    }
  }
  const freqText = parts.get(`FREQ`)?.toUpperCase()
  if (freqText === undefined) return fail(RruleErrorCode.Malformed, `FREQ is missing`, `FREQ`)
  const freq = FREQ_BY_NAME[freqText]
  if (freq === undefined) {
    return fail(RruleErrorCode.Malformed, `FREQ=${freqText} is not a frequency`, `FREQ`)
  }

  const interval = integerPart(parts.get(`INTERVAL`), `INTERVAL`, 1, MAX_INTERVAL, 1)
  if (typeof interval !== `number`) return interval
  const count = parts.has(`COUNT`)
    ? integerPart(parts.get(`COUNT`), `COUNT`, 1, MAX_COUNT, 0)
    : undefined
  if (typeof count === `object`) return count

  const weekStart = parts.has(`WKST`) ? WEEKDAY_BY_CODE[parts.get(`WKST`)!.toUpperCase()] : 1
  if (weekStart === undefined) return fail(RruleErrorCode.Malformed, `bad WKST`, `WKST`)

  const byMonth = listPart(parts.get(`BYMONTH`), `BYMONTH`, 1, 12)
  if (!Array.isArray(byMonth)) return byMonth
  const byMonthDay = listPart(parts.get(`BYMONTHDAY`), `BYMONTHDAY`, 1, 31, true)
  if (!Array.isArray(byMonthDay)) return byMonthDay

  const byDay: RruleDay[] = []
  for (const item of parts.get(`BYDAY`)?.split(`,`) ?? []) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(item)
    if (!match) return fail(RruleErrorCode.Malformed, `"${item}" is not a BYDAY entry`, `BYDAY`)
    const weekday = WEEKDAY_BY_CODE[match[2]!.toUpperCase()]!
    if (match[1] === undefined) {
      byDay.push({ weekday })
      continue
    }
    const ordinal = Number(match[1])
    if (ordinal === 0 || Math.abs(ordinal) > 5) {
      return fail(RruleErrorCode.Malformed, `ordinal in "${item}" is out of range`, `BYDAY`)
    }
    byDay.push({ weekday, ordinal })
  }
  if (parts.has(`BYDAY`) && byDay.length === 0) {
    return fail(RruleErrorCode.Malformed, `BYDAY is empty`, `BYDAY`)
  }

  // Tasks.org deletes BYDAY from a daily or yearly rule, so no answer of ours could match it.
  if (byDay.length > 0 && (freq === RruleFreq.Daily || freq === RruleFreq.Yearly)) {
    return fail(RruleErrorCode.Unsupported, `BYDAY does not apply to DAILY or YEARLY`, `BYDAY`)
  }
  if (freq === RruleFreq.Weekly && byDay.some((day) => day.ordinal !== undefined)) {
    return fail(RruleErrorCode.Unsupported, `BYDAY with a number needs FREQ=MONTHLY`, `BYDAY`)
  }
  if (freq === RruleFreq.Weekly && byMonthDay.length > 0) {
    return fail(RruleErrorCode.Unsupported, `BYMONTHDAY does not apply to WEEKLY`, `BYMONTHDAY`)
  }

  let until: IcalDateValue | undefined
  if (parts.has(`UNTIL`)) {
    if (count !== undefined) {
      return fail(RruleErrorCode.Malformed, `COUNT and UNTIL together`, `UNTIL`)
    }
    until = parseUntil(parts.get(`UNTIL`)!)
    if (!until) return fail(RruleErrorCode.Malformed, `bad UNTIL`, `UNTIL`)
  }

  const rule: Rrule = {
    freq,
    interval,
    byDay,
    byMonthDay,
    byMonth,
    weekStart,
  }
  if (count !== undefined) rule.count = count
  if (until) rule.until = until
  return ok(rule)
}

const WEEKDAY_CODES = [`MO`, `TU`, `WE`, `TH`, `FR`, `SA`, `SU`]
const FREQ_NAMES = [``, `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`]

/**
 * Write `rule` as the value of an `RRULE` property (no `RRULE:` prefix), so that
 * {@link parseRrule} reads it back to an equal rule. The parts come in this order: `FREQ`, `WKST`,
 * `UNTIL`, `COUNT`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`. Tasks.org captures confirm only
 * `INTERVAL` right after `FREQ` and `COUNT` before `INTERVAL`; the place of the `BY*` parts is
 * assumed from ical4j. `INTERVAL` is always written, as Tasks.org does (`FREQ=DAILY;INTERVAL=1`);
 * `WKST` only when the week does not start on Monday. The lists keep the order they have in `rule`.
 *
 * The text is run through {@link parseRrule}, so a rule outside the subset (`BYDAY` on a daily
 * rule, `COUNT` together with `UNTIL`, an interval of 0, a zoned `UNTIL`) is a failure with the
 * parser's code and message, never a text Tasks.org would read differently.
 */
export function formatRrule(rule: Rrule): RruleResult<string> {
  const parts = [`FREQ=${FREQ_NAMES[rule.freq] ?? ``}`]
  if (rule.weekStart !== RruleWeekday.Monday) {
    parts.push(`WKST=${WEEKDAY_CODES[rule.weekStart - 1] ?? ``}`)
  }
  if (rule.until) {
    const { kind, date, time } = rule.until
    if (kind === IcalDateKind.Zoned) {
      return fail(RruleErrorCode.Malformed, `UNTIL cannot carry a time zone`, `UNTIL`)
    }
    const day = date.replaceAll(`-`, ``)
    const clock = `T${(time ?? `00:00:00`).replaceAll(`:`, ``)}`
    parts.push(
      `UNTIL=${day}${kind === IcalDateKind.Date ? `` : clock}${
        kind === IcalDateKind.Utc ? `Z` : ``
      }`,
    )
  }
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDay.length) {
    parts.push(
      `BYDAY=${
        rule.byDay.map((day) => `${day.ordinal ?? ``}${WEEKDAY_CODES[day.weekday - 1] ?? ``}`)
          .join(`,`)
      }`,
    )
  }
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(`,`)}`)
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(`,`)}`)
  const text = parts.join(`;`)
  const check = parseRrule(text)
  return check.success ? ok(text) : check
}

function integerPart(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number | RruleResult<never> {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    return fail(RruleErrorCode.Malformed, `${name}=${raw} must be ${min} to ${max}`, name)
  }
  return Number(raw)
}

function listPart(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  signed = false,
): number[] | RruleResult<never> {
  if (raw === undefined) return []
  const out: number[] = []
  for (const item of raw.split(`,`)) {
    const value = Number(item)
    const shape = signed ? /^[+-]?\d{1,2}$/ : /^\d{1,2}$/
    const magnitude = Math.abs(value)
    if (!shape.test(item) || magnitude < min || magnitude > max) {
      return fail(RruleErrorCode.Malformed, `"${item}" is out of range for ${name}`, name)
    }
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function parseUntil(raw: string): IcalDateValue | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(raw)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s, z] = match
  const check = new Date(Date.UTC(2000, 0, 1))
  check.setUTCFullYear(Number(y), Number(mo) - 1, Number(d))
  if (
    check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 ||
    check.getUTCDate() !== Number(d)
  ) return undefined
  const date = `${y}-${mo}-${d}`
  if (h === undefined) return { kind: IcalDateKind.Date, date }
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined
  return {
    kind: z ? IcalDateKind.Utc : IcalDateKind.Floating,
    date,
    time: `${h}:${mi}:${s}`,
  }
}

// ---- day arithmetic on the proleptic Gregorian calendar, in days since 1970-01-01 -------------

const MS_PER_DAY = 86_400_000
/** The first and the last day an occurrence can fall on: 0001-01-01 and 9999-12-31. */
const FIRST_DAY = parseIsoDate("0001-01-01") / MS_PER_DAY
const LAST_DAY = parseIsoDate("9999-12-31") / MS_PER_DAY

function toDays(year: number, month: number, day: number): number {
  return wallMs(year, month, day) / MS_PER_DAY
}

function fromDays(days: number): { year: number; month: number; day: number } {
  const t = new Date(days * MS_PER_DAY)
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** ISO weekday of a day number: 1970-01-01 (day 0) was a Thursday. */
function weekdayOf(days: number): RruleWeekday {
  return ((((days + 3) % 7) + 7) % 7) + 1
}

function daysInMonth(year: number, month: number): number {
  return toDays(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) -
    toDays(year, month, 1)
}

/** `YYYY-MM-DD` of a day number, or `undefined` outside {@link FIRST_DAY}…{@link LAST_DAY}. */
function isoDate(days: number): string | undefined {
  return days < FIRST_DAY || days > LAST_DAY ? undefined : formatIsoDate(days * MS_PER_DAY)
}

/** The day number of a `YYYY-MM-DD` date, or `undefined` when the calendar has no such day. */
function dayNumber(date: string): number | undefined {
  try {
    return parseIsoDate(date) / MS_PER_DAY
  } catch {
    return undefined
  }
}

// ---- candidate days of one period --------------------------------------------------------------

function dayMatches(rule: Rrule, days: number): boolean {
  if (!rule.byMonth.length && !rule.byMonthDay.length) return true
  const { year, month, day } = fromDays(days)
  const length = daysInMonth(year, month)
  if (rule.byMonth.length && !rule.byMonth.includes(month)) return false
  if (
    rule.byMonthDay.length &&
    !rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === day)
  ) return false
  return true
}

function weekdayMatches(entry: RruleDay, day: number, length: number, days: number): boolean {
  if (weekdayOf(days) !== entry.weekday) return false
  if (entry.ordinal === undefined) return true
  return entry.ordinal > 0
    ? Math.ceil(day / 7) === entry.ordinal
    : Math.ceil((length - day + 1) / 7) === -entry.ordinal
}

/** Days of month `month` of `year` the rule selects; `startDay` is the default day. */
function monthDays(rule: Rrule, year: number, month: number, startDay: number): number[] {
  const length = daysInMonth(year, month)
  const first = toDays(year, month, 1)
  const out: number[] = []
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0) {
    if (startDay <= length) out.push(first + startDay - 1)
    return out
  }
  for (let day = 1; day <= length; day++) {
    const days = first + day - 1
    if (
      (rule.byMonthDay.length === 0 ||
        rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === day)) &&
      (rule.byDay.length === 0 ||
        rule.byDay.some((entry) => weekdayMatches(entry, day, length, days)))
    ) out.push(days)
  }
  return out
}

/** Tasks.org's plain monthly shape, which it clips to the month's end instead of skipping. */
function clipsMonthEnd(rule: Rrule): boolean {
  return rule.freq === RruleFreq.Monthly && rule.byDay.length === 0 && rule.byMonth.length === 0 &&
    (rule.byMonthDay.length === 0 || (rule.byMonthDay.length === 1 && rule.byMonthDay[0]! > 0))
}

/**
 * Tasks.org's month-end handling of a plain monthly rule, as a series. The anchor is the single
 * `BYMONTHDAY`, or the start's day. Every later period holds the anchor, or the month's last day
 * when the month is shorter. The start's own month holds the start when the start sits on the
 * (clipped) anchor. It also holds an anchor later in that month, but only when the month
 * `INTERVAL` months on is long enough for the anchor; otherwise Tasks.org goes straight to that
 * month's last day, so 15 January with `BYMONTHDAY=31` is followed by 28 February.
 */
function clippedMonthDays(
  rule: Rrule,
  start: { year: number; month: number; day: number },
  k: number,
  year: number,
  month: number,
): number[] {
  const anchor = rule.byMonthDay[0] ?? start.day
  const length = daysInMonth(year, month)
  if (k > 0) return [toDays(year, month, Math.min(anchor, length))]
  if (Math.min(anchor, length) === start.day) return [toDays(year, month, start.day)]
  const later = start.year * 12 + start.month - 1 + rule.interval
  const laterLength = daysInMonth(Math.floor(later / 12), (later % 12) + 1)
  return anchor > start.day && anchor <= length && anchor <= laterLength
    ? [toDays(year, month, anchor)]
    : []
}

/** The day numbers period `k` of the rule selects, ascending. */
function periodDays(rule: Rrule, startDays: number, k: number, clip: boolean): number[] {
  const start = fromDays(startDays)
  switch (rule.freq) {
    case RruleFreq.Daily: {
      const days = startDays + k * rule.interval
      return dayMatches(rule, days) ? [days] : []
    }
    case RruleFreq.Weekly: {
      const startOfWeek = startDays - ((weekdayOf(startDays) - rule.weekStart + 7) % 7)
      const weekdays = rule.byDay.length
        ? rule.byDay.map((entry) => entry.weekday)
        : [weekdayOf(startDays)]
      const base = startOfWeek + 7 * rule.interval * k
      return weekdays
        .map((weekday) => base + ((weekday - rule.weekStart + 7) % 7))
        .sort((a, b) => a - b)
        .filter((days) => !rule.byMonth.length || rule.byMonth.includes(fromDays(days).month))
    }
    case RruleFreq.Monthly: {
      const index = start.year * 12 + start.month - 1 + k * rule.interval
      const year = Math.floor(index / 12)
      const month = (index % 12) + 1
      if (rule.byMonth.length && !rule.byMonth.includes(month)) return []
      if (clip && clipsMonthEnd(rule)) return clippedMonthDays(rule, start, k, year, month)
      return monthDays(rule, year, month, start.day)
    }
    case RruleFreq.Yearly: {
      const year = start.year + k * rule.interval
      const months = rule.byMonth.length
        ? [...rule.byMonth].sort((a, b) => a - b)
        : rule.byMonthDay.length
        ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        : [start.month]
      return months.flatMap((month) => monthDays(rule, year, month, start.day))
    }
  }
}

/** A period index safely before the one holding `refDays`, so a search can skip ahead. */
function firstPeriod(rule: Rrule, startDays: number, refDays: number): number {
  if (refDays <= startDays) return 0
  const start = fromDays(startDays)
  const ref = fromDays(refDays)
  let periods: number
  switch (rule.freq) {
    case RruleFreq.Daily:
      periods = (refDays - startDays) / rule.interval
      break
    case RruleFreq.Weekly:
      periods = (refDays - startDays) / (7 * rule.interval)
      break
    case RruleFreq.Monthly:
      periods = (ref.year * 12 + ref.month - start.year * 12 - start.month) / rule.interval
      break
    case RruleFreq.Yearly:
      periods = (ref.year - start.year) / rule.interval
      break
  }
  return Math.max(0, Math.floor(periods))
}

// ---- stepping through a series -----------------------------------------------------------------

/** How a plain monthly rule treats a month shorter than its day. */
export enum RruleMonthEnd {
  /** Tasks.org's way, the default: use the month's last day, so 31 January is followed by 28 February. */
  Clip = 1,
  /** RFC 5545's way: skip the month, so `BYMONTHDAY=31` falls in January, March, May… */
  Skip,
}

/** Inputs every search of a series shares. */
interface SeriesOptions {
  /** The rule's `DTSTART` (for a task, its due or start date). Results have the same kind. */
  start: IcalDateValue
  /** IANA zone that reads instants against date-only and floating values. Default `UTC`. */
  timeZone?: string
  /** How a plain monthly rule treats a month shorter than its day. Default {@link RruleMonthEnd.Clip}. */
  monthEnd?: RruleMonthEnd
}

/** A validated series: everything a search needs to step through the occurrences in order. */
interface Series {
  /** The occurrence on `date`, with the start's kind, time and zone. */
  make(date: string): IcalDateValue
  /** The instant of the occurrence on `date`, or `undefined` for a date-only start. */
  instant(date: string): number | undefined
  /** `instant` cannot place a date-only start: such a search compares dates in `zone`. */
  dateOnly: boolean
  zone: string
  /**
   * Visit the occurrences in order, from a period safely before `refDays` (from the first period
   * when the rule counts), until `visit` returns true (`found`), the rule ends (`ended`) or a run of
   * {@link SEARCH_LIMIT} periods selects nothing (`limit`).
   */
  walk(refDays: number, visit: (date: string, days: number) => boolean): `found` | `ended` | `limit`
}

function openSeries(rule: Rrule, options: SeriesOptions): RruleResult<Series> {
  const { start } = options
  const zone = start.kind === IcalDateKind.Zoned ? start.tzid : options.timeZone ?? `UTC`
  const dateOnly = start.kind === IcalDateKind.Date
  if (
    !Object.values(IcalDateKind).includes(start.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(start.date) ||
    (dateOnly ? start.time !== undefined : !/^\d{2}:\d{2}:\d{2}$/.test(start.time ?? ``)) ||
    (start.kind === IcalDateKind.Zoned) !== (start.tzid !== undefined)
  ) return fail(RruleErrorCode.InvalidStart, `start is not a well-formed value`)
  if (!zone || !isValidTimeZone(zone)) {
    return fail(RruleErrorCode.InvalidStart, `unknown time zone or invalid instant`)
  }
  const startDays = dayNumber(start.date)
  if (startDays === undefined || isoDate(startDays) === undefined) {
    return fail(RruleErrorCode.InvalidStart, `${start.date} is not a calendar date`)
  }
  const clip = (options.monthEnd ?? RruleMonthEnd.Clip) === RruleMonthEnd.Clip

  const make = (date: string): IcalDateValue => {
    const value: IcalDateValue = { kind: start.kind, date }
    if (start.time !== undefined) value.time = start.time
    if (start.tzid !== undefined) value.tzid = start.tzid
    return value
  }
  const until = rule.until
  // `parseUntil` has checked that the date exists.
  const untilDays = until ? dayNumber(until.date)! : 0
  const withinUntil = (date: string, days: number): boolean => {
    if (!until) return true
    if (until.kind === IcalDateKind.Utc) {
      // A zone shifts a wall date by under a day, so two days apart needs no zone maths.
      if (days + 2 <= untilDays) return true
      const instant = resolveInstant(make(date), { zone })
      const limit = resolveInstant(until)
      return instant !== undefined && limit !== undefined && instant <= limit
    }
    return `${date}T${start.time ?? `00:00:00`}` <= `${until.date}T${until.time ?? `23:59:59`}`
  }

  return ok({
    make,
    instant: (date) => dateOnly ? undefined : resolveInstant(make(date), { zone })?.getTime(),
    dateOnly,
    zone,
    walk(refDays, visit) {
      // COUNT needs every occurrence from the start counted; otherwise skip to near `refDays`.
      let k = rule.count === undefined ? firstPeriod(rule, startDays, refDays) : 0
      let seen = 0
      let emptyRun = 0
      while (emptyRun < SEARCH_LIMIT) {
        const days = periodDays(rule, startDays, k++, clip).filter((day) => day >= startDays)
        emptyRun = days.length === 0 ? emptyRun + 1 : 0
        for (const day of days) {
          const date = isoDate(day)
          if (date === undefined) return `ended`
          seen++
          if (rule.count !== undefined && seen > rule.count) return `ended`
          if (!withinUntil(date, day)) return `ended`
          if (visit(date, day)) return `found`
        }
      }
      return `limit`
    },
  })
}

const searchLimit = (): RruleResult<never> =>
  fail(RruleErrorCode.SearchLimit, `no occurrence found in ${SEARCH_LIMIT} periods in a row`)

// ---- next occurrence ---------------------------------------------------------------------------

/** Inputs of {@link nextOccurrence}. */
export interface NextOccurrenceOptions {
  /** The result is strictly after this instant (a date-only result: after its date). */
  after: Date
  /** The rule's `DTSTART` (for a task, its due or start date). The result has the same kind. */
  start: IcalDateValue
  /** IANA zone that reads `after` against date-only and floating values. Default `UTC`. */
  timeZone?: string
  /** How a plain monthly rule treats a month shorter than its day. Default {@link RruleMonthEnd.Clip}. */
  monthEnd?: RruleMonthEnd
}

/**
 * The first occurrence of `rule` strictly after `options.after`, as a value of the same kind
 * (and zone) as `options.start`, with the start's time of day. `output` is `null` when the rule
 * is exhausted by `COUNT` or `UNTIL`.
 *
 * To get the date Tasks.org gives a repeating task, pass the task's due date as both `start` and
 * `after`, even when the task is overdue: DTSTART is ignored and the result is the first
 * occurrence after the due date. The caller lowers `COUNT` by one on each completion, and the
 * series stops when it reaches 1 (`output` is then `null`). Tasks.org's "repeat after completion"
 * switch lives only on the phone and never appears in the VTODO; `completeTodo` counts from
 * completion for a task that says so itself, by starting the series again at the completion day.
 *
 * A `start` that does not match the rule is not itself an
 * occurrence; the series begins at the first day the rule selects on or after it.
 *
 * Fails with {@link RruleErrorCode.InvalidStart} when `start` is malformed or a zone is unknown,
 * and with {@link RruleErrorCode.SearchLimit} when the rule selects nothing within the search
 * limit (such as `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`).
 */
export function nextOccurrence(
  rule: Rrule,
  options: NextOccurrenceOptions,
): RruleResult<IcalDateValue | null> {
  const { after } = options
  const opened = openSeries(rule, options)
  if (!opened.success) return opened
  if (Number.isNaN(after.getTime())) {
    return fail(RruleErrorCode.InvalidStart, `unknown time zone or invalid instant`)
  }
  const series = opened.output
  const afterDate = isoDateInTz(after, series.zone)
  // `afterDate` is `after` read in `zone`, while a UTC or floating start's wall clock may lie up
  // to a day away from that; two days back is certainly before `after` whatever the kind.
  const afterDays = dayNumber(afterDate)
  // `after` reads past 9999-12-31 in `zone`: no occurrence comes after it.
  if (afterDays === undefined) return ok(null)
  const refDays = afterDays - 2
  let found: IcalDateValue | null = null
  const status = series.walk(refDays, (date, day) => {
    // Dates far before `after` are decided by comparing days; zone maths only runs near it.
    if (day < refDays) return false
    const isAfter = series.dateOnly
      ? date > afterDate
      : (series.instant(date) ?? -Infinity) > after.getTime()
    if (isAfter) found = series.make(date)
    return isAfter
  })
  return status === `limit` ? searchLimit() : ok(found)
}

// ---- occurrences in a range --------------------------------------------------------------------

/** Inputs of {@link occurrencesBetween}. */
export interface OccurrencesBetweenOptions {
  /** The rule's `DTSTART`. Every result has its kind, time of day and zone. */
  start: IcalDateValue
  /** The first instant of the range, included (a date-only result: its date in the zone). */
  from: Date
  /** The last instant of the range, included (a date-only result: its date in the zone). */
  to: Date
  /** IANA zone that reads `from` and `to` against date-only and floating values. Default `UTC`. */
  timeZone?: string
  /** The most occurrences returned; past it the result is {@link RruleErrorCode.SearchLimit}. Default 1,000. */
  limit?: number
  /** How a plain monthly rule treats a month shorter than its day. Default {@link RruleMonthEnd.Clip}. */
  monthEnd?: RruleMonthEnd
}

/** The default `limit` of {@link occurrencesBetween}. */
const RANGE_LIMIT = 1_000

/**
 * Every occurrence of `rule` from `options.from` to `options.to`, both included, in order, each a
 * value of the same kind (and zone) as `options.start` with the start's time of day. A zoned start
 * keeps its wall clock across a daylight-saving change: a weekly 09:00 in `Europe/Berlin` stays
 * 09:00 there. It steps the series the same way {@link nextOccurrence} does, so the two agree:
 * an occurrence is in the range exactly when `nextOccurrence` reaches it from before `from`.
 *
 * A range that ends before it starts is empty. More occurrences than `limit` fail with
 * {@link RruleErrorCode.SearchLimit}, never a cut list that looks complete; so does a rule that
 * selects nothing within the search limit. Fails with {@link RruleErrorCode.InvalidStart} for a
 * start, zone or instant it cannot use. Throws a `RangeError` when `limit` is not a positive
 * integer.
 */
export function occurrencesBetween(
  rule: Rrule,
  options: OccurrencesBetweenOptions,
): RruleResult<IcalDateValue[]> {
  const { from, to, limit = RANGE_LIMIT } = options
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`)
  }
  const opened = openSeries(rule, options)
  if (!opened.success) return opened
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return fail(RruleErrorCode.InvalidStart, `unknown time zone or invalid instant`)
  }
  if (to < from) return ok([])
  const series = opened.output
  const fromDate = isoDateInTz(from, series.zone)
  const toDate = isoDateInTz(to, series.zone)
  const fromDays = dayNumber(fromDate)
  // The range starts past 9999-12-31 in `zone`: nothing falls in it.
  if (fromDays === undefined) return ok([])
  const toDays = dayNumber(toDate) ?? LAST_DAY
  // As in `nextOccurrence`: a wall date lies under a day from the instant read in `zone`.
  const refDays = fromDays - 2
  const found: IcalDateValue[] = []
  let tooMany = false
  const status = series.walk(refDays, (date, day) => {
    if (day < refDays) return false
    if (day > toDays + 2) return true
    if (series.dateOnly) {
      if (date > toDate) return true
      if (date < fromDate) return false
    } else if (day < fromDays + 2 || day > toDays - 2) {
      // Only dates near either end need zone maths.
      const instant = series.instant(date)
      if (instant !== undefined && instant > to.getTime()) return true
      if (instant === undefined || instant < from.getTime()) return false
    }
    if (found.length === limit) {
      tooMany = true
      return true
    }
    found.push(series.make(date))
    return false
  })
  if (tooMany) {
    return fail(RruleErrorCode.SearchLimit, `more than ${limit} occurrences in the range`)
  }
  return status === `limit` ? searchLimit() : ok(found)
}

// ---- label ------------------------------------------------------------------------------------

/** A key of the catalogs in `./rrule-words/`, which `describeRrule` asks its words for. */
export type RruleWordKey = keyof typeof en

/**
 * The words {@link describeRrule} writes in. A `Translator` from `@spy4x/platform/universal/i18n`
 * fits, made with `createTranslator({ language, catalogs: [{ source: en, translation }] })` from
 * the catalogs `@spy4x/time/rrule-words/<language>` ships for en, ru, es, de, pt-BR, ar, fr, ja
 * and zh-CN; an app may add its own catalog on top for another language.
 */
export interface RruleWords {
  /** The BCP 47 tag `Intl` writes weekday and month names, lists, numbers and dates in. */
  readonly language: string
  /** The message for `key`, with `{name}` placeholders filled in; `count` picks the plural form. */
  t(key: RruleWordKey, values?: { readonly [name: string]: string | number }): string
}

type EnglishMessage = string | { readonly one: string; readonly other: string }

/** The default words: the English catalog, numbers as plain digits, as the label always read. */
const ENGLISH: RruleWords = {
  language: `en`,
  t(key, values = {}) {
    const message: EnglishMessage = en[key]
    const text = typeof message === `string`
      ? message
      : values.count === 1
      ? message.one
      : message.other
    return text.replace(
      /\{(\w+)\}/g,
      (whole, name: string) => Object.hasOwn(values, name) ? String(values[name]) : whole,
    )
  },
}

const FREQ_KEYS = [``, `daily`, `weekly`, `monthly`, `yearly`] as const
const UNIT_KEYS = [``, `days`, `weeks`, `months`, `years`] as const
const WEEKDAY_KEYS = [
  `monday`,
  `tuesday`,
  `wednesday`,
  `thursday`,
  `friday`,
  `saturday`,
  `sunday`,
] as const
const GENDERS = new Set([`masculine`, `feminine`, `neuter`])

/**
 * A label for the rule, such as `Every 2 weeks on Mon, Thu`, `Monthly on the last Friday` or
 * `Daily, 5 times`. It describes the rule only; the start value supplies the time of day and, when
 * the rule names no day, the day. `BYMONTHDAY=31` reads `on day 31` and `BYMONTHDAY=-1` reads
 * `on the last day`, so the two never look alike.
 *
 * Without `words` the label is English, worded as it always was. With `words` it is in that
 * translator's language, such as `Ежемесячно, 1-го числа`: weekday and month names come from `Intl`
 * through `./locale.ts`, lists from `Intl.ListFormat`, and `UNTIL` is written as `Intl` writes a
 * date in the language.
 */
export function describeRrule(rule: Rrule, words: RruleWords = ENGLISH): string {
  const { language } = words
  const t = (key: string, values?: { readonly [name: string]: string | number }) =>
    words.t(key as RruleWordKey, values)
  // The English label has always joined three items without a serial comma, as `en-GB` does.
  const fullList = new Intl.ListFormat(words === ENGLISH ? `en-GB` : language)
  const shortList = new Intl.ListFormat(language, { type: `conjunction`, style: `narrow` })
  const weekdays = weekdayLabels(language)
  const firstWeekday = localeFirstWeekday(language)
  const weekday = (day: RruleWeekday) => weekdays[(day - firstWeekday + 7) % 7]!
  const ordinalRules = new Intl.PluralRules(language, { type: `ordinal` })
  const ordinal = (n: number) => {
    const category = ordinalRules.select(n)
    const form = category === `one` || category === `two` || category === `few` ? category : `other`
    return t(`ordinalNumber.${form}`, { number: n })
  }

  let text = rule.interval === 1
    ? t(`freq.${FREQ_KEYS[rule.freq]}`)
    : t(`interval.${UNIT_KEYS[rule.freq]}`, { count: rule.interval })

  const hasOrdinal = rule.byDay.some((entry) => entry.ordinal !== undefined)
  if (hasOrdinal) {
    const days = rule.byDay.map((entry) => {
      const gender = t(`gender.${WEEKDAY_KEYS[entry.weekday - 1]}`)
      return t(`nth.${entry.ordinal ?? `every`}.${GENDERS.has(gender) ? gender : `masculine`}`, {
        weekday: weekday(entry.weekday).long,
      })
    })
    text = t(`on.nthWeekdays`, { rule: text, days: fullList.format(days) })
  } else if (rule.byDay.length) {
    const days = shortList.format(
      [...rule.byDay].sort((a, b) => a.weekday - b.weekday).map((entry) =>
        weekday(entry.weekday).short
      ),
    )
    text = t(rule.freq === RruleFreq.Weekly ? `on.weekdays` : `on.everyWeekday`, {
      rule: text,
      days,
    })
  }
  if (rule.byMonthDay.length) {
    const days = fullList.format(
      [...rule.byMonthDay].sort((a, b) => (a > 0 === b > 0 ? a - b : b - a)).map((n) =>
        n === -1
          ? t(`monthDay.last`)
          : n < 0
          ? t(`monthDay.fromEnd`, { nth: ordinal(-n) })
          : t(`monthDay`, { day: n })
      ),
    )
    text = t(rule.byDay.length ? `when.monthDays` : `on.monthDays`, { rule: text, days })
  }
  if (rule.byMonth.length) {
    const names = monthLabels(language)
    const months = shortList.format(
      [...rule.byMonth].sort((a, b) => a - b).map((month) => names[month - 1]!.short),
    )
    text = t(`in.months`, { rule: text, months })
  }
  if (rule.count !== undefined) text = t(`count`, { rule: text, count: rule.count })
  if (rule.until) {
    const { date } = rule.until
    text = t(`until`, { rule: text, date: words === ENGLISH ? date : untilLabel(date, language) })
  }
  return text
}

/** `UNTIL`'s date as the language writes it, or as it stands when `Intl` cannot read it. */
function untilLabel(date: string, language: string): string {
  try {
    return dayLabel(date, language)
  } catch {
    return date
  }
}
