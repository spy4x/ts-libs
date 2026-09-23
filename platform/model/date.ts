/**
 * Date schemas shared by every model.
 *
 * A field typed with {@link dateSchema} accepts either a `Date` (already parsed, e.g. a value
 * built in a test) or an ISO 8601 date string (what arrives over the wire as JSON), and both parse
 * to a `Date`.
 *
 * Moved from `template/libs/platform/types/+index.ts`. **Bug fixed at extraction time (#131).**
 * The source was `type("Date | string.date.iso.parse")`: arktype's `string.date.iso.parse` checks
 * the string's *shape* against the ISO 8601 grammar and then parses it with `new Date(...)`,
 * which silently rolls an out-of-range day or month into the next one instead of refusing it —
 * `new Date("2026-02-30")` is 2 March 2026, not an error, so the source accepted and stored a date
 * that was never on any calendar. Fixed in two steps (see {@link isRealCalendarDate}): a string
 * `new Date` cannot read is refused, so no `Invalid Date` comes out without an error; and for a
 * string that starts with a `YYYY-MM-DD` date, with or without a `+` or `-` before the year, a UTC
 * date is rebuilt from those year, month and day digits and the string is refused when the rebuilt
 * date's fields differ from them. A string without that prefix that `new Date` can read (a year, a
 * year and month, or an ordinal date such as `2024-001`) parses as the source parsed it. A date
 * written without dashes is refused, because V8 reads its digits as a year.
 */
import { type } from "arktype"

const ISO_CALENDAR_DATE_PREFIX = /^[+-]?(\d{4})-(\d{2})-(\d{2})/

/**
 * Whether `new Date` can read an ISO 8601 string and, when the string starts with a calendar date,
 * whether that date exists.
 *
 * A string `Date.parse` cannot read is refused first, because `new Date` would hand back an
 * `Invalid Date` with no error. arktype's ISO 8601 grammar accepts several shapes V8 cannot read:
 * an hour with no minutes (`2024-01-01T10`), a comma before the fraction, an offset with no
 * minutes (`+05`), and a week date. A date written without dashes (`20240101`, `0001366`) is
 * refused too: V8 either cannot read it or reads the digits as a year (`00010101` becomes the year
 * 10101).
 *
 * For a string that starts with `YYYY-MM-DD`, with or without a `+` or `-` before the year, this
 * rebuilds a date from the three digit groups and reads its fields back. `setUTCFullYear` is used
 * rather than `Date.UTC`, which maps a two-digit year into 1900-1999 (`Date.UTC(99, 0, 1)` is
 * 1999, not year 99) — `setUTCFullYear(99, 0, 1)` sets the year exactly as given. An out-of-range day or
 * month still does not throw (`setUTCFullYear(2026, 1, 30)` on a fresh date reads back as 2 March,
 * not an error), so a date that overflowed reads back with different fields than the ones it was
 * built from: for 30 February, the rebuilt date's month reads back as 3 (March), not 2 (February),
 * and its day as 2, not 30.
 *
 * A string with no such prefix (a year, a year and month, or an ordinal date such as `2024-001`)
 * has nothing here to rebuild and compare; once `Date.parse` has read it, it is accepted exactly as
 * the source accepted it.
 */
function isRealCalendarDate(iso: string): boolean {
  if (Number.isNaN(Date.parse(iso))) return false
  if (/^[+-]?\d{5}/.test(iso)) return false
  const match = ISO_CALENDAR_DATE_PREFIX.exec(iso)
  if (match === null) return true
  const [, yearStr, monthStr, dayStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const rebuilt = new Date(0)
  rebuilt.setUTCFullYear(year, month - 1, day)
  return (
    rebuilt.getUTCFullYear() === year &&
    rebuilt.getUTCMonth() === month - 1 &&
    rebuilt.getUTCDate() === day
  )
}

/** An ISO 8601 date string naming a real calendar date, parsed to a `Date`. */
const isoCalendarDateSchema = type("string.date.iso")
  .narrow((value, ctx) => isRealCalendarDate(value) || ctx.mustBe("a calendar date that exists"))
  .pipe((value) => new Date(value))

/** `Date`, or an ISO 8601 date string naming a real calendar date, parsed to a `Date`. */
export const dateSchema = type("Date").or(isoCalendarDateSchema)

/** Value {@link dateSchema} produces: always a `Date`, regardless of which input form it parsed. */
export type DateType = typeof dateSchema.infer

/** {@link dateSchema}, also accepting `null` and defaulting to it when the field is absent. */
export const DateNullableSchema = dateSchema.or("null").default(null)
