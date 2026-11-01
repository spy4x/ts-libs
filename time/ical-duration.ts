/**
 * The iCalendar duration (`P1DT2H`) as this package reads and writes it. Private to the package:
 * not an entry point.
 *
 * One pattern holds the grammar. Reading is lenient, as for any text from another app: any case,
 * weeks next to days, and a time that skips a unit. Writing is checked by the caller's own rule,
 * {@link isRfcDuration} or {@link isIsoDuration}, both stated on the same parts.
 * @module
 */

/** Sign, then weeks, days, hours, minutes and seconds, each optional. */
const PARTS = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i

/** Milliseconds of one week, day, hour, minute and second, in the order of {@link Duration}. */
const UNIT_MS = [604_800_000, 86_400_000, 3_600_000, 60_000, 1_000]

/** A duration split into its parts. */
export interface Duration {
  /** Whether it starts with `-`. */
  negative: boolean
  /** Weeks, days, hours, minutes and seconds; `undefined` where the text has no such part. */
  units: (number | undefined)[]
}

/** The parts of `text`, whether it is in the grammar or not, with whether it has a `T`. */
function parts(text: string): (Duration & { time: boolean }) | undefined {
  const match = PARTS.exec(text)
  if (!match) return undefined
  return {
    negative: match[1] === "-",
    units: match.slice(2, 7).map((part) => part === undefined ? undefined : Number(part)),
    time: /T/i.test(text),
  }
}

/**
 * A duration as written by another app, or `undefined` when it is not one. Surrounding space is
 * ignored. It needs at least one unit, and a `T` needs a time after it (`P1DT` is refused).
 */
export function readDuration(text: string): Duration | undefined {
  const value = text.trim()
  const read = parts(value)
  if (!read || /T$/i.test(value) || read.units.every((unit) => unit === undefined)) {
    return undefined
  }
  return { negative: read.negative, units: read.units }
}

/** A read duration in milliseconds. */
export function durationMs(duration: Duration): number {
  const total = UNIT_MS.reduce((sum, unit, index) => sum + (duration.units[index] ?? 0) * unit, 0)
  return duration.negative ? -total : total
}

/** Upper-case parts with weeks alone, as both write rules want. */
function writable(text: string): (Duration & { time: boolean }) | undefined {
  const read = parts(text)
  if (!read || /[a-z]/.test(text)) return undefined
  const [weeks, ...rest] = read.units
  if (weeks !== undefined && (read.time || rest.some((unit) => unit !== undefined))) {
    return undefined
  }
  return read
}

/**
 * Whether `text` is an RFC 5545 `dur-value`: weeks alone, or days with an optional time, or a
 * time. A time runs hours, minutes, seconds without a gap, so `PT1H1S` is refused.
 */
export function isRfcDuration(text: string): boolean {
  const read = writable(text)
  if (!read) return false
  const [weeks, days, hours, minutes, seconds] = read.units
  if (weeks !== undefined) return true
  if (!read.time) return days !== undefined
  if (hours === undefined && minutes === undefined && seconds === undefined) return false
  return !(hours !== undefined && seconds !== undefined && minutes === undefined)
}

/**
 * Whether `text` is an ISO 8601 duration as an event's `DURATION` takes it: weeks alone, or any
 * of days, hours, minutes and seconds, `P` and `PT` included.
 */
export function isIsoDuration(text: string): boolean {
  return writable(text) !== undefined
}
