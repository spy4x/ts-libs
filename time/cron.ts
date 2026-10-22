/**
 * Cron schedules in UTC: the five-field expressions of Vixie cron, for jobs that repeat.
 *
 * {@link parseCron} reads `minute hour day-of-month month day-of-week`, with `*`, lists (`1,15`),
 * ranges (`9-17`), steps (`*\/5`, `0-30/10`, `5/15`), month and weekday names (`JAN`, `mon`) and
 * the aliases `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly` and `@yearly`
 * (`@annually`). Day of week runs from 0 (Sunday) to 7 (Sunday again). {@link nextCronRun} finds
 * the next minute that matches, strictly after a moment. {@link describeCron} gives an English
 * label such as `Every day at 03:00 UTC`.
 *
 * Day of month and day of week follow the classic rule: when both fields are restricted (neither
 * starts with `*`), a day matches when either does, so `0 0 1 * MON` runs on the 1st and on every
 * Monday. When one of them starts with `*`, a day must match both.
 *
 * Every time is UTC. Invalid input throws a `RangeError` that names the field.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`, no dependencies.
 * @module
 */

/** A parsed cron expression: the values each field allows, sorted and without repeats. */
export interface CronSchedule {
  /** 0 to 59. */
  minutes: readonly number[]
  /** 0 to 23, in UTC. */
  hours: readonly number[]
  /** 1 to 31. */
  daysOfMonth: readonly number[]
  /** 1 to 12. */
  months: readonly number[]
  /** 0 (Sunday) to 6 (Saturday); a 7 in the expression is read as 0. */
  daysOfWeek: readonly number[]
  /** Whether the day-of-month field does not start with `*`; see the module doc for the rule. */
  dayOfMonthRestricted: boolean
  /** Whether the day-of-week field does not start with `*`. */
  dayOfWeekRestricted: boolean
}

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: readonly string[]
}

const MONTH_NAMES = [
  `JAN`,
  `FEB`,
  `MAR`,
  `APR`,
  `MAY`,
  `JUN`,
  `JUL`,
  `AUG`,
  `SEP`,
  `OCT`,
  `NOV`,
  `DEC`,
]
const WEEKDAY_NAMES = [`SUN`, `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`]

const FIELDS: readonly FieldSpec[] = [
  { name: `minute`, min: 0, max: 59 },
  { name: `hour`, min: 0, max: 23 },
  { name: `day-of-month`, min: 1, max: 31 },
  { name: `month`, min: 1, max: 12, names: MONTH_NAMES },
  { name: `day-of-week`, min: 0, max: 7, names: WEEKDAY_NAMES },
]

const ALIASES: Readonly<Record<string, string>> = {
  "@hourly": `0 * * * *`,
  "@daily": `0 0 * * *`,
  "@midnight": `0 0 * * *`,
  "@weekly": `0 0 * * 0`,
  "@monthly": `0 0 1 * *`,
  "@yearly": `0 0 1 1 *`,
  "@annually": `0 0 1 1 *`,
}

/** The most days each month can have, February in a leap year included. */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Parses a five-field cron expression or an alias. Fields are separated by spaces or tabs; names
 * are case-insensitive.
 *
 * @throws RangeError naming the field, when the expression does not have five fields, a value is
 * not a number or a known name, is out of the field's range, a range runs backwards, a step is not
 * at least 1, or the day of month can never fall in the chosen months (`0 0 30 2 *`).
 */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim()
  const alias = trimmed.startsWith(`@`) ? ALIASES[trimmed.toLowerCase()] : undefined
  if (trimmed.startsWith(`@`) && alias === undefined) {
    throw new RangeError(`cron: unknown alias "${trimmed}"`)
  }
  const fields = (alias ?? trimmed).split(/\s+/)
  if (fields.length !== 5 || fields[0] === ``) {
    throw new RangeError(
      `cron: expected 5 fields (minute hour day-of-month month day-of-week), got "${expression}"`,
    )
  }
  const [minutes, hours, daysOfMonth, months, weekdays] = fields.map((field, index) =>
    parseField(field, FIELDS[index])
  )
  const daysOfWeek = [...new Set(weekdays.map((day) => day % 7))].sort((a, b) => a - b)
  const schedule: CronSchedule = {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: !fields[2].startsWith(`*`),
    dayOfWeekRestricted: !fields[4].startsWith(`*`),
  }
  const orRule = schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
  const fits = months.some((month) => daysOfMonth[0] <= MONTH_MAX_DAYS[month - 1])
  if (!orRule && !fits) {
    throw new RangeError(
      `cron day-of-month: "${fields[2]}" never falls in the months "${fields[3]}"`,
    )
  }
  return schedule
}

/** One field: a comma list of `*`, `a`, `a-b`, each with an optional `/step`. */
function parseField(text: string, spec: FieldSpec): number[] {
  const values = new Set<number>()
  for (const item of text.split(`,`)) {
    const fail = (why: string) => new RangeError(`cron ${spec.name}: "${item}" ${why}`)
    const [range, stepText, extra] = item.split(`/`)
    if (extra !== undefined) throw fail(`has more than one step`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw fail(`needs a step of at least 1`)
      }
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (range === `*`) {
      from = spec.min
      to = spec.max
    } else {
      const [startText, endText, rest] = range.split(`-`)
      if (rest !== undefined) throw fail(`is not a value or a range`)
      from = parseValue(startText, spec, fail)
      // `5/15` means from 5 to the end of the field, every 15.
      to = endText !== undefined
        ? parseValue(endText, spec, fail)
        : stepText !== undefined
        ? spec.max
        : from
      if (to < from) throw fail(`runs backwards`)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

function parseValue(text: string, spec: FieldSpec, fail: (why: string) => RangeError): number {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1
  if (named >= 0) return spec.min === 1 ? named + 1 : named
  if (!/^\d+$/.test(text)) throw fail(`is not a number${spec.names ? ` or a name` : ``}`)
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    throw fail(`is out of range ${spec.min}-${spec.max}`)
  }
  return value
}

const MINUTE_MS = 60_000

/**
 * The first minute that matches `schedule`, strictly after `after`, in UTC. Seconds and
 * milliseconds of the result are 0, so a job that ran at 03:00:00.250 gets the next day's 03:00.
 *
 * @throws RangeError when `after` is not a valid date, or `schedule` is a string `parseCron`
 * refuses.
 */
export function nextCronRun(schedule: string | CronSchedule, after: Date): Date {
  const cron = typeof schedule === `string` ? parseCron(schedule) : schedule
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new RangeError(`cron: after must be a valid Date`)
  }
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  // `parseCron` refuses a day that never comes, so a match is a few years away at most (29
  // February on a given weekday). The bound only guards a hand-made `CronSchedule`.
  const limit = new Date(time).getUTCFullYear() + 400
  while (true) {
    const date = new Date(time)
    const year = date.getUTCFullYear()
    if (year > limit) throw new RangeError(`cron: the schedule never matches`)
    const month = date.getUTCMonth()
    const day = date.getUTCDate()
    if (!cron.months.includes(month + 1)) {
      time = Date.UTC(year, month + 1, 1)
    } else if (!dayMatches(cron, day, date.getUTCDay())) {
      time = Date.UTC(year, month, day + 1)
    } else if (!cron.hours.includes(date.getUTCHours())) {
      time = Date.UTC(year, month, day, date.getUTCHours() + 1)
    } else if (!cron.minutes.includes(date.getUTCMinutes())) {
      time += MINUTE_MS
    } else {
      return date
    }
  }
}

function dayMatches(cron: CronSchedule, day: number, weekday: number): boolean {
  const byMonthDay = cron.daysOfMonth.includes(day)
  const byWeekday = cron.daysOfWeek.includes(weekday)
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byMonthDay || byWeekday
  return byMonthDay && byWeekday
}

const WEEKDAY_LABELS = [
  `Sunday`,
  `Monday`,
  `Tuesday`,
  `Wednesday`,
  `Thursday`,
  `Friday`,
  `Saturday`,
]
const MONTH_LABELS = [
  `January`,
  `February`,
  `March`,
  `April`,
  `May`,
  `June`,
  `July`,
  `August`,
  `September`,
  `October`,
  `November`,
  `December`,
]

/**
 * An English label for a cron expression, for an admin screen: `Every day at 03:00 UTC`,
 * `Every Monday to Friday at 09:00 UTC`, `Every 15 minutes`, `On day 1 of the month at 00:00 UTC`.
 *
 * @throws RangeError when `parseCron` refuses the expression.
 */
export function describeCron(schedule: string | CronSchedule): string {
  const cron = typeof schedule === `string` ? parseCron(schedule) : schedule
  const days = dayPhrase(cron)
  const months = cron.months.length === 12
    ? ``
    : ` in ${list(cron.months, (month) => MONTH_LABELS[month - 1])}`
  const clock = clockTimes(cron)
  if (clock !== undefined) {
    return `${days === undefined ? `Every day` : capitalise(days)}${months} at ${clock} UTC`
  }
  const dayPart = days === undefined && months === `` ? `` : `, ${days ?? `every day`}`
  return `${capitalise(timePhrase(cron))}${dayPart}${months}`
}

/** `03:00` or `09:00 and 17:30` when the schedule runs at six or fewer clock times a day. */
function clockTimes(cron: CronSchedule): string | undefined {
  if (cron.minutes.length * cron.hours.length > 6) return undefined
  const times = cron.hours.flatMap((hour) =>
    cron.minutes.map((minute) => `${pad(hour)}:${pad(minute)}`)
  )
  return listFormat.format(times)
}

/** The minutes and hours part, for a schedule that runs more than six times a day. */
function timePhrase(cron: CronSchedule): string {
  const step = evenStep(cron.minutes, 60)
  const minutes = cron.minutes.length === 60
    ? `every minute`
    : step !== undefined
    ? `every ${step} minutes`
    : cron.minutes.length === 1
    ? `every hour at minute ${cron.minutes[0]}`
    : `every hour at minutes ${list(cron.minutes, String)}`
  if (cron.hours.length === 24) return minutes
  return `${minutes} during hour${cron.hours.length > 1 ? `s` : ``} ${list(cron.hours, pad)} UTC`
}

/**
 * The day part: `every Monday`, `on day 1 of the month`, or both joined by the OR or AND rule;
 * `undefined` when every day matches.
 */
function dayPhrase(cron: CronSchedule): string | undefined {
  const allMonthDays = cron.daysOfMonth.length === 31
  const allWeekdays = cron.daysOfWeek.length === 7
  const or = cron.dayOfMonthRestricted && cron.dayOfWeekRestricted
  if (or ? allMonthDays || allWeekdays : allMonthDays && allWeekdays) return undefined
  const weekdays = list(cron.daysOfWeek, (day) => WEEKDAY_LABELS[day])
  const monthDays = `on day${cron.daysOfMonth.length > 1 ? `s` : ``} ${
    list(cron.daysOfMonth, String)
  } of the month`
  if (allMonthDays) return `every ${weekdays}`
  if (allWeekdays) return monthDays
  return or
    ? `${monthDays} or every ${weekdays}`
    : `${monthDays} if it is a ${list(cron.daysOfWeek, (day) => WEEKDAY_LABELS[day], orFormat)}`
}

/** The step of `0, n, 2n, …` covering the whole field, or `undefined` when the values are not. */
function evenStep(values: readonly number[], size: number): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined
  const step = values[1]
  if (values.length !== Math.ceil(size / step)) return undefined
  return values.every((value, index) => value === index * step) ? step : undefined
}

const listFormat = new Intl.ListFormat(`en-GB`, { type: `conjunction` })
const orFormat = new Intl.ListFormat(`en-GB`, { type: `disjunction` })

/** Joins values in English, writing three or more consecutive ones as `a to b`. */
function list(
  values: readonly number[],
  label: (value: number) => string,
  format: Intl.ListFormat = listFormat,
): string {
  const parts: string[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end++
    if (end - start >= 2) parts.push(`${label(values[start])} to ${label(values[end])}`)
    else for (let index = start; index <= end; index++) parts.push(label(values[index]))
    start = end + 1
  }
  return format.format(parts)
}

function pad(value: number): string {
  return String(value).padStart(2, `0`)
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
