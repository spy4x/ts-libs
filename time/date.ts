/**
 * Calendar arithmetic on plain `YYYY-MM-DD` dates — no zone, no clock, no locale.
 *
 * An ISO date carries no zone, so day, month, quarter and year arithmetic is fixed-step UTC maths
 * that cannot drift across a DST boundary. Which calendar date an instant falls on in a zone is a
 * different question, answered by `isoDateInTz` in `./tz.ts`; everything here starts from a date
 * that question already produced. `addDays` lives in `./tz.ts` too: called without a zone it is the
 * zone-free step this module's functions take.
 *
 * Every function rejects a value the calendar does not have — `2026-02-31`, `2026-13-01` — rather
 * than rolling it into a neighbouring day, and every answer is a real `YYYY-MM-DD` date or a throw.
 *
 * Supported window: the four-digit ISO years 0001–9999. Two escapes are named rather than implied:
 *
 * - Year 0000 is accepted. `Date` keeps it as a four-digit year, so {@link parseIsoDate} and
 *   {@link formatIsoDate} round-trip it, and {@link shiftMonth} answers `0000-12-01` for the month
 *   before `0001-01-01` rather than rejecting it. ISO 8601 calls it 1 BC; `Intl` calls it year 1
 *   of the BC era, so `isoDateInTz` pads an instant in it to `0001-…`. Nothing here detects that.
 * - A step past `9999-12-31` throws: {@link formatIsoDate} refuses the six-digit year `Date` writes
 *   there, and {@link shiftMonth} checks its own answer the same way. `endOfMonth("9999-12-15")`
 *   therefore throws, because it asks for the day before `10000-01-01`.
 */

/** Milliseconds in one UTC calendar day. */
const MS_PER_DAY = 86_400_000

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Inclusive calendar range; both ends are `YYYY-MM-DD`. */
export interface DateRange {
  /** First day of the range, inclusive. */
  from: string
  /** Last day of the range, inclusive. */
  to: string
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/**
 * A year as `Date` writes it into an ISO string: four digits inside `0000…9999`, and six digits
 * with a sign outside it (`+010000`, `-000001`). {@link shiftMonth} builds its answer from this so
 * that a year outside the window fails the same {@link ISO_DATE_PATTERN} test `formatIsoDate`'s
 * output would.
 */
function paddedYear(year: number): string {
  if (year >= 10000) return `+${String(year).padStart(6, "0")}`
  if (year < 0) return `-${String(-year).padStart(6, "0")}`
  return String(year).padStart(4, "0")
}

/**
 * Midnight UTC of a calendar date, in milliseconds.
 *
 * Rejects anything a calendar would reject, so a bad value fails at the boundary instead of
 * producing a plausible wrong day. `Date.parse` alone is not enough: it returns `NaN` for
 * `2026-13-01` but silently rolls `2026-02-31` into March and `2026-02-29` into 1 March of a
 * non-leap year. The round trip through {@link formatIsoDate} is what makes the day real.
 *
 * @throws When `date` is not a `YYYY-MM-DD` date the calendar has.
 */
export function parseIsoDate(date: string): number {
  if (!ISO_DATE_PATTERN.test(date)) {
    throw new Error(`expected a YYYY-MM-DD date, received: ${date}`)
  }
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms) || formatIsoDate(ms) !== date) {
    throw new Error(`expected a YYYY-MM-DD date, received: ${date}`)
  }
  return ms
}

/**
 * The `YYYY-MM-DD` calendar date of midnight-UTC milliseconds.
 *
 * Throws rather than returning half of a date: `toISOString` switches to a signed six-digit year
 * outside the four-digit window — `+010000-01-01` past 9999, `-000001-06-15` in 1 BC — and a bare
 * `slice(0, 10)` would return `+010000-01`. Adding a day to 9999-12-31 is the ordinary way there.
 *
 * @param ms Milliseconds since the Unix epoch, in UTC.
 * @throws When `ms` is an invalid instant, or `Date` writes its year with a sign.
 */
export function formatIsoDate(ms: number): string {
  const iso = new Date(ms).toISOString()
  if (!/^\d{4}-\d{2}-/.test(iso)) {
    throw new Error(`expected a date in the 0001-9999 window, received: ${iso.slice(0, 10)}`)
  }
  return iso.slice(0, 10)
}

/**
 * The first day of the month `months` away from `date`.
 *
 * Month arithmetic, not day arithmetic: "one month before 31 March" has to land on 1 February,
 * which adding 28, 30 or 31 days cannot guarantee. The answer is checked against the supported
 * window before it is returned, so one month past `9999-12` throws instead of answering
 * `10000-01-01`, a five-digit string that looks like a date and is not one.
 *
 * @param date An existing `YYYY-MM-DD` date.
 * @param months Months to step, negative to go back.
 * @returns The first day of the target month, `YYYY-MM-DD`.
 * @throws On a `date` that is not a `YYYY-MM-DD` date, and on a target month outside the window.
 */
export function shiftMonth(date: string, months: number): string {
  const iso = formatIsoDate(parseIsoDate(date))
  const total = Number(iso.slice(0, 4)) * 12 + (Number(iso.slice(5, 7)) - 1) + months
  const year = Math.floor(total / 12)
  const result = `${paddedYear(year)}-${pad2(total - year * 12 + 1)}-01`
  if (!ISO_DATE_PATTERN.test(result)) {
    throw new Error(`expected a date in the 0001-9999 window, received: ${result.slice(0, 10)}`)
  }
  return result
}

/** First day of the month `date` falls in. */
export function startOfMonth(date: string): string {
  return `${formatIsoDate(parseIsoDate(date)).slice(0, 7)}-01`
}

/** Last day of the month `date` falls in — 28, 29, 30 or 31, leap year included. */
export function endOfMonth(date: string): string {
  return formatIsoDate(parseIsoDate(shiftMonth(date, 1)) - MS_PER_DAY)
}

/** How many days the month `date` falls in has. */
export function daysInMonth(date: string): number {
  return Number(endOfMonth(date).slice(8, 10))
}

/**
 * The same day number in the month `date` falls in, clipped to that month's length.
 *
 * What moving a calendar cursor from 31 January into February needs: February has no 31st, so the
 * nearest day that exists is the 28th or the 29th.
 *
 * @param date Any date in the target month.
 * @param dayNumber The day wanted, 1-based, a whole number. Below 1 clips to the 1st.
 * @returns That day in the target month, clipped to the month's first and last day.
 * @throws When `dayNumber` is not a whole number (`NaN`, `15.5`, `Infinity`), which names no day,
 *   and when `date` is not a `YYYY-MM-DD` date.
 */
export function dayInMonth(date: string, dayNumber: number): string {
  if (!Number.isInteger(dayNumber)) {
    throw new Error(`expected a whole day number, received: ${dayNumber}`)
  }
  const clipped = Math.min(Math.max(dayNumber, 1), daysInMonth(date))
  return `${startOfMonth(date).slice(0, 8)}${pad2(clipped)}`
}

/**
 * Weekday of the first of `date`'s month, counted from the week's own first day.
 *
 * The answer is how many leading cells a weekday-aligned month grid needs before the 1st: `0` when
 * the month opens on the week's first day, `6` when it opens on its last. A weekday computed in UTC
 * is the same weekday in every zone, because a calendar date has no zone.
 *
 * @param date Any date in the month.
 * @param firstWeekday The week's first day, `1` = Monday … `7` = Sunday, as `Intl` numbers them.
 * `localeFirstWeekday` in `./locale.ts` reads it from a locale.
 */
export function monthFirstWeekday(date: string, firstWeekday = 1): number {
  const sundayFirst = new Date(parseIsoDate(startOfMonth(date))).getUTCDay()
  return (sundayFirst - (firstWeekday % 7) + 7) % 7
}

/** First day of the calendar quarter `date` falls in. */
export function startOfQuarter(date: string): string {
  const month = Number(formatIsoDate(parseIsoDate(date)).slice(5, 7))
  return shiftMonth(date, -((month - 1) % 3))
}

/** Last day of the calendar quarter `date` falls in. */
export function endOfQuarter(date: string): string {
  return formatIsoDate(parseIsoDate(shiftMonth(startOfQuarter(date), 3)) - MS_PER_DAY)
}

/** First day of the calendar year `date` falls in. */
export function startOfYear(date: string): string {
  return `${formatIsoDate(parseIsoDate(date)).slice(0, 4)}-01-01`
}

/** Last day of the calendar year `date` falls in. */
export function endOfYear(date: string): string {
  return `${formatIsoDate(parseIsoDate(date)).slice(0, 4)}-12-31`
}

/** Whether two values name the same calendar day. Throws on a value that is not a date. */
export function isSameDay(a: string, b: string): boolean {
  return parseIsoDate(a) === parseIsoDate(b)
}

/**
 * Whether a range is two real dates in order.
 *
 * One day is a valid range; a reversed or unparsable one is not. Returns `false` rather than
 * throwing, because a caller uses it to gate a button on half-typed input, or a server uses it to
 * answer 400 on a query string.
 */
export function isValidDateRange(range: DateRange): boolean {
  try {
    return parseIsoDate(range.from) <= parseIsoDate(range.to)
  } catch {
    return false
  }
}
