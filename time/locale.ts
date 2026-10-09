/**
 * Calendar labels and week layout for a locale, read from `Intl` alone.
 *
 * Which day a week starts on, and what its days and months are called, are the locale's business:
 * a grid laid out with {@link localeFirstWeekday} and {@link weekdayLabels} starts on Monday in
 * London, on Sunday in New York and on Saturday in Cairo with no table of exceptions here.
 *
 * Dates are plain `YYYY-MM-DD` values, formatted in UTC so the label never depends on the host
 * zone. Every function defaults to `"en-GB"`, the locale the rest of `@spy4x/time` writes in.
 */

import { parseIsoDate, startOfMonth } from "./date.ts"

const DEFAULT_LOCALE = "en-GB"

/**
 * The day the locale's week starts on, `1` = Monday … `7` = Sunday.
 *
 * `Intl.Locale.getWeekInfo` is the platform's own answer — Monday across most of Europe, Sunday in
 * the United States, Saturday across much of the Middle East. A runtime that does not carry the
 * method, or a tag it cannot read, falls back to Monday, which is the ISO week.
 *
 * @param locale A BCP 47 tag, e.g. `en-US`.
 */
export function localeFirstWeekday(locale: string = DEFAULT_LOCALE): number {
  try {
    // Two spellings, because the method replaced a property of the same name and an engine carries
    // one or the other: reading only the newer one would quietly put every locale back on Monday.
    const tag = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number }
      weekInfo?: { firstDay?: number }
    }
    const firstDay = (tag.getWeekInfo?.() ?? tag.weekInfo)?.firstDay
    return typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7 ? firstDay : 1
  } catch {
    return 1
  }
}

/** Localised "August 2026" for the month `date` falls in. Throws on a value that is not a date. */
export function monthLabel(date: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(parseIsoDate(startOfMonth(date))))
}

/** Localised "23 August 2026", the date as a person reads it. Throws on a value that is not one. */
export function dayLabel(date: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parseIsoDate(date)))
}

/** Localised "Thu 15 Oct": weekday, day and month, no year. Throws on a value that is not a date. */
export function shortDayLabel(date: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(parseIsoDate(date)))
}

/**
 * A day as a person says it: "Yesterday", "Today", "Tomorrow", otherwise {@link shortDayLabel}.
 *
 * Both dates are plain `YYYY-MM-DD` values, so the comparison is calendar arithmetic with no zone
 * in it; the caller decides what "today" is, usually with `isoDateInTz`. The three words come from
 * `Intl.RelativeTimeFormat` in the locale, with the first letter upper-cased by that locale's own
 * rules because the platform writes them mid-sentence ("yesterday"). Throws on a value that is not
 * a date.
 *
 * @param date The day to describe.
 * @param today The day the viewer is on.
 * @param locale A BCP 47 tag, e.g. `de-DE`.
 */
export function relativeDayLabel(
  date: string,
  today: string,
  locale: string = DEFAULT_LOCALE,
): string {
  const offset = Math.round((parseIsoDate(date) - parseIsoDate(today)) / 86_400_000)
  if (offset < -1 || offset > 1) return shortDayLabel(date, locale)
  const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(offset, "day")
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
}

/** One weekday header: what its column shows, and what that abbreviation stands for. */
export interface WeekdayLabel {
  /** The abbreviation the column header shows, e.g. `Mon`. */
  short: string
  /** The full name, e.g. `Monday` — the column's accessible name. */
  long: string
}

/**
 * Seven localised weekday labels, starting on the locale's own first day.
 *
 * Both forms are returned because a header needs both, and neither can be had by cutting the other
 * down: `short` is what `Intl` itself abbreviates to, and cutting *that* to two characters leaves
 * every Arabic weekday reading `ال` and six of seven Vietnamese ones reading `Th`.
 *
 * @param locale A BCP 47 tag; it decides the language *and* the column order.
 */
export function weekdayLabels(locale: string = DEFAULT_LOCALE): WeekdayLabel[] {
  const monday = parseIsoDate("2024-01-01") // a Monday
  const first = localeFirstWeekday(locale)
  const short = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
  const long = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday + ((first - 1 + index) % 7) * 86_400_000)
    return { short: short.format(day), long: long.format(day) }
  })
}
