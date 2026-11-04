/**
 * Calendar weeks and months as inclusive `YYYY-MM-DD` ranges, cut in a time zone.
 *
 * "Which month is it" depends on where the question is asked: at 2026-10-31T17:30Z it is already
 * November in Ho Chi Minh City and still October in Berlin. {@link currentPeriod} answers it for one
 * zone from a `now` the caller passes in, so a server total and the month a screen shows cover the
 * same days. Everything after that first step works on plain dates, which have no zone, so stepping
 * across a year or a daylight-saving change can neither lose nor double a day.
 *
 * Out of scope: quarters, years and months that start on a day other than the 1st.
 */

import {
  type DateRange,
  endOfMonth,
  parseIsoDate,
  shiftMonth,
  startOfMonth,
  startOfWeek,
} from "./date.ts"
import { monthLabel } from "./locale.ts"
import { addDays, isoDateInTz } from "./tz.ts"

/** Milliseconds in one UTC calendar day. */
const MS_PER_DAY = 86_400_000

/** The length of a period. */
export enum PeriodUnit {
  /** Seven days from the week's first day. */
  Week = 1,
  /** A calendar month, from the 1st to its last day. */
  Month,
}

/** A week or a month: an inclusive range of `YYYY-MM-DD` dates and the unit it spans. */
export interface Period extends DateRange {
  /** Whether the range is a week or a month. */
  unit: PeriodUnit
}

/** How a week is laid out. */
export interface PeriodOptions {
  /**
   * The week's first day, `1` = Monday … `7` = Sunday, as `startOfWeek` and `Intl` number them.
   * `localeFirstWeekday` in `./locale.ts` reads it from a locale. Default: Monday. A month ignores it.
   */
  firstWeekday?: number
}

/** The instant and the zone that decide which calendar date "today" is. */
export interface PeriodNow {
  /** The current instant, passed in so the answer never depends on the host clock. */
  now: Date
  /** The IANA zone whose calendar is read, e.g. `Asia/Ho_Chi_Minh`. */
  timeZone: string
}

function checkUnit(unit: PeriodUnit): void {
  if (unit !== PeriodUnit.Week && unit !== PeriodUnit.Month) {
    throw new RangeError(`Unknown period unit: ${unit}`)
  }
}

function checkFirstWeekday(firstWeekday: number): void {
  if (!Number.isInteger(firstWeekday) || firstWeekday < 1 || firstWeekday > 7) {
    throw new RangeError(`firstWeekday must be a whole number from 1 to 7, got ${firstWeekday}`)
  }
}

/**
 * The week or month that contains a calendar date.
 *
 * `periodOf(PeriodUnit.Week, "2026-11-01")` is Monday 26 October to Sunday 1 November; with
 * `{ firstWeekday: 7 }` it is Sunday 1 November to Saturday 7 November.
 *
 * @param unit Week or month.
 * @param date An existing `YYYY-MM-DD` date.
 * @param options The week's first day; a month ignores it.
 * @throws {RangeError} On an unknown `unit`, or a `firstWeekday` that is not a whole number 1–7.
 * @throws When `date` is not a `YYYY-MM-DD` date the calendar has.
 */
export function periodOf(unit: PeriodUnit, date: string, options: PeriodOptions = {}): Period {
  checkUnit(unit)
  if (unit === PeriodUnit.Month) {
    return { unit, from: startOfMonth(date), to: endOfMonth(date) }
  }
  const firstWeekday = options.firstWeekday ?? 1
  checkFirstWeekday(firstWeekday)
  const from = startOfWeek(date, firstWeekday)
  return { unit, from, to: addDays(from, 6) }
}

/**
 * The week or month that contains today in `timeZone`.
 *
 * @param unit Week or month.
 * @param options `now`, `timeZone` and the week's first day.
 * @throws {RangeError} On an unknown `unit`, a bad `firstWeekday`, or a zone `Intl` does not know.
 */
export function currentPeriod(unit: PeriodUnit, options: PeriodNow & PeriodOptions): Period {
  return periodOf(unit, isoDateInTz(options.now, options.timeZone), options)
}

/**
 * The period `steps` before or after `period`, of the same unit.
 *
 * A month steps by calendar months, so the month after January is all of February. A week steps by
 * seven days from its own first day, so it keeps the first weekday it was made with.
 *
 * @param period A period from {@link periodOf} or a function built on it.
 * @param steps Periods to move, a whole number, negative to go back.
 * @throws {RangeError} On an unknown unit, or a `steps` that is not a whole number.
 * @throws When the answer falls outside the `0001`–`9999` years `./date.ts` supports.
 */
export function shiftPeriod(period: Period, steps: number): Period {
  checkUnit(period.unit)
  if (!Number.isSafeInteger(steps)) {
    throw new RangeError(`steps must be a whole number, got ${steps}`)
  }
  if (period.unit === PeriodUnit.Month) {
    return periodOf(PeriodUnit.Month, shiftMonth(period.from, steps))
  }
  const from = addDays(period.from, steps * 7)
  return { unit: period.unit, from, to: addDays(from, 6) }
}

/**
 * The part of `period` up to and including today in `timeZone`: "this month so far".
 *
 * A period that has ended comes back whole. A period that has not started has no days so far and
 * comes back as `null`, because an inclusive range cannot be empty.
 *
 * @param period The period to cut.
 * @param options `now` and `timeZone`.
 * @throws {RangeError} On a zone `Intl` does not know.
 */
export function periodSoFar(period: Period, options: PeriodNow): Period | null {
  const today = isoDateInTz(options.now, options.timeZone)
  if (parseIsoDate(today) < parseIsoDate(period.from)) return null
  if (parseIsoDate(today) >= parseIsoDate(period.to)) return { ...period }
  return { ...period, to: today }
}

/**
 * The same number of days as `soFar` at the start of `other`, to compare like with like: 1 to 3
 * November against 1 to 3 October. When `other` is shorter, the answer stops at its last day, so
 * all of March compares with all of February.
 *
 * @param other The period to cut, usually the one before (`shiftPeriod(period, -1)`).
 * @param soFar The range whose length is matched, usually from {@link periodSoFar}.
 * @throws When either range holds a value that is not a `YYYY-MM-DD` date.
 */
export function samePartOf(other: Period, soFar: DateRange): Period {
  const days = (parseIsoDate(soFar.to) - parseIsoDate(soFar.from)) / MS_PER_DAY
  const to = addDays(other.from, days)
  return { ...other, to: parseIsoDate(to) < parseIsoDate(other.to) ? to : other.to }
}

/**
 * The period as a person reads it in their region format: "November 2026" for a month, and
 * "2–8 Nov 2026" or "26 Oct – 1 Nov 2026" for a week, through `Intl.DateTimeFormat`'s
 * `formatRange`, which drops the parts both ends share.
 *
 * @param period The period to name.
 * @param locale A BCP 47 tag, e.g. `en-US`. Default: `en-GB`, as in `./locale.ts`.
 * @throws {RangeError} On an unknown unit or a tag `Intl` cannot read.
 */
export function periodLabel(period: Period, locale = "en-GB"): string {
  checkUnit(period.unit)
  if (period.unit === PeriodUnit.Month) return monthLabel(period.from, locale)
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(parseIsoDate(period.from), parseIsoDate(period.to))
}
