// Behaviour tests for cron schedules. Expected times are worked out from the calendar, not from
// the implementation. Deterministic: every moment is an explicit UTC instant.

import { assertEquals, assertThrows } from "@std/assert"
import { describeCron, nextCronRun, parseCron } from "./cron.ts"

function next(expression: string, after: string): string {
  return nextCronRun(expression, new Date(after)).toISOString()
}

Deno.test(`nextCronRun runs a daily job at the next 03:00, strictly after the last run`, () => {
  assertEquals(next(`0 3 * * *`, `2026-10-23T02:59:30Z`), `2026-10-23T03:00:00.000Z`)
  assertEquals(next(`0 3 * * *`, `2026-10-23T03:00:00.250Z`), `2026-10-24T03:00:00.000Z`)
  assertEquals(next(`0 3 * * *`, `2026-12-31T04:00:00Z`), `2027-01-01T03:00:00.000Z`)
})

Deno.test(`nextCronRun steps minutes, hours and ranges with a slash`, () => {
  assertEquals(next(`*/15 * * * *`, `2026-10-23T10:07:00Z`), `2026-10-23T10:15:00.000Z`)
  assertEquals(next(`*/15 * * * *`, `2026-10-23T10:45:00Z`), `2026-10-23T11:00:00.000Z`)
  assertEquals(next(`0 */6 * * *`, `2026-10-23T13:00:00Z`), `2026-10-23T18:00:00.000Z`)
  assertEquals(next(`0-30/10 9 * * *`, `2026-10-23T09:21:00Z`), `2026-10-23T09:30:00.000Z`)
  assertEquals(next(`0-30/10 9 * * *`, `2026-10-23T09:30:00Z`), `2026-10-24T09:00:00.000Z`)
  // `5/20` runs from 5 to the end of the field: 5, 25, 45.
  assertEquals(next(`5/20 * * * *`, `2026-10-23T09:30:00Z`), `2026-10-23T09:45:00.000Z`)
})

Deno.test(`nextCronRun keeps to ranges and lists of hours`, () => {
  assertEquals(next(`30 9-17 * * *`, `2026-10-23T17:30:00Z`), `2026-10-24T09:30:00.000Z`)
  assertEquals(next(`0 8,12,18 * * *`, `2026-10-23T12:00:00Z`), `2026-10-23T18:00:00.000Z`)
})

Deno.test(`nextCronRun reads month and weekday names in any case, and 7 as Sunday`, () => {
  // 2026-10-23 is a Friday.
  assertEquals(next(`0 9 * * mon`, `2026-10-23T00:00:00Z`), `2026-10-26T09:00:00.000Z`)
  assertEquals(next(`0 9 * * MON-FRI`, `2026-10-23T09:00:00Z`), `2026-10-26T09:00:00.000Z`)
  assertEquals(next(`0 9 * * 7`, `2026-10-23T00:00:00Z`), `2026-10-25T09:00:00.000Z`)
  assertEquals(next(`0 0 1 Jan,JUL *`, `2026-10-23T00:00:00Z`), `2027-01-01T00:00:00.000Z`)
})

Deno.test(`nextCronRun expands the aliases`, () => {
  const after = `2026-10-23T10:20:00Z`
  assertEquals(next(`@hourly`, after), `2026-10-23T11:00:00.000Z`)
  assertEquals(next(`@daily`, after), `2026-10-24T00:00:00.000Z`)
  assertEquals(next(`@midnight`, after), `2026-10-24T00:00:00.000Z`)
  assertEquals(next(`@weekly`, after), `2026-10-25T00:00:00.000Z`)
  assertEquals(next(`@monthly`, after), `2026-11-01T00:00:00.000Z`)
  assertEquals(next(`@yearly`, after), `2027-01-01T00:00:00.000Z`)
  assertEquals(next(`@ANNUALLY`, after), `2027-01-01T00:00:00.000Z`)
})

Deno.test(`nextCronRun skips months that lack the day, and finds month ends`, () => {
  assertEquals(next(`0 0 31 * *`, `2026-04-01T00:00:00Z`), `2026-05-31T00:00:00.000Z`)
  assertEquals(next(`0 0 30 * *`, `2026-01-30T00:00:00Z`), `2026-03-30T00:00:00.000Z`)
  assertEquals(next(`59 23 28-31 * *`, `2026-02-28T23:59:00Z`), `2026-03-28T23:59:00.000Z`)
})

Deno.test(`nextCronRun waits for the next leap day`, () => {
  assertEquals(next(`0 12 29 2 *`, `2026-10-23T00:00:00Z`), `2028-02-29T12:00:00.000Z`)
  assertEquals(next(`0 12 29 2 *`, `2096-03-01T00:00:00Z`), `2104-02-29T12:00:00.000Z`)
})

Deno.test(`nextCronRun matches either day field when both are restricted`, () => {
  // The 1st or any Monday. After Friday 2026-10-23: Monday the 26th, then 1 November (a Sunday).
  assertEquals(next(`0 0 1 * MON`, `2026-10-23T00:00:00Z`), `2026-10-26T00:00:00.000Z`)
  assertEquals(next(`0 0 1 * MON`, `2026-10-26T00:00:00Z`), `2026-11-01T00:00:00.000Z`)
})

Deno.test(`nextCronRun needs both day fields when one starts with a star`, () => {
  // Odd days that are also Mondays: 2026-11-09 is the first after 2026-10-23.
  assertEquals(next(`0 0 */2 * MON`, `2026-10-23T00:00:00Z`), `2026-11-09T00:00:00.000Z`)
  assertEquals(next(`0 0 13 * *`, `2026-10-23T00:00:00Z`), `2026-11-13T00:00:00.000Z`)
})

Deno.test(`nextCronRun takes a parsed schedule as well as text`, () => {
  const schedule = parseCron(`0 3 * * *`)
  assertEquals(
    nextCronRun(schedule, new Date(`2026-10-23T05:00:00Z`)).toISOString(),
    `2026-10-24T03:00:00.000Z`,
  )
})

Deno.test(`nextCronRun refuses an invalid date`, () => {
  assertThrows(() => nextCronRun(`* * * * *`, new Date(`nope`)), RangeError, `after`)
})

Deno.test(`parseCron refuses bad input with a RangeError naming the field`, () => {
  const cases: [string, string][] = [
    [`* * * *`, `expected 5 fields`],
    [`* * * * * *`, `expected 5 fields`],
    [``, `expected 5 fields`],
    [`@reboot`, `unknown alias`],
    [`60 * * * *`, `minute: "60" is out of range 0-59`],
    [`0 24 * * *`, `hour: "24" is out of range 0-23`],
    [`0 0 0 * *`, `day-of-month: "0" is out of range 1-31`],
    [`0 0 * 13 *`, `month: "13" is out of range 1-12`],
    [`0 0 * * 8`, `day-of-week: "8" is out of range 0-7`],
    [`0 0 * FOO *`, `month: "FOO" is not a number or a name`],
    [`x * * * *`, `minute: "x" is not a number`],
    [`*/0 * * * *`, `minute: "*/0" needs a step of at least 1`],
    [`1/2/3 * * * *`, `minute: "1/2/3" has more than one step`],
    [`0 17-9 * * *`, `hour: "17-9" runs backwards`],
    [`0 1-2-3 * * *`, `hour: "1-2-3" is not a value or a range`],
    [`0 0 30 2 *`, `day-of-month: "30" never falls in the months "2"`],
    [`0 0 31 4,6 *`, `day-of-month`],
  ]
  for (const [expression, message] of cases) {
    assertThrows(() => parseCron(expression), RangeError, message)
  }
})

Deno.test(`parseCron accepts a day that only some chosen months have`, () => {
  assertEquals(parseCron(`0 0 31 2,3 *`).daysOfMonth, [31])
  // With both day fields restricted the weekday alone can match, so the month never needs the 30th.
  assertEquals(parseCron(`0 0 30 2 MON`).daysOfWeek, [1])
})

Deno.test(`describeCron labels common schedules`, () => {
  const cases: [string, string][] = [
    [`0 3 * * *`, `Every day at 03:00 UTC`],
    [`@daily`, `Every day at 00:00 UTC`],
    [`30 9 * * MON`, `Every Monday at 09:30 UTC`],
    [`0 9 * * 1-5`, `Every Monday to Friday at 09:00 UTC`],
    [`0 9,17 * * *`, `Every day at 09:00 and 17:00 UTC`],
    [`0 0 1 * *`, `On day 1 of the month at 00:00 UTC`],
    [`0 0 1 1 *`, `On day 1 of the month in January at 00:00 UTC`],
    [`0 0 1,15 * *`, `On days 1 and 15 of the month at 00:00 UTC`],
    [`0 0 1 * MON`, `On day 1 of the month or every Monday at 00:00 UTC`],
    [`0 12 */10 * FRI`, `On days 1, 11, 21 and 31 of the month if it is a Friday at 12:00 UTC`],
    [`* * * * *`, `Every minute`],
    [`*/15 * * * *`, `Every 15 minutes`],
    [`@hourly`, `Every hour at minute 0`],
    [`0,30 * * * *`, `Every 30 minutes`],
    [`5,35 * * * *`, `Every hour at minutes 5 and 35`],
    [`*/5 9-17 * * 1-5`, `Every 5 minutes during hours 09 to 17 UTC, every Monday to Friday`],
    [`0 * * 1 *`, `Every hour at minute 0, every day in January`],
    [`0 0 1-31 * MON`, `Every day at 00:00 UTC`],
  ]
  for (const [expression, label] of cases) assertEquals(describeCron(expression), label, expression)
})
