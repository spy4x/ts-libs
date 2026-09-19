/**
 * Time unit constants, derived so that one unit is always an exact multiple of the one below it.
 *
 * A month is **30 days** and a year is **12 months**, matching the fixed-length convention the
 * inventory batch already used for cache TTLs. Derive every millisecond constant from its own
 * second-based counterpart: the source repo computed {@link ONE_MONTH_IN_MILLISECONDS} from
 * `ONE_YEAR_IN_SECONDS` (`gb/libs/shared/constants.ts:17`), which silently made the month twelve
 * times too long — i.e. byte-identical to a year.
 */

/** Days in one nominal month. */
export const DAYS_IN_MONTH = 30
/** Days in one week. */
export const DAYS_IN_WEEK = 7
/** Months in one year. */
export const MONTHS_IN_YEAR = 12
/** Hours in one day. */
export const HOURS_IN_DAY = 24
/** Minutes in one hour. */
export const MINUTES_IN_HOUR = 60
/** Seconds in one minute. */
export const SECONDS_IN_MINUTE = 60
/** Milliseconds in one second. */
export const MILLISECONDS_IN_SECOND = 1000

/** One hour, in seconds. */
export const ONE_HOUR_IN_SECONDS = MINUTES_IN_HOUR * SECONDS_IN_MINUTE
/** One day, in seconds. */
export const ONE_DAY_IN_SECONDS = HOURS_IN_DAY * ONE_HOUR_IN_SECONDS
/** One week, in seconds. */
export const ONE_WEEK_IN_SECONDS = DAYS_IN_WEEK * ONE_DAY_IN_SECONDS
/** One month (30 days), in seconds. */
export const ONE_MONTH_IN_SECONDS = DAYS_IN_MONTH * ONE_DAY_IN_SECONDS
/** One year (12 nominal months), in seconds. */
export const ONE_YEAR_IN_SECONDS = MONTHS_IN_YEAR * ONE_MONTH_IN_SECONDS

/** One minute, in milliseconds. */
export const ONE_MINUTE_IN_MILLISECONDS = SECONDS_IN_MINUTE * MILLISECONDS_IN_SECOND
/** One hour, in milliseconds. */
export const ONE_HOUR_IN_MILLISECONDS = ONE_HOUR_IN_SECONDS * MILLISECONDS_IN_SECOND
/** One day, in milliseconds. */
export const ONE_DAY_IN_MILLISECONDS = ONE_DAY_IN_SECONDS * MILLISECONDS_IN_SECOND
/** One week, in milliseconds. */
export const ONE_WEEK_IN_MILLISECONDS = ONE_WEEK_IN_SECONDS * MILLISECONDS_IN_SECOND
/**
 * One month (30 days), in milliseconds.
 *
 * Derived from {@link ONE_MONTH_IN_SECONDS}. The source repo derived it from
 * `ONE_YEAR_IN_SECONDS`, producing `31_536_000_000` instead of `2_592_000_000`.
 */
export const ONE_MONTH_IN_MILLISECONDS = ONE_MONTH_IN_SECONDS * MILLISECONDS_IN_SECOND
/** One year (12 nominal months), in milliseconds. */
export const ONE_YEAR_IN_MILLISECONDS = ONE_YEAR_IN_SECONDS * MILLISECONDS_IN_SECOND

/** Minimum accepted password length. */
export const MIN_PASSWORD_LENGTH = 12
