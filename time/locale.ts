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

/**
 * Region formats a picker offers: a language with a country, the way people choose how numbers
 * and dates are written. `Intl` has no list of locales (`Intl.supportedValuesOf` covers zones,
 * currencies and units, not locales), so this is the set of CLDR's widely used ones;
 * {@link localeOptions} keeps only the tags the runtime can format.
 */
export const REGION_FORMAT_LOCALES: readonly string[] = [
  "af-ZA",
  "ar-AE",
  "ar-EG",
  "ar-SA",
  "az-AZ",
  "be-BY",
  "bg-BG",
  "bn-BD",
  "bn-IN",
  "bs-BA",
  "ca-ES",
  "cs-CZ",
  "cy-GB",
  "da-DK",
  "de-AT",
  "de-CH",
  "de-DE",
  "el-GR",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-IE",
  "en-IN",
  "en-NG",
  "en-NZ",
  "en-PH",
  "en-SG",
  "en-US",
  "en-ZA",
  "es-AR",
  "es-CL",
  "es-CO",
  "es-ES",
  "es-MX",
  "es-PE",
  "es-US",
  "et-EE",
  "eu-ES",
  "fa-IR",
  "fi-FI",
  "fil-PH",
  "fr-BE",
  "fr-CA",
  "fr-CH",
  "fr-FR",
  "ga-IE",
  "gl-ES",
  "gu-IN",
  "he-IL",
  "hi-IN",
  "hr-HR",
  "hu-HU",
  "hy-AM",
  "id-ID",
  "is-IS",
  "it-CH",
  "it-IT",
  "ja-JP",
  "ka-GE",
  "kk-KZ",
  "km-KH",
  "kn-IN",
  "ko-KR",
  "lt-LT",
  "lv-LV",
  "mk-MK",
  "ml-IN",
  "mn-MN",
  "mr-IN",
  "ms-MY",
  "my-MM",
  "nb-NO",
  "ne-NP",
  "nl-BE",
  "nl-NL",
  "pa-IN",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "ru-RU",
  "si-LK",
  "sk-SK",
  "sl-SI",
  "sq-AL",
  "sr-RS",
  "sv-SE",
  "sw-KE",
  "ta-IN",
  "te-IN",
  "th-TH",
  "tr-TR",
  "uk-UA",
  "ur-PK",
  "uz-UZ",
  "vi-VN",
  "zh-CN",
  "zh-HK",
  "zh-TW",
]

/** One entry of a region format picker, from {@link localeOptions}. */
export interface LocaleOption {
  /** The BCP 47 tag to store, e.g. `de-DE`. */
  value: string
  /** The name in its own language, e.g. `Deutsch (Deutschland)`. */
  nativeName: string
  /** The name in the display language, e.g. `German (Germany)`. */
  name: string
  /** What the option shows: `Deutsch (Deutschland), German (Germany)`, or one name when both match. */
  label: string
  /** Lower-case text to match a search against: the tag and both names. */
  searchText: string
}

/**
 * Region formats as options for a searchable picker, sorted by their name in `displayLocale`.
 *
 * Names come from `Intl.DisplayNames`, so they need no translation table. A tag the runtime cannot
 * format is left out.
 *
 * @param displayLocale The language of the second name, the app's own. Default `en`.
 * @param locales The tags to list. Default {@link REGION_FORMAT_LOCALES}.
 */
export function localeOptions(
  displayLocale = "en",
  locales: readonly string[] = REGION_FORMAT_LOCALES,
): LocaleOption[] {
  const names = new Intl.DisplayNames([displayLocale], {
    type: "language",
    languageDisplay: "standard",
  })
  const collator = new Intl.Collator(displayLocale)
  return Intl.DateTimeFormat.supportedLocalesOf([...locales]).map((value) => {
    const name = names.of(value) ?? value
    const nativeName =
      new Intl.DisplayNames([value], { type: "language", languageDisplay: "standard" })
        .of(value) ?? name
    const label = nativeName === name ? name : `${nativeName}, ${name}`
    const searchText = `${value} ${nativeName} ${name}`.toLowerCase()
    return { value, nativeName, name, label, searchText }
  }).sort((a, b) => collator.compare(a.name, b.name))
}
