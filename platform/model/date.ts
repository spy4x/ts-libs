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
 * that was never on any calendar. Fixed by checking the parsed value's own year/month/day against
 * the digits the string named, for the `YYYY-MM-DD` prefix every date-only and date-time ISO
 * string starts with (see {@link isRealCalendarDate}); week dates and ordinal dates
 * (`"2024-W01-1"`, `"2024-001"`) do not have that prefix and are left exactly as the source parsed
 * them — the brief for this fix names only calendar (`YYYY-MM-DD`) dates as in scope, and nothing
 * in this workspace produces the other two forms.
 */
import { type } from "arktype"

const ISO_CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * Whether the `YYYY-MM-DD` prefix of an ISO 8601 string names a calendar date that exists.
 *
 * Rebuilds a UTC date from the three numbers and reads its fields back: `Date.UTC` normalises an
 * out-of-range day or month instead of throwing (`Date.UTC(2026, 1, 30)` is 2 March 2026), so a
 * date that overflowed reads back with different fields than the ones it was built from — 3, not
 * 30. A string with no such prefix (a week date, an ordinal date, or already-invalid shape the
 * base ISO check will refuse) is left alone; there is nothing here to compare it against.
 */
function isRealCalendarDate(iso: string): boolean {
  const match = ISO_CALENDAR_DATE_PREFIX.exec(iso)
  if (match === null) return true
  const [, yearStr, monthStr, dayStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const rebuilt = new Date(Date.UTC(year, month - 1, day))
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
