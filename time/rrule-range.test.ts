// Behaviour tests for `occurrencesBetween`. Expected dates come from the calendar and RFC 5545
// section 3.3.10, not from the implementation. Deterministic: explicit zones, no host clock.

import { assert, assertEquals, assertThrows } from "@std/assert"
import { IcalDateKind, type IcalDateValue, resolveInstant } from "./ical.ts"
import {
  nextOccurrence,
  occurrencesBetween,
  type OccurrencesBetweenOptions,
  parseRrule,
  type Rrule,
  RruleErrorCode,
  RruleMonthEnd,
} from "./rrule.ts"

function rule(text: string): Rrule {
  const result = parseRrule(text)
  if (!result.success) throw new Error(`${text}: ${result.error.message}`)
  return result.output
}

const utc = (date: string, time = `09:00:00`): IcalDateValue => ({
  kind: IcalDateKind.Utc,
  date,
  time,
})
const berlin = (date: string, time = `09:00:00`): IcalDateValue => ({
  kind: IcalDateKind.Zoned,
  date,
  time,
  tzid: `Europe/Berlin`,
})
const day = (date: string): IcalDateValue => ({ kind: IcalDateKind.Date, date })

function between(
  text: string,
  options: Omit<OccurrencesBetweenOptions, `from` | `to`> & { from: string; to: string },
): IcalDateValue[] {
  const result = occurrencesBetween(rule(text), {
    ...options,
    from: new Date(options.from),
    to: new Date(options.to),
  })
  if (!result.success) throw new Error(`${text}: ${result.error.message}`)
  return result.output
}

const dates = (values: IcalDateValue[]): string[] => values.map((value) => value.date)

Deno.test(`occurrencesBetween skips months without day 31 when asked to, as RFC 5545 says`, () => {
  const found = between(`FREQ=MONTHLY;BYMONTHDAY=31`, {
    start: utc(`2026-01-31`),
    from: `2026-01-01T00:00:00Z`,
    to: `2026-06-30T23:59:59Z`,
    monthEnd: RruleMonthEnd.Skip,
  })
  assertEquals(dates(found), [`2026-01-31`, `2026-03-31`, `2026-05-31`])
})

Deno.test(`occurrencesBetween clips day 31 to the month's last day by default, as nextOccurrence does`, () => {
  const found = between(`FREQ=MONTHLY;BYMONTHDAY=31`, {
    start: utc(`2026-01-31`),
    from: `2026-01-01T00:00:00Z`,
    to: `2026-06-30T23:59:59Z`,
  })
  assertEquals(dates(found), [
    `2026-01-31`,
    `2026-02-28`,
    `2026-03-31`,
    `2026-04-30`,
    `2026-05-31`,
    `2026-06-30`,
  ])
})

Deno.test(`occurrencesBetween puts BYMONTHDAY=-1 on the last day of every month`, () => {
  const expected = [
    `2026-01-31`,
    `2026-02-28`,
    `2026-03-31`,
    `2026-04-30`,
    `2026-05-31`,
    `2026-06-30`,
  ]
  for (const monthEnd of [RruleMonthEnd.Clip, RruleMonthEnd.Skip]) {
    const found = between(`FREQ=MONTHLY;BYMONTHDAY=-1`, {
      start: utc(`2026-01-31`),
      from: `2026-01-01T00:00:00Z`,
      to: `2026-06-30T23:59:59Z`,
      monthEnd,
    })
    assertEquals(dates(found), expected, `monthEnd ${monthEnd}`)
  }
})

Deno.test(`occurrencesBetween keeps a weekly 09:00 in Berlin at 09:00 across both clock changes`, () => {
  const found = between(`FREQ=WEEKLY`, {
    start: berlin(`2026-03-20`),
    from: `2026-03-20T00:00:00Z`,
    to: `2026-11-06T23:59:59Z`,
  })
  assertEquals(found.length, 34)
  for (const value of found) {
    assertEquals([value.kind, value.time, value.tzid], [
      IcalDateKind.Zoned,
      `09:00:00`,
      `Europe/Berlin`,
    ])
  }
  const instant = (date: string) => {
    const value = found.find((item) => item.date === date)
    assert(value, `${date} is in the range`)
    return resolveInstant(value)!.toISOString()
  }
  // Winter time is UTC+1, summer time UTC+2; the clocks change on 29 March and 25 October 2026.
  assertEquals(instant(`2026-03-27`), `2026-03-27T08:00:00.000Z`)
  assertEquals(instant(`2026-04-03`), `2026-04-03T07:00:00.000Z`)
  assertEquals(instant(`2026-10-23`), `2026-10-23T07:00:00.000Z`)
  assertEquals(instant(`2026-10-30`), `2026-10-30T08:00:00.000Z`)
})

Deno.test(`occurrencesBetween includes an occurrence exactly at either end of the range`, () => {
  const found = between(`FREQ=DAILY`, {
    start: utc(`2026-05-01`),
    from: `2026-05-03T09:00:00Z`,
    to: `2026-05-05T09:00:00Z`,
  })
  assertEquals(dates(found), [`2026-05-03`, `2026-05-04`, `2026-05-05`])
  const inside = between(`FREQ=DAILY`, {
    start: utc(`2026-05-01`),
    from: `2026-05-03T09:00:01Z`,
    to: `2026-05-05T08:59:59Z`,
  })
  assertEquals(dates(inside), [`2026-05-04`])
})

Deno.test(`occurrencesBetween reads a date-only series by its dates in the given zone`, () => {
  // 2026-05-02T22:00:00Z is already 3 May in Tokyo and still 2 May in UTC.
  const options = {
    start: day(`2026-05-01`),
    from: `2026-05-02T22:00:00Z`,
    to: `2026-05-04T00:00:00Z`,
  }
  assertEquals(dates(between(`FREQ=DAILY`, { ...options, timeZone: `Asia/Tokyo` })), [
    `2026-05-03`,
    `2026-05-04`,
  ])
  assertEquals(dates(between(`FREQ=DAILY`, options)), [`2026-05-02`, `2026-05-03`, `2026-05-04`])
})

Deno.test(`occurrencesBetween refuses more occurrences than the limit instead of cutting the list`, () => {
  const options = {
    start: utc(`2026-01-01`),
    from: new Date(`2026-01-01T00:00:00Z`),
    to: new Date(`2026-12-31T23:59:59Z`),
  }
  const tooMany = occurrencesBetween(rule(`FREQ=DAILY`), { ...options, limit: 364 })
  assert(!tooMany.success)
  assertEquals(tooMany.error.code, RruleErrorCode.SearchLimit)
  const exact = occurrencesBetween(rule(`FREQ=DAILY`), { ...options, limit: 365 })
  assert(exact.success)
  assertEquals(exact.output.length, 365)
  const byDefault = occurrencesBetween(rule(`FREQ=DAILY`), {
    ...options,
    to: new Date(`2028-12-31T23:59:59Z`),
  })
  assert(!byDefault.success, `1,096 days are more than the default limit of 1,000`)
  assertEquals(byDefault.error.code, RruleErrorCode.SearchLimit)
})

Deno.test(`occurrencesBetween gives the same dates as chaining nextOccurrence`, () => {
  const rules = [
    `FREQ=DAILY;INTERVAL=3`,
    `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH`,
    `FREQ=MONTHLY;BYDAY=-1FR`,
    `FREQ=MONTHLY;BYMONTHDAY=31`,
    `FREQ=MONTHLY;BYMONTHDAY=1,15,-1`,
    `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29`,
    `FREQ=WEEKLY;COUNT=10`,
    `FREQ=DAILY;UNTIL=20260415T080000Z`,
  ]
  const start = berlin(`2026-01-31`)
  const from = new Date(`2026-03-01T00:00:00Z`)
  const to = new Date(`2032-03-01T00:00:00Z`)
  for (const text of rules) {
    for (const monthEnd of [RruleMonthEnd.Clip, RruleMonthEnd.Skip]) {
      const chained: IcalDateValue[] = []
      let after = new Date(from.getTime() - 1)
      while (true) {
        const next = nextOccurrence(rule(text), { start, after, monthEnd })
        assert(next.success, text)
        if (next.output === null) break
        const at = resolveInstant(next.output)!
        if (at > to) break
        chained.push(next.output)
        after = at
      }
      const range = occurrencesBetween(rule(text), { start, from, to, monthEnd, limit: 5_000 })
      assert(range.success, text)
      assertEquals(range.output, chained, `${text} monthEnd ${monthEnd}`)
    }
  }
})

Deno.test(`occurrencesBetween stops where COUNT ends the series`, () => {
  const found = between(`FREQ=WEEKLY;COUNT=3`, {
    start: utc(`2026-01-05`),
    from: `2026-01-01T00:00:00Z`,
    to: `2026-12-31T00:00:00Z`,
  })
  assertEquals(dates(found), [`2026-01-05`, `2026-01-12`, `2026-01-19`])
})

Deno.test(`occurrencesBetween gives an empty list for a range that ends before it starts`, () => {
  const found = between(`FREQ=DAILY`, {
    start: utc(`2026-01-01`),
    from: `2026-02-01T00:00:00Z`,
    to: `2026-01-01T00:00:00Z`,
  })
  assertEquals(found, [])
})

Deno.test(`occurrencesBetween reports a rule that never matches`, () => {
  const result = occurrencesBetween(rule(`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`), {
    start: utc(`2026-01-01`),
    from: new Date(`2026-01-01T00:00:00Z`),
    to: new Date(`2027-01-01T00:00:00Z`),
  })
  assert(!result.success)
  assertEquals(result.error.code, RruleErrorCode.SearchLimit)
})

Deno.test(`occurrencesBetween refuses a start, zone or instant it cannot use`, () => {
  const good = { start: utc(`2026-01-01`), from: new Date(0), to: new Date(1) }
  const cases: OccurrencesBetweenOptions[] = [
    { ...good, start: { kind: IcalDateKind.Utc, date: `2026-02-30`, time: `09:00:00` } },
    { ...good, start: day(`2026-01-01`), timeZone: `Mars/Base` },
    { ...good, from: new Date(Number.NaN) },
    { ...good, to: new Date(Number.NaN) },
  ]
  for (const options of cases) {
    const result = occurrencesBetween(rule(`FREQ=DAILY`), options)
    assert(!result.success, JSON.stringify(options))
    assertEquals(result.error.code, RruleErrorCode.InvalidStart)
  }
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    assertThrows(() => occurrencesBetween(rule(`FREQ=DAILY`), { ...good, limit }), RangeError)
  }
})
