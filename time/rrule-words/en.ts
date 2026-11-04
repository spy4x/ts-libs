/**
 * The words of `describeRrule` in English, the source every translation is checked against. Make a
 * translator with `createTranslator({ language, catalogs: [{ source: en, translation }] })` from
 * `@spy4x/platform/universal/i18n` and pass it as `describeRrule`'s second argument.
 *
 * For translators:
 * - `{rule}` is the label so far, such as `Monthly` or `Every 2 weeks`; each `on.*`, `when.*`,
 *   `in.*`, `count` and `until` message adds one part to it.
 * - `{days}` and `{months}` are lists `Intl.ListFormat` already joined; `{weekday}` is the weekday's
 *   full name from `Intl`, as it stands alone (nominative); `{date}` is a date `Intl` wrote.
 * - `ordinalNumber.<category>` writes `{number}` as an ordinal; the category comes from
 *   `Intl.PluralRules` with `type: "ordinal"`, and a language with one form repeats it.
 * - `gender.<weekday>` is not shown: it names the grammatical gender of the weekday's name
 *   (`masculine`, `feminine` or `neuter`), and picks the `nth.<ordinal>.<gender>` message for it.
 *   A language without gender writes `masculine` and repeats the same text for every gender.
 * - `nth.<n>` is the n-th such weekday of the month, `nth.-<n>` the n-th from its end, and
 *   `nth.every` every such weekday.
 */
export default {
  "freq.daily": "Daily",
  "freq.weekly": "Weekly",
  "freq.monthly": "Monthly",
  "freq.yearly": "Yearly",
  "interval.days": {
    "one": "Every {count} day",
    "other": "Every {count} days",
  },
  "interval.weeks": {
    "one": "Every {count} week",
    "other": "Every {count} weeks",
  },
  "interval.months": {
    "one": "Every {count} month",
    "other": "Every {count} months",
  },
  "interval.years": {
    "one": "Every {count} year",
    "other": "Every {count} years",
  },
  "on.weekdays": "{rule} on {days}",
  "on.everyWeekday": "{rule} on every {days}",
  "on.nthWeekdays": "{rule} on {days}",
  "on.monthDays": "{rule} on {days}",
  "when.monthDays": "{rule} when it is {days}",
  "in.months": "{rule} in {months}",
  "count": {
    "one": "{rule}, {count} time",
    "other": "{rule}, {count} times",
  },
  "until": "{rule}, until {date}",
  "monthDay": "day {day}",
  "monthDay.last": "the last day",
  "monthDay.fromEnd": "the {nth} to last day",
  "ordinalNumber.one": "{number}st",
  "ordinalNumber.two": "{number}nd",
  "ordinalNumber.few": "{number}rd",
  "ordinalNumber.other": "{number}th",
  "gender.monday": "masculine",
  "gender.tuesday": "masculine",
  "gender.wednesday": "masculine",
  "gender.thursday": "masculine",
  "gender.friday": "masculine",
  "gender.saturday": "masculine",
  "gender.sunday": "masculine",
  "nth.1.masculine": "the first {weekday}",
  "nth.2.masculine": "the second {weekday}",
  "nth.3.masculine": "the third {weekday}",
  "nth.4.masculine": "the fourth {weekday}",
  "nth.5.masculine": "the fifth {weekday}",
  "nth.-1.masculine": "the last {weekday}",
  "nth.-2.masculine": "the second to last {weekday}",
  "nth.-3.masculine": "the third to last {weekday}",
  "nth.-4.masculine": "the fourth to last {weekday}",
  "nth.-5.masculine": "the fifth to last {weekday}",
  "nth.every.masculine": "every {weekday}",
  "nth.1.feminine": "the first {weekday}",
  "nth.2.feminine": "the second {weekday}",
  "nth.3.feminine": "the third {weekday}",
  "nth.4.feminine": "the fourth {weekday}",
  "nth.5.feminine": "the fifth {weekday}",
  "nth.-1.feminine": "the last {weekday}",
  "nth.-2.feminine": "the second to last {weekday}",
  "nth.-3.feminine": "the third to last {weekday}",
  "nth.-4.feminine": "the fourth to last {weekday}",
  "nth.-5.feminine": "the fifth to last {weekday}",
  "nth.every.feminine": "every {weekday}",
  "nth.1.neuter": "the first {weekday}",
  "nth.2.neuter": "the second {weekday}",
  "nth.3.neuter": "the third {weekday}",
  "nth.4.neuter": "the fourth {weekday}",
  "nth.5.neuter": "the fifth {weekday}",
  "nth.-1.neuter": "the last {weekday}",
  "nth.-2.neuter": "the second to last {weekday}",
  "nth.-3.neuter": "the third to last {weekday}",
  "nth.-4.neuter": "the fourth to last {weekday}",
  "nth.-5.neuter": "the fifth to last {weekday}",
  "nth.every.neuter": "every {weekday}",
}
