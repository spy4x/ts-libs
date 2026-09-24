/**
 * Calendar-date helpers: format a date, accept only a real calendar date, and read a
 * weekday bitmask.
 *
 * No host-`TZ`-dependent assertion lives behind these — every one is a pure function of its
 * arguments, and the two date-formatting entry points take an explicit IANA time zone.
 */

/**
 * Weekday names indexed Monday-first, matching {@link getDaysOfWeek}'s bitmask order.
 *
 * Exported as a mutable-in-name-only array for callers that need the labels; {@link DAY_OF_WEEK}
 * is the same list as a string-literal union for `interface` fields.
 */
export const DAYS_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

/** Weekday identifier, Monday-first. */
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

/**
 * Read a weekday bitmask into day names.
 *
 * `"1000001"` is Monday and Sunday. Positions beyond the seven names are ignored, and a missing
 * digit is treated as `0`, so a short mask does not throw.
 */
export function getDaysOfWeek(daysOfWeek: string): string[] {
  if (!daysOfWeek) return []
  return Array.from(daysOfWeek).reduce<string[]>((accum, day, i) => {
    const name = DAYS_OF_WEEK[i]
    if (day === "1" && name !== undefined) accum.push(name)
    return accum
  }, [])
}

const ISO_CALENDAR_PREFIX = /^\d{4}-\d{2}-\d{2}/
const CALENDAR_DATE = /^(\d{4})[.-](\d{2})[.-](\d{2})$/

/**
 * Whether the input is a usable date: a `Date` or an ISO `YYYY-MM-DD`-prefixed string that
 * `Date` can parse.
 *
 * A string-only check — an arbitrary object with a `getTime` is not accepted. Note this does NOT
 * reject impossible dates such as `"2023-02-30"`, because `new Date` rolls those over; use
 * {@link normalizeCalendarDate} when a real calendar date is required.
 */
export function isValidDate(input: unknown): boolean {
  if (input instanceof Date) return !Number.isNaN(input.getTime())
  return typeof input === "string" && ISO_CALENDAR_PREFIX.test(input) &&
    !Number.isNaN(new Date(input).getTime())
}

/**
 * Normalise `YYYY.MM.DD` or `YYYY-MM-DD` to `YYYY-MM-DD`, rejecting impossible dates.
 *
 * Leap years are resolved properly (`2000-02-29` and `2024-02-29` pass; `1900-02-29` and
 * `2023-02-29` do not), which `Date` parsing would silently roll over into March.
 *
 * @returns the normalised date, or `null` when the input is not a real calendar date.
 */
export function normalizeCalendarDate(value: string): string | null {
  const match = CALENDAR_DATE.exec(value.trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return null

  const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day > daysInMonth[month - 1]) return null

  return `${match[1]}-${match[2]}-${match[3]}`
}

/** Options for {@link formatTime}. */
export interface FormatTimeOptions {
  /** Always include the date, even for today. */
  full?: boolean
  /** Return only `HH:MM`. */
  timeOnly?: boolean
  /** IANA zone, e.g. `"Europe/Berlin"`. Defaults to the host zone. */
  timeZone?: string
}

/**
 * Injectable time source, so formatting and relative times are testable without a frozen host.
 *
 * The one home for the object-shaped clock (`#71`): `platform/server/ports.ts`'s `ClockPort` is
 * now an alias of this type, and `realtime/clock.ts`'s `Clock` extends it with timer methods.
 * `platform/rate-limit/memory.ts` also used to export its own function-shaped clock
 * (`() => number`) under the same names, `Clock`/`systemClock` — a different shape that this
 * extraction cannot merge into the interface above without breaking a 1.x caller of one shape or
 * the other. {@link NowFn}/{@link systemNow} below are that shape's home instead; that module's
 * `Clock`/`systemClock` are now the same type as, and delegate to, these.
 */
export interface Clock {
  /** Current instant in epoch milliseconds. */
  now(): number
}

/** The host clock. The only place `Date.now()` is read in this package. */
export const systemClock: Clock = { now: () => Date.now() }

/**
 * Monotonic millisecond clock, function-shaped rather than object-shaped — the home for the
 * `() => number` clock shape (`#71`), which cannot be merged into {@link Clock} without breaking
 * a 1.x caller of one shape or the other. `platform/rate-limit/memory.ts`'s `Clock` is now the
 * same type as this one.
 */
export type NowFn = () => number

/**
 * The host clock, function-shaped. `platform/rate-limit/memory.ts`'s `systemClock` now delegates
 * to this constant.
 */
export const systemNow: NowFn = () => Date.now()

/** Locale and zone applied by {@link formatTime} and {@link timeAgo}. */
export interface TimeFormatOptions {
  /** IANA zone for the calendar day and clock time. Defaults to the host zone. */
  timeZone?: string
  /** BCP-47 tag. Defaults to `"en-GB"`, i.e. `DD/MM/YYYY` and 24-hour time. */
  locale?: string
}

const DEFAULT_LOCALE = "en-GB"

/**
 * Format an instant for display.
 *
 * Default form is `"Today 14:30"` when the instant falls on the current calendar day in the
 * target zone, otherwise `"12/03/2023 14:30"`. `full` forces the dated form; `timeOnly` returns
 * `HH:MM` alone. `null`, `undefined`, `0` and `""` render as `"-"`.
 *
 * The result depends on the time zone, so it is deliberately NOT reachable without one:
 * construct the formatter with an explicit `timeZone` to get a host-independent string.
 */
export class TimeFormatter {
  readonly #clock: Clock
  readonly #timeZone?: string
  readonly #locale: string

  constructor(options: { clock?: Clock } & TimeFormatOptions = {}) {
    this.#clock = options.clock ?? systemClock
    this.#timeZone = options.timeZone
    this.#locale = options.locale ?? DEFAULT_LOCALE
  }

  /** `HH:MM` in the given zone, or in the instance's zone when none is given. */
  timeOf(date: Date, timeZone?: string): string {
    return this.#timeOf(date, timeZone ?? this.#timeZone)
  }

  #timeOf(date: Date, timeZone?: string): string {
    return date.toLocaleTimeString(this.#locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    })
  }

  /**
   * Calendar-only comparison in one zone, so "today" never depends on the host's zone.
   *
   * Built from `formatToParts` rather than a `toLocaleDateString` string: the rendered string
   * depends on the locale's field order, which would make "same day" a locale question.
   */
  static #isSameDayInZone(a: Date, b: Date, timeZone?: string): boolean {
    const calendarDay = (date: Date): string => {
      const parts = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone,
      }).formatToParts(date)
      const field = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
      return `${field("year")}-${field("month")}-${field("day")}`
    }
    return calendarDay(a) === calendarDay(b)
  }

  /**
   * Format an instant using this instance's zone and locale.
   *
   * `options.timeZone` overrides the instance zone for this call only.
   */
  format(
    date: undefined | null | number | string | Date,
    options: FormatTimeOptions = {},
  ): string {
    if (date === undefined || date === null || date === "" || date === 0) return "-"
    const target = new Date(date)
    if (Number.isNaN(target.getTime())) return "-"

    // The effective zone governs the clock time AND the "today" comparison: a per-call override
    // that only moved the clock but kept the instance's day would render "Today 18:05" for
    // yesterday.
    const timeZone = options.timeZone ?? this.#timeZone
    const clockTime = this.#timeOf(target, timeZone)
    if (options.timeOnly) return clockTime

    const isToday = TimeFormatter.#isSameDayInZone(
      target,
      new Date(this.#clock.now()),
      timeZone,
    )

    if (isToday && !options.full) return `Today ${clockTime}`

    const day = target.toLocaleDateString(this.#locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone,
    })
    return `${day} ${clockTime}`
  }

  /**
   * Coarse relative time. Buckets: `"a moment ago"` under 10s, then seconds, minutes, hours,
   * days (up to 30), months (30-day months, up to 12) and years.
   *
   * Buckets are approximate by design — a "month" is 30 days and a "year" is 365 days.
   */
  ago(date: null | undefined | number | string | Date): string {
    if (date === null || date === undefined || date === "") return "-"
    const target = new Date(date)
    if (Number.isNaN(target.getTime())) return "-"
    const secondsPast = Math.floor((this.#clock.now() - target.getTime()) / 1000)

    if (secondsPast < 10) return "a moment ago"
    if (secondsPast < 60) return `${secondsPast} ${plural(secondsPast, "second")}`
    const minutesPast = Math.floor(secondsPast / 60)
    if (minutesPast < 60) return `${minutesPast} ${plural(minutesPast, "minute")}`
    const hoursPast = Math.floor(minutesPast / 60)
    if (hoursPast < 24) return `${hoursPast} ${plural(hoursPast, "hour")}`
    const daysPast = Math.floor(hoursPast / 24)
    if (daysPast < 30) return `${daysPast} ${plural(daysPast, "day")}`
    const monthsPast = Math.floor(daysPast / 30)
    if (monthsPast < 12) return `${monthsPast} ${plural(monthsPast, "month")}`
    const yearsPast = Math.floor(daysPast / 365)
    return `${yearsPast} ${plural(yearsPast, "year")}`
  }
}

function plural(count: number, unit: string): string {
  return count === 1 ? `${unit} ago` : `${unit}s ago`
}

/**
 * One-off {@link TimeFormatter#format} on the host clock.
 *
 * Pass `options.timeZone` whenever the output is asserted or cached — without it the result
 * follows the host zone and is not reproducible.
 */
export function formatTime(
  date: undefined | null | number | string | Date,
  options: FormatTimeOptions & TimeFormatOptions & { clock?: Clock } = {},
): string {
  const { clock, timeZone, locale, ...format } = options
  return new TimeFormatter({ clock, timeZone, locale }).format(date, format)
}

/** One-off {@link TimeFormatter#ago} on the host clock. */
export function timeAgo(date: null | undefined | number | string | Date): string {
  return new TimeFormatter().ago(date)
}
