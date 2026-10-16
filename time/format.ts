/**
 * One set of formatters for a person's settings: their region format, their time zone and their
 * 12- or 24-hour clock, each "automatic" (the device's own) when not set.
 *
 * Every date, time and number an app shows goes through the functions {@link createFormatters}
 * returns, so a person in Berlin with a German region format sees `17.10.2026, 15:45` on every
 * screen, and the same person travelling with "automatic" time zone sees the local time of the
 * place they are in. Everything is `Intl`; nothing reads the host `TZ` except the "automatic"
 * default, which a test replaces through `device`.
 *
 * @example
 * ```ts
 * const format = createFormatters({ locale: "de-DE", timeZone: null, hourCycle: "h23" })
 * format.dateTime(note.updatedAt) // "17.10.2026, 15:45"
 * format.relative(note.updatedAt) // "vor 5 Minuten"
 * ```
 */

import { isValidTimeZone } from "./tz.ts"

/** A clock: `h12` shows `3:45 PM`, `h23` shows `15:45`. */
export type HourCycle = "h12" | "h23"

/** A date's length, as `Intl.DateTimeFormat`'s `dateStyle`: `17/10/2026` … `Saturday 17 October 2026`. */
export type DateLength = "short" | "medium" | "long" | "full"

/** A person's display settings. `null` or a missing field means "automatic": the device's own. */
export interface FormatSettings {
  /** A BCP 47 tag for the region format, e.g. `de-DE`. */
  locale?: string | null
  /** An IANA zone, e.g. `Europe/Berlin`. */
  timeZone?: string | null
  /** The clock. Automatic follows the region format. */
  hourCycle?: HourCycle | null
}

/** What "automatic" resolves to. */
export interface DeviceFormat {
  locale: string
  timeZone: string
}

/** Options for {@link createFormatters}. */
export interface CreateFormattersOptions {
  /** The device's locale and zone. Default: what this runtime's `Intl` reports. */
  device?: DeviceFormat
  /** The current time in epoch milliseconds, for {@link Formatters.relative}. Default `Date.now`. */
  now?: () => number
}

/** A value a formatter accepts: a `Date`, epoch milliseconds or a string `Date` can parse. */
export type DateInput = Date | number | string | null | undefined

/** The formatters for one person's settings. A missing or unreadable date formats as `-`. */
export interface Formatters {
  /** The locale in use, after "automatic" and an unknown tag fell back to the device's. */
  readonly locale: string
  /** The zone in use, after "automatic" and an unknown zone fell back to the device's. */
  readonly timeZone: string
  /** The clock in use, or `undefined` when the region format decides. */
  readonly hourCycle: HourCycle | undefined
  /** The calendar date, `17 Oct 2026` at the default `medium` length. */
  date(value: DateInput, length?: DateLength): string
  /** The time of day in hours and minutes, `15:45` or `3:45 PM`. */
  time(value: DateInput): string
  /** Date and time, `17 Oct 2026, 15:45` at the default `medium` date length. */
  dateTime(value: DateInput, length?: DateLength): string
  /** Distance from now in the largest fitting unit: `5 minutes ago`, `yesterday`, `in 2 weeks`. */
  relative(value: DateInput): string
  /** A number in the region format, `1,234.5` or `1.234,5`. */
  number(value: number, options?: Intl.NumberFormatOptions): string
}

const EMPTY = "-"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Build the formatters for a person's settings.
 *
 * Settings arrive from storage and from other devices, so none of them is trusted: an unknown
 * locale tag or zone name falls back to the device's instead of throwing.
 */
export function createFormatters(
  settings: FormatSettings = {},
  options: CreateFormattersOptions = {},
): Formatters {
  const device = options.device ?? deviceFormat()
  const now = options.now ?? Date.now
  const locale = supportedLocale(settings.locale) ?? supportedLocale(device.locale) ?? "en-GB"
  const timeZone =
    [settings.timeZone, device.timeZone].find((zone): zone is string =>
      typeof zone === "string" && isValidTimeZone(zone)
    ) ?? "UTC"
  const hourCycle = settings.hourCycle === "h12" || settings.hourCycle === "h23"
    ? settings.hourCycle
    : undefined

  const dateFormats = new Map<string, Intl.DateTimeFormat>()
  const dateFormat = (key: string, format: Intl.DateTimeFormatOptions) => {
    let cached = dateFormats.get(key)
    if (!cached) {
      cached = new Intl.DateTimeFormat(locale, { ...format, timeZone })
      dateFormats.set(key, cached)
    }
    return cached
  }
  const clock = hourCycle ? { hourCycle } : {}
  const numbers = new Intl.NumberFormat(locale)
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  return {
    locale,
    timeZone,
    hourCycle,
    date(value, length = "medium") {
      const instant = toInstant(value)
      return instant === null
        ? EMPTY
        : dateFormat(`d${length}`, { dateStyle: length }).format(instant)
    },
    time(value) {
      const instant = toInstant(value)
      return instant === null
        ? EMPTY
        : dateFormat("t", { timeStyle: "short", ...clock }).format(instant)
    },
    dateTime(value, length = "medium") {
      const instant = toInstant(value)
      return instant === null
        ? EMPTY
        : dateFormat(`dt${length}`, { dateStyle: length, timeStyle: "short", ...clock })
          .format(instant)
    },
    relative(value) {
      const instant = toInstant(value)
      if (instant === null) return EMPTY
      const [amount, unit] = relativeUnit(instant - now())
      return relativeFormat.format(amount, unit)
    },
    number(value, format) {
      return format ? new Intl.NumberFormat(locale, format).format(value) : numbers.format(value)
    },
  }
}

/** The device's locale and zone, as this runtime's `Intl` reports them. */
export function deviceFormat(): DeviceFormat {
  const resolved = new Intl.DateTimeFormat().resolvedOptions()
  return { locale: resolved.locale, timeZone: resolved.timeZone ?? "UTC" }
}

function supportedLocale(tag: string | null | undefined): string | undefined {
  if (typeof tag !== "string" || tag === "") return undefined
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag])[0]
  } catch {
    return undefined // not a well-formed tag
  }
}

function toInstant(value: DateInput): number | null {
  if (value === null || value === undefined || value === "") return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

/**
 * The largest unit the distance fills, rounded: 90 seconds is `2 minutes`, 36 hours is `2 days`.
 * A week is 7 days, a month 30 and a year 365, like every relative label people read.
 */
function relativeUnit(distance: number): [number, Intl.RelativeTimeFormatUnit] {
  const abs = Math.abs(distance)
  const [unit, size] = RELATIVE_UNITS.find(([, , below]) => abs < below) ?? ["year", 365 * DAY]
  return [Math.round(distance / size), unit]
}

/** Each unit, its length, and the distance below which it is the largest that fits. */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number, number][] = [
  ["second", SECOND, MINUTE],
  ["minute", MINUTE, HOUR],
  ["hour", HOUR, DAY],
  ["day", DAY, 7 * DAY],
  ["week", 7 * DAY, 30 * DAY],
  ["month", 30 * DAY, 365 * DAY],
]
