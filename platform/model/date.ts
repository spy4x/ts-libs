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
 * that was never on any calendar. Fixed by rebuilding a UTC date from the year, month and day
 * digits of the string's `YYYY-MM-DD` prefix and refusing the string when the rebuilt date's
 * fields differ from those digits (see {@link isRealCalendarDate}). A string without that prefix
 * (a week date, an ordinal date, or the compact form without dashes) is refused when `new Date`
 * cannot read it, and otherwise parses as the source parsed it.
 */
import { type } from "arktype"

const ISO_CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * Whether an ISO 8601 string names a date `new Date` can actually read.
 *
 * For the `YYYY-MM-DD` prefix every date-only and date-time ISO string starts with, this rebuilds
 * a date from the three digit groups and reads its fields back. `setUTCFullYear` is used rather
 * than `Date.UTC`, which maps a two-digit year into 1900-1999 (`Date.UTC(99, 0, 1)` is 1999, not
 * year 99) — `setUTCFullYear(99, 0, 1)` sets the year exactly as given. An out-of-range day or
 * month still does not throw (`setUTCFullYear(2026, 1, 30)` on a fresh date reads back as 2 March,
 * not an error), so a date that overflowed reads back with different fields than the ones it was
 * built from: for 30 February, the rebuilt date's month reads back as 3 (March), not 2 (February),
 * and its day as 2, not 30.
 *
 * A string with no such prefix (a week date, an ordinal date, or the compact form without dashes)
 * has nothing here to rebuild and compare, so it falls back to asking `Date.parse` whether it can
 * be read at all — refusing it only when parsing would otherwise silently hand back an unusable
 * `Invalid Date` with no error, and accepting it exactly as the source did otherwise.
 */
function isRealCalendarDate(iso: string): boolean {
  const match = ISO_CALENDAR_DATE_PREFIX.exec(iso)
  if (match === null) return !Number.isNaN(Date.parse(iso))
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
