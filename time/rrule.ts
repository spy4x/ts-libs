/**
 * Repeat rules (RFC 5545 `RRULE`) for the subset Tasks.org writes, with a typed refusal for
 * everything else.
 *
 * {@link parseRrule} accepts `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYDAY` with
 * ordinals (`2MO`, `-1FR`), `BYMONTHDAY`, `BYMONTH`, `COUNT`, `UNTIL` and `WKST`. Any other part
 * (`BYSETPOS`, `BYHOUR`, `FREQ=HOURLY`, a vendor `X-` part) is refused with the part's name, so an
 * app can say "complete this one in Tasks.org" instead of guessing. {@link nextOccurrence} steps
 * the wall clock of the start value and keeps its kind (date, floating, UTC, zoned); zone maths
 * go through `./tz.ts`. {@link describeRrule} gives an English label.
 *
 * A date a month does not have (the 31st in April, 29 February in a common year) is skipped, as
 * RFC 5545 section 3.3.10 requires, with one exception that follows Tasks.org: a plain monthly
 * rule (no `BYDAY`, no `BYMONTH`, no `BYMONTHDAY` or one positive day) moves the start by
 * `INTERVAL` months and uses the month's last day when the start's day is missing, so 31 January
 * is followed by 28 February. A wall clock a zone skips (a spring-forward
 * gap) is kept: the occurrence keeps its date and wall clock, which `resolveInstant` shifts
 * forward, so a task due at 02:30 is not lost on that day.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`, no dependencies.
 * @module
 */

import { IcalDateKind, type IcalDateValue, resolveInstant } from "./ical.ts"
import { isoDateInTz, isValidTimeZone } from "./tz.ts"

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

function toDays(year: number, month: number, day: number): number {
  const t = new Date(0)
  t.setUTCFullYear(year, month - 1, day)
  return Math.round(t.getTime() / MS_PER_DAY)
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

function pad(n: number, width: number): string {
  return String(n).padStart(width, `0`)
}

function isoDate(days: number): string | undefined {
  const { year, month, day } = fromDays(days)
  return year < 1 || year > 9999 ? undefined : `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

function parseIsoDate(date: string): number {
  return toDays(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)))
}

// ---- candidate days of one period --------------------------------------------------------------

function dayMatches(rule: Rrule, days: number): boolean {
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

/** Tasks.org's plain monthly shape: start plus INTERVAL months, clipped to the month's end. */
function clipsMonthEnd(rule: Rrule): boolean {
  return rule.freq === RruleFreq.Monthly && rule.byDay.length === 0 && rule.byMonth.length === 0 &&
    (rule.byMonthDay.length === 0 || (rule.byMonthDay.length === 1 && rule.byMonthDay[0]! > 0))
}

/** The day numbers period `k` of the rule selects, ascending. */
function periodDays(rule: Rrule, startDays: number, k: number): number[] {
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
      if (clipsMonthEnd(rule)) {
        return [toDays(year, month, Math.min(start.day, daysInMonth(year, month)))]
      }
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

// ---- next occurrence ---------------------------------------------------------------------------

/** Inputs of {@link nextOccurrence}. */
export interface NextOccurrenceOptions {
  /** The result is strictly after this instant (a date-only result: after its date). */
  after: Date
  /** The rule's `DTSTART` (for a task, its due or start date). The result has the same kind. */
  start: IcalDateValue
  /** IANA zone that reads `after` against date-only and floating values. Default `UTC`. */
  timeZone?: string
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
 * switch lives only on the phone and never appears in the VTODO, so it cannot be honoured here.
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
  const { start, after } = options
  const zone = start.kind === IcalDateKind.Zoned ? start.tzid : options.timeZone ?? `UTC`
  const dateOnly = start.kind === IcalDateKind.Date
  if (
    !Object.values(IcalDateKind).includes(start.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(start.date) ||
    (dateOnly ? start.time !== undefined : !/^\d{2}:\d{2}:\d{2}$/.test(start.time ?? ``)) ||
    (start.kind === IcalDateKind.Zoned) !== (start.tzid !== undefined)
  ) return fail(RruleErrorCode.InvalidStart, `start is not a well-formed value`)
  if (!zone || !isValidTimeZone(zone) || Number.isNaN(after.getTime())) {
    return fail(RruleErrorCode.InvalidStart, `unknown time zone or invalid instant`)
  }
  const startDays = parseIsoDate(start.date)
  if (isoDate(startDays) !== start.date) {
    return fail(RruleErrorCode.InvalidStart, `${start.date} is not a calendar date`)
  }

  const make = (date: string): IcalDateValue => {
    const value: IcalDateValue = { kind: start.kind, date }
    if (start.time !== undefined) value.time = start.time
    if (start.tzid !== undefined) value.tzid = start.tzid
    return value
  }
  const afterDate = isoDateInTz(after, zone)
  const isAfter = (date: string): boolean => {
    if (dateOnly) return date > afterDate
    const instant = resolveInstant(make(date), { zone })
    return instant !== undefined && instant.getTime() > after.getTime()
  }
  const until = rule.until
  const untilDays = until ? parseIsoDate(until.date) : 0
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

  // COUNT needs every occurrence from the start counted; otherwise skip to near `after`.
  // `afterDate` is `after` read in `zone`, while a UTC or floating start's wall clock may lie up
  // to a day away from that; two days back is certainly before `after` whatever the kind.
  const refDays = parseIsoDate(afterDate) - 2
  let k = rule.count === undefined ? firstPeriod(rule, startDays, refDays) : 0
  let seen = 0
  let emptyRun = 0
  while (emptyRun < SEARCH_LIMIT) {
    const days = periodDays(rule, startDays, k++).filter((day) => day >= startDays)
    emptyRun = days.length === 0 ? emptyRun + 1 : 0
    for (const day of days) {
      const date = isoDate(day)
      if (date === undefined) return ok(null)
      seen++
      if (rule.count !== undefined && seen > rule.count) return ok(null)
      if (!withinUntil(date, day)) return ok(null)
      // Dates far before `after` are decided by comparing days; zone maths only runs near it.
      if (day >= refDays && isAfter(date)) return ok(make(date))
    }
  }
  return fail(RruleErrorCode.SearchLimit, `no occurrence found in ${SEARCH_LIMIT} periods in a row`)
}

// ---- English label -----------------------------------------------------------------------------

const WEEKDAY_NAMES = [`Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun`]
const WEEKDAY_LONG = [`Monday`, `Tuesday`, `Wednesday`, `Thursday`, `Friday`, `Saturday`, `Sunday`]
const MONTH_NAMES = [
  `Jan`,
  `Feb`,
  `Mar`,
  `Apr`,
  `May`,
  `Jun`,
  `Jul`,
  `Aug`,
  `Sep`,
  `Oct`,
  `Nov`,
  `Dec`,
]
const ORDINAL_WORDS = [`first`, `second`, `third`, `fourth`, `fifth`]

function joinAnd(items: string[]): string {
  return items.length < 2
    ? items.join(``)
    : `${items.slice(0, -1).join(`, `)} and ${items[items.length - 1]}`
}

function ordinalWord(n: number): string {
  return n > 0 ? ORDINAL_WORDS[n - 1]! : n === -1 ? `last` : `${ORDINAL_WORDS[-n - 1]} to last`
}

function ordinalNumber(n: number): string {
  const tail = n % 100
  const suffix = tail >= 11 && tail <= 13 ? `th` : ([`th`, `st`, `nd`, `rd`][n % 10] ?? `th`)
  return `${n}${suffix}`
}

/**
 * An English label for the rule, such as `Every 2 weeks on Mon, Thu`, `Monthly on the last
 * Friday` or `Daily, 5 times`. It describes the rule only; the start value supplies the time of
 * day and, when the rule names no day, the day.
 */
export function describeRrule(rule: Rrule): string {
  const unit = [``, `day`, `week`, `month`, `year`][rule.freq]!
  const every = rule.interval === 1
    ? [``, `Daily`, `Weekly`, `Monthly`, `Yearly`][rule.freq]!
    : `Every ${rule.interval} ${unit}s`
  let text = every
  const monthDay = rule.byMonthDay.length
    ? joinAnd(
      [...rule.byMonthDay].sort((a, b) => (a > 0 === b > 0 ? a - b : b - a)).map((n) =>
        n === -1 ? `the last day` : n < 0 ? `the ${ordinalNumber(-n)} to last day` : `day ${n}`
      ),
    )
    : ``
  const hasOrdinal = rule.byDay.some((entry) => entry.ordinal !== undefined)
  if (hasOrdinal) {
    const days = rule.byDay.map((entry) =>
      entry.ordinal === undefined
        ? `every ${WEEKDAY_LONG[entry.weekday - 1]}`
        : `the ${ordinalWord(entry.ordinal)} ${WEEKDAY_LONG[entry.weekday - 1]}`
    )
    text += ` on ${joinAnd(days)}`
  } else if (rule.byDay.length) {
    const names = [...rule.byDay].sort((a, b) => a.weekday - b.weekday)
      .map((entry) => WEEKDAY_NAMES[entry.weekday - 1]!)
    text += rule.freq === RruleFreq.Weekly
      ? ` on ${names.join(`, `)}`
      : ` on every ${names.join(`, `)}`
  }
  if (monthDay) text += rule.byDay.length ? ` when it is ${monthDay}` : ` on ${monthDay}`
  if (rule.byMonth.length) {
    text += ` in ${
      [...rule.byMonth].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]).join(`, `)
    }`
  }
  if (rule.count !== undefined) text += `, ${rule.count} ${rule.count === 1 ? `time` : `times`}`
  if (rule.until) text += `, until ${rule.until.date}`
  return text
}
