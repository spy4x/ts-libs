/**
 * Date schemas shared by every model.
 *
 * A field typed with {@link dateSchema} accepts either a `Date` (already parsed, e.g. a value
 * built in a test) or an ISO 8601 date string (what arrives over the wire as JSON), and both parse
 * to a `Date`.
 *
 * Moved from `template/libs/platform/types/+index.ts`. **Bugs fixed at extraction time (#131,
 * #136, #135).** The source was `type("Date | string.date.iso.parse")`: arktype's
 * `string.date.iso.parse` checks the string's *shape* against the ISO 8601 grammar and then parses
 * it with `new Date(...)`. `new Date` silently rolls an out-of-range day or month into the next one
 * instead of refusing it — `new Date("2026-02-30")` is 2 March 2026, not an error — so the source
 * accepted and stored a date that was never on any calendar (#131). V8 also reads two shapes the
 * grammar allows as the wrong date: an ordinal date (`"2024-005"`, 5 January, becomes 1 May) and a
 * year with a sign (`"-2024-01-01"` becomes 2024, `"+0099-12-31"` becomes 1999) (#136). See
 * {@link isRealCalendarDate} for how each is refused. A date-time string with a time but no offset
 * and no `Z`, such as `"2024-02-29T10:00:00"`, is refused too (#135): the ECMA-262 date-time
 * production reads it in the host's own time zone, so the same string names a different instant on
 * a laptop set to one zone and a server set to another. A year, a year and month, or a `YYYY-MM-DD`
 * date — with no time part at all — is read as UTC midnight by the same specification and stays
 * accepted, because that reading does not depend on the host's time zone.
 */
import { type Out, type Type, type } from "arktype"

const ISO_CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/

/** An ordinal date, `YYYY-DDD`, with or without a time after it. */
const ISO_ORDINAL_DATE = /^\d{4}-\d{3}(?!\d)/

/**
 * A time-of-day (`Thh:mm` or `Thh:mm:ss[.fff]`) that is not followed by `Z` or a numeric offset.
 * Anchored at the end of the string: an offset or `Z` after the time means this does not match.
 */
const ISO_TIME_WITHOUT_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/**
 * Whether `new Date` reads an ISO 8601 string as the date it names and, when the string starts with
 * a calendar date, whether that date exists.
 *
 * A string `Date.parse` cannot read is refused first, because `new Date` would hand back an
 * `Invalid Date` with no error. arktype's ISO 8601 grammar accepts several shapes V8 cannot read:
 * an hour with no minutes (`2024-01-01T10`), a comma before the fraction, an offset with no
 * minutes (`+05`), and a week date.
 *
 * Three shapes V8 does read, but as a different date, are refused by their shape:
 *
 * - a year with a `+` or `-` sign: V8 drops the sign and reads a four-digit year below 50 as 20xx
 *   (`"-0001-01-01"` is 2001, `"+0099-12-31"` is 1999);
 * - an ordinal date, `YYYY-DDD`: V8 reads the day of the year as a month (`"2024-005"`, 5 January,
 *   is 1 May); a `DDD` above 012 it cannot read at all;
 * - a date written without dashes (`20240101`, `0001366`): V8 either cannot read it or reads the
 *   digits as a year (`00010101` becomes the year 10101).
 *
 * The first two are refused even where V8 happens to get the date right (`"+2024-01-01"`,
 * `"2024-001"`): `JSON.stringify` never writes an ordinal date, and writes a signed year only with
 * six digits, which the sign rule refuses too.
 *
 * A fourth shape — a time with no offset and no `Z` — is also wrong, but for a reason unrelated to
 * the calendar, so {@link isoCalendarDateSchema} refuses it in its own `.narrow` step, with its own
 * message, before this function ever runs. See `ISO_TIME_WITHOUT_OFFSET`.
 *
 * For a string that starts with `YYYY-MM-DD`, this rebuilds a date from the three digit groups and
 * reads its fields back. `setUTCFullYear` is used rather than `Date.UTC`, which maps a two-digit
 * year into 1900-1999 (`Date.UTC(99, 0, 1)` is 1999, not year 99) — `setUTCFullYear(99, 0, 1)` sets
 * the year exactly as given. An out-of-range day or month still does not throw
 * (`setUTCFullYear(2026, 1, 30)` on a fresh date reads back as 2 March, not an error), so a date
 * that overflowed reads back with different fields than the ones it was built from: for 30
 * February, the rebuilt date's month reads back as 3 (March), not 2 (February), and its day as 2,
 * not 30.
 *
 * A string with no such prefix (a year, or a year and month) has nothing here to rebuild and
 * compare; once `Date.parse` has read it, it is accepted exactly as the source accepted it.
 */
function isRealCalendarDate(iso: string): boolean {
  if (Number.isNaN(Date.parse(iso))) return false
  if (/^[+-]/.test(iso)) return false
  if (/^\d{5}/.test(iso)) return false
  if (ISO_ORDINAL_DATE.test(iso)) return false
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

/**
 * An ISO 8601 date string naming a real calendar date, parsed to a `Date`.
 *
 * Two `.narrow` steps, each with its own message: the first refuses a time with no `Z` and no
 * numeric offset (#135 — see `ISO_TIME_WITHOUT_OFFSET`), because that string names no single
 * instant rather than naming the wrong one; the second, {@link isRealCalendarDate}, refuses a
 * calendar date that does not exist or that V8 would misread (#131, #136). Kept separate so a
 * caller reading the message can tell "add a time zone" from "this date does not exist" — merging
 * them into one `.narrow` would report only whichever ran last.
 */
const isoCalendarDateSchema = type("string.date.iso")
  .narrow((value, ctx) =>
    !ISO_TIME_WITHOUT_OFFSET.test(value) ||
    // `ctx.reject({ problem })` rather than `ctx.mustBe`: `mustBe` always renders as
    // "must be {text}", which reads oddly ("must be name a time zone…") for a message that is
    // not a noun phrase completing "must be". Setting `problem` directly writes the message
    // verbatim (after the path prefix arktype still adds), so it reads as ordinary prose.
    // `expected` is required too, even though `problem` already covers the rendered message:
    // arktype's default `expected` config for a bare predicate node reads a property off
    // `undefined` when nothing sets it, so `JSON.stringify` on the rejection (and anything that
    // serializes it, like `validate` from `@spy4x/validation`) throws instead of returning it.
    ctx.reject({
      expected: "a date-time ending in Z or an offset",
      problem: "must name a time zone: end the time with `Z` or an offset such as `+02:00`",
    })
  )
  .narrow((value, ctx) =>
    isRealCalendarDate(value) ||
    ctx.mustBe("a calendar date that exists, with an unsigned year and no ordinal day")
  )
  .pipe((value) => new Date(value))

/** `Date`, or an ISO 8601 date string naming a real calendar date, parsed to a `Date`. */
export const dateSchema: Type<Date | ((In: string) => Out<Date>)> = type("Date").or(
  isoCalendarDateSchema,
)

/** Value {@link dateSchema} produces: always a `Date`, regardless of which input form it parsed. */
export type DateType = typeof dateSchema.infer

/** {@link dateSchema}, also accepting `null` and defaulting to it when the field is absent. */
export const DateNullableSchema: [
  Type<Date | ((In: string) => Out<Date>) | null>,
  "=",
  null,
] = dateSchema.or("null").default(null)
