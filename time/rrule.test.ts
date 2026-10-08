// Behaviour tests for repeat rules. Tables are written from RFC 5545 section 3.3.10, not from the
// implementation. `testdata/tasks-org-rrules.txt` holds the 18 `RRULE` lines of the owner's
// Tasks.org tasks (rule text only). Deterministic: explicit zones, no host clock.

import { assert, assertEquals } from "@std/assert"
import { IcalDateKind, type IcalDateValue, resolveInstant } from "./ical.ts"
import {
  describeRrule,
  nextOccurrence,
  parseRrule,
  type Rrule,
  RruleErrorCode,
  RruleFreq,
  RruleWeekday,
} from "./rrule.ts"

function rule(text: string): Rrule {
  const result = parseRrule(text)
  if (!result.success) throw new Error(`${text}: ${result.error.message}`)
  return result.output
}

/** `2026-03-31T09:00:00Z`-style label of a value, so kind and zone show in the table. */
function label(value: IcalDateValue | null): string {
  if (value === null) return `none`
  const time = value.time ? `T${value.time}` : ``
  switch (value.kind) {
    case IcalDateKind.Date:
      return value.date
    case IcalDateKind.Floating:
      return `${value.date}${time}`
    case IcalDateKind.Utc:
      return `${value.date}${time}Z`
    case IcalDateKind.Zoned:
      return `${value.date}${time}[${value.tzid}]`
  }
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

function next(
  text: string,
  start: IcalDateValue,
  after: string,
  timeZone?: string,
): string {
  const result = nextOccurrence(rule(text), { start, after: new Date(after), timeZone })
  if (!result.success) throw new Error(`${text}: ${result.error.message}`)
  return label(result.output)
}

Deno.test(`parseRrule reads every part of the subset`, () => {
  const parsed = rule(
    `RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO,-1FR,TU;BYMONTHDAY=1,-1;BYMONTH=3,9;UNTIL=20271231T235959Z;WKST=SU`,
  )
  assertEquals(parsed.freq, RruleFreq.Monthly)
  assertEquals(parsed.interval, 2)
  assertEquals(parsed.byDay, [
    { weekday: RruleWeekday.Monday, ordinal: 2 },
    { weekday: RruleWeekday.Friday, ordinal: -1 },
    { weekday: RruleWeekday.Tuesday },
  ])
  assertEquals(parsed.byMonthDay, [1, -1])
  assertEquals(parsed.byMonth, [3, 9])
  assertEquals(parsed.until, { kind: IcalDateKind.Utc, date: `2027-12-31`, time: `23:59:59` })
  assertEquals(parsed.weekStart, RruleWeekday.Sunday)
  assertEquals(rule(`freq=daily;count=4`).count, 4)
  assertEquals(rule(`FREQ=DAILY;UNTIL=20270101`).until, {
    kind: IcalDateKind.Date,
    date: `2027-01-01`,
  })
})

Deno.test(`parseRrule refuses parts outside the subset and names the part`, () => {
  const table: [string, string][] = [
    [`FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU`, `BYSETPOS`],
    [`FREQ=DAILY;BYHOUR=9`, `BYHOUR`],
    [`FREQ=DAILY;BYMINUTE=5`, `BYMINUTE`],
    [`FREQ=DAILY;BYSECOND=5`, `BYSECOND`],
    [`FREQ=YEARLY;BYWEEKNO=20`, `BYWEEKNO`],
    [`FREQ=YEARLY;BYYEARDAY=100`, `BYYEARDAY`],
    [`FREQ=HOURLY`, `FREQ`],
    [`FREQ=MINUTELY;INTERVAL=5`, `FREQ`],
    [`FREQ=SECONDLY`, `FREQ`],
    [`FREQ=DAILY;X-VENDOR=1`, `X-VENDOR`],
    [`FREQ=DAILY;RSCALE=HEBREW`, `RSCALE`],
    [`FREQ=WEEKLY;BYDAY=2MO`, `BYDAY`],
    [`FREQ=YEARLY;BYDAY=1MO`, `BYDAY`],
    [`FREQ=YEARLY;BYDAY=MO`, `BYDAY`],
    [`FREQ=YEARLY;BYMONTH=11;BYDAY=4TH`, `BYDAY`],
    [`FREQ=DAILY;BYDAY=MO,TU`, `BYDAY`],
    [`FREQ=WEEKLY;BYMONTHDAY=3`, `BYMONTHDAY`],
    [`FREQ=HOURLY;BYHOUR=3`, `FREQ`],
  ]
  for (const [text, part] of table) {
    const result = parseRrule(text)
    assert(!result.success, `${text} should be refused`)
    assertEquals(result.error.code, RruleErrorCode.Unsupported, text)
    assertEquals(result.error.part, part, text)
    assertEquals(result.output, null)
  }
})

Deno.test(`parseRrule reports a broken rule as malformed`, () => {
  const table: [string, string | undefined][] = [
    [``, undefined],
    [`FREQ`, undefined],
    [`INTERVAL=2`, `FREQ`],
    [`FREQ=FORTNIGHTLY`, `FREQ`],
    [`FREQ=DAILY;FREQ=WEEKLY`, `FREQ`],
    [`FREQ=DAILY;INTERVAL=0`, `INTERVAL`],
    [`FREQ=DAILY;INTERVAL=x`, `INTERVAL`],
    [`FREQ=DAILY;COUNT=0`, `COUNT`],
    [`FREQ=DAILY;COUNT=2;UNTIL=20270101`, `UNTIL`],
    [`FREQ=DAILY;UNTIL=20271301`, `UNTIL`],
    [`FREQ=DAILY;UNTIL=20270230`, `UNTIL`],
    [`FREQ=MONTHLY;BYDAY=0MO`, `BYDAY`],
    [`FREQ=MONTHLY;BYDAY=6MO`, `BYDAY`],
    [`FREQ=MONTHLY;BYDAY=XX`, `BYDAY`],
    [`FREQ=MONTHLY;BYDAY=`, `BYDAY`],
    [`FREQ=MONTHLY;BYMONTHDAY=0`, `BYMONTHDAY`],
    [`FREQ=MONTHLY;BYMONTHDAY=32`, `BYMONTHDAY`],
    [`FREQ=YEARLY;BYMONTH=13`, `BYMONTH`],
    [`FREQ=YEARLY;BYMONTH=5L`, `BYMONTH`],
    [`FREQ=WEEKLY;WKST=XX`, `WKST`],
  ]
  for (const [text, part] of table) {
    const result = parseRrule(text)
    assert(!result.success, `${JSON.stringify(text)} should be refused`)
    assertEquals(result.error.code, RruleErrorCode.Malformed, text)
    assertEquals(result.error.part, part, text)
  }
})

interface Row {
  name: string
  rule: string
  start: IcalDateValue
  /** Each `after` instant and the occurrence expected after it. */
  steps: [after: string, expected: string][]
  timeZone?: string
}

const rows: Row[] = [
  {
    name: `every 3 days counts from the start`,
    rule: `FREQ=DAILY;INTERVAL=3`,
    start: utc(`2026-01-30`),
    steps: [
      [`2026-01-29T00:00:00Z`, `2026-01-30T09:00:00Z`],
      [`2026-01-30T09:00:00Z`, `2026-02-02T09:00:00Z`],
      [`2026-02-02T09:00:01Z`, `2026-02-05T09:00:00Z`],
      [`2026-12-30T00:00:00Z`, `2027-01-01T09:00:00Z`],
    ],
  },
  {
    name: `every 2 weeks on Mon and Thu starts the pair in the start's week`,
    rule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH`,
    start: utc(`2026-01-01`),
    steps: [
      [`2026-01-01T09:00:00Z`, `2026-01-12T09:00:00Z`],
      [`2026-01-12T09:00:00Z`, `2026-01-15T09:00:00Z`],
      [`2026-01-15T09:00:00Z`, `2026-01-26T09:00:00Z`],
    ],
  },
  {
    name: `weekly without BYDAY repeats on the start's weekday`,
    rule: `FREQ=WEEKLY`,
    start: utc(`2026-01-07`),
    steps: [[`2026-01-07T09:00:00Z`, `2026-01-14T09:00:00Z`]],
  },
  {
    name: `WKST=SU changes which days share a week (RFC 5545 example)`,
    rule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU`,
    start: utc(`2026-01-04`),
    steps: [
      [`2026-01-04T09:00:00Z`, `2026-01-06T09:00:00Z`],
      [`2026-01-06T09:00:00Z`, `2026-01-18T09:00:00Z`],
    ],
  },
  {
    name: `WKST=MO puts the same Sunday at the end of its week`,
    rule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=MO`,
    start: utc(`2026-01-04`),
    steps: [
      [`2026-01-04T09:00:00Z`, `2026-01-13T09:00:00Z`],
      [`2026-01-13T09:00:00Z`, `2026-01-18T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the 31st falls back to the month's last day, as Tasks.org does`,
    rule: `FREQ=MONTHLY`,
    start: utc(`2017-01-31`),
    steps: [
      [`2017-01-31T09:00:00Z`, `2017-02-28T09:00:00Z`],
      [`2017-02-28T09:00:00Z`, `2017-03-31T09:00:00Z`],
      [`2017-03-31T09:00:00Z`, `2017-04-30T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the 31st lands on 29 February in a leap year`,
    rule: `FREQ=MONTHLY;BYMONTHDAY=31`,
    start: utc(`2028-01-31`),
    steps: [[`2028-01-31T09:00:00Z`, `2028-02-29T09:00:00Z`]],
  },
  {
    name: `every 6 months from 30 August ends on 28 February`,
    rule: `FREQ=MONTHLY;INTERVAL=6`,
    start: utc(`2026-08-30`),
    steps: [
      [`2026-08-30T09:00:00Z`, `2027-02-28T09:00:00Z`],
      [`2027-02-28T09:00:00Z`, `2027-08-30T09:00:00Z`],
    ],
  },
  {
    name: `several month days skip a month that lacks one`,
    rule: `FREQ=MONTHLY;BYMONTHDAY=30,31`,
    start: utc(`2027-12-30`),
    steps: [
      [`2027-12-30T09:00:00Z`, `2027-12-31T09:00:00Z`],
      [`2027-12-31T09:00:00Z`, `2028-01-30T09:00:00Z`],
      [`2028-01-31T09:00:00Z`, `2028-03-30T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the 29th keeps 29 February in a leap year`,
    rule: `FREQ=MONTHLY`,
    start: utc(`2028-01-29`),
    steps: [
      [`2028-01-29T09:00:00Z`, `2028-02-29T09:00:00Z`],
      [`2028-02-29T09:00:00Z`, `2028-03-29T09:00:00Z`],
    ],
  },
  {
    name: `every 3 months from the 31st`,
    rule: `FREQ=MONTHLY;INTERVAL=3`,
    start: utc(`2026-01-31`),
    steps: [
      [`2026-01-31T09:00:00Z`, `2026-04-30T09:00:00Z`],
      [`2026-04-30T09:00:00Z`, `2026-07-31T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the last day lands on 28, 29, 30 and 31`,
    rule: `FREQ=MONTHLY;BYMONTHDAY=-1`,
    start: utc(`2027-12-31`),
    steps: [
      [`2027-12-31T09:00:00Z`, `2028-01-31T09:00:00Z`],
      [`2028-01-31T09:00:00Z`, `2028-02-29T09:00:00Z`],
      [`2028-02-29T09:00:00Z`, `2028-03-31T09:00:00Z`],
      [`2028-03-31T09:00:00Z`, `2028-04-30T09:00:00Z`],
      [`2028-12-31T09:00:00Z`, `2029-01-31T09:00:00Z`],
      [`2029-01-31T09:00:00Z`, `2029-02-28T09:00:00Z`],
    ],
  },
  {
    name: `monthly on days 1 and 15 gives both days of each month`,
    rule: `FREQ=MONTHLY;BYMONTHDAY=15,1`,
    start: utc(`2026-01-01`),
    steps: [
      [`2026-01-01T09:00:00Z`, `2026-01-15T09:00:00Z`],
      [`2026-01-15T09:00:00Z`, `2026-02-01T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the second Monday`,
    rule: `FREQ=MONTHLY;BYDAY=2MO`,
    start: utc(`2026-01-12`),
    steps: [
      [`2026-01-12T09:00:00Z`, `2026-02-09T09:00:00Z`],
      [`2026-02-09T09:00:00Z`, `2026-03-09T09:00:00Z`],
      [`2026-03-09T09:00:00Z`, `2026-04-13T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the last Friday`,
    rule: `FREQ=MONTHLY;BYDAY=-1FR`,
    start: utc(`2026-01-30`),
    steps: [
      [`2026-01-30T09:00:00Z`, `2026-02-27T09:00:00Z`],
      [`2026-02-27T09:00:00Z`, `2026-03-27T09:00:00Z`],
      [`2026-03-27T09:00:00Z`, `2026-04-24T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the fifth Monday skips months with four`,
    rule: `FREQ=MONTHLY;BYDAY=5MO`,
    start: utc(`2026-03-30`),
    steps: [
      [`2026-03-30T09:00:00Z`, `2026-06-29T09:00:00Z`],
      [`2026-06-29T09:00:00Z`, `2026-08-31T09:00:00Z`],
    ],
  },
  {
    name: `monthly on the second-to-last Sunday`,
    rule: `FREQ=MONTHLY;BYDAY=-2SU`,
    start: utc(`2026-01-18`),
    steps: [[`2026-01-18T09:00:00Z`, `2026-02-15T09:00:00Z`]],
  },
  {
    name: `monthly on the first and the last Friday gives both in order`,
    rule: `FREQ=MONTHLY;BYDAY=-1FR,1FR`,
    start: utc(`2026-01-02`),
    steps: [
      [`2026-01-02T09:00:00Z`, `2026-01-30T09:00:00Z`],
      [`2026-01-30T09:00:00Z`, `2026-02-06T09:00:00Z`],
    ],
  },
  {
    name: `monthly on every Friday that is the 13th`,
    rule: `FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13`,
    start: utc(`2026-01-01`),
    steps: [
      [`2026-01-01T09:00:00Z`, `2026-02-13T09:00:00Z`],
      [`2026-02-13T09:00:00Z`, `2026-03-13T09:00:00Z`],
      [`2026-03-13T09:00:00Z`, `2026-11-13T09:00:00Z`],
    ],
  },
  {
    name: `monthly limited to March and September`,
    rule: `FREQ=MONTHLY;BYMONTH=3,9`,
    start: utc(`2026-03-10`),
    steps: [
      [`2026-03-10T09:00:00Z`, `2026-09-10T09:00:00Z`],
      [`2026-09-10T09:00:00Z`, `2027-03-10T09:00:00Z`],
    ],
  },
  {
    name: `yearly on 29 February waits for the next leap year`,
    rule: `FREQ=YEARLY`,
    start: utc(`2024-02-29`),
    steps: [
      [`2024-02-29T09:00:00Z`, `2028-02-29T09:00:00Z`],
      [`2096-02-29T09:00:00Z`, `2104-02-29T09:00:00Z`],
    ],
  },
  {
    name: `every 2 years keeps the start's month and day`,
    rule: `FREQ=YEARLY;INTERVAL=2`,
    start: utc(`2026-06-15`),
    steps: [[`2026-06-15T09:00:00Z`, `2028-06-15T09:00:00Z`]],
  },
  {
    name: `yearly in two months on one day each`,
    rule: `FREQ=YEARLY;BYMONTH=6,3;BYMONTHDAY=1`,
    start: utc(`2026-03-01`),
    steps: [
      [`2026-03-01T09:00:00Z`, `2026-06-01T09:00:00Z`],
      [`2026-06-01T09:00:00Z`, `2027-03-01T09:00:00Z`],
    ],
  },
  {
    name: `yearly on the last day of February`,
    rule: `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1`,
    start: utc(`2026-02-28`),
    steps: [[`2026-02-28T09:00:00Z`, `2027-02-28T09:00:00Z`]],
  },
  {
    name: `daily limited to the first of the month`,
    rule: `FREQ=DAILY;BYMONTHDAY=1`,
    start: utc(`2026-01-01`),
    steps: [[`2026-01-01T09:00:00Z`, `2026-02-01T09:00:00Z`]],
  },
  {
    name: `COUNT ends the series after that many occurrences`,
    rule: `FREQ=DAILY;COUNT=3`,
    start: utc(`2026-01-01`),
    steps: [
      [`2025-12-01T00:00:00Z`, `2026-01-01T09:00:00Z`],
      [`2026-01-01T09:00:00Z`, `2026-01-02T09:00:00Z`],
      [`2026-01-02T09:00:00Z`, `2026-01-03T09:00:00Z`],
      [`2026-01-03T09:00:00Z`, `none`],
      [`2030-01-01T00:00:00Z`, `none`],
    ],
  },
  {
    name: `COUNT counts occurrences of a multi-day week`,
    rule: `FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3`,
    start: utc(`2026-01-05`),
    steps: [
      [`2026-01-05T09:00:00Z`, `2026-01-07T09:00:00Z`],
      [`2026-01-07T09:00:00Z`, `2026-01-12T09:00:00Z`],
      [`2026-01-12T09:00:00Z`, `none`],
    ],
  },
  {
    name: `COUNT counts a clipped month once`,
    rule: `FREQ=MONTHLY;COUNT=3`,
    start: utc(`2026-01-31`),
    steps: [
      [`2026-01-31T09:00:00Z`, `2026-02-28T09:00:00Z`],
      [`2026-02-28T09:00:00Z`, `2026-03-31T09:00:00Z`],
      [`2026-03-31T09:00:00Z`, `none`],
    ],
  },
  {
    name: `COUNT does not count a month that lacks one of several days`,
    rule: `FREQ=MONTHLY;BYMONTHDAY=30,31;COUNT=3`,
    start: utc(`2027-12-30`),
    steps: [[`2027-12-31T09:00:00Z`, `2028-01-30T09:00:00Z`], [`2028-01-30T09:00:00Z`, `none`]],
  },
  {
    name: `UNTIL as a UTC time includes an occurrence at that very instant`,
    rule: `FREQ=DAILY;UNTIL=20260103T090000Z`,
    start: utc(`2026-01-01`),
    steps: [[`2026-01-02T09:00:00Z`, `2026-01-03T09:00:00Z`], [`2026-01-03T09:00:00Z`, `none`]],
  },
  {
    name: `UNTIL as a UTC time excludes an occurrence one second later`,
    rule: `FREQ=DAILY;UNTIL=20260103T085959Z`,
    start: utc(`2026-01-01`),
    steps: [[`2026-01-02T09:00:00Z`, `none`]],
  },
  {
    name: `UNTIL as a date includes occurrences on that date`,
    rule: `FREQ=DAILY;UNTIL=20260103`,
    start: berlin(`2026-01-01`, `23:30:00`),
    steps: [
      [`2026-01-02T22:30:00Z`, `2026-01-03T23:30:00[Europe/Berlin]`],
      [`2026-01-03T22:30:00Z`, `none`],
    ],
  },
  {
    name: `a date-only start stays date-only`,
    rule: `FREQ=WEEKLY;BYDAY=MO`,
    start: { kind: IcalDateKind.Date, date: `2026-01-05` },
    steps: [
      [`2026-01-05T00:00:00Z`, `2026-01-12`],
      [`2026-01-04T23:59:59Z`, `2026-01-05`],
      [`2025-12-01T00:00:00Z`, `2026-01-05`],
    ],
  },
  {
    name: `a date-only start reads the instant in the given zone`,
    rule: `FREQ=DAILY`,
    start: { kind: IcalDateKind.Date, date: `2026-03-01` },
    timeZone: `Pacific/Auckland`,
    steps: [
      // 23:00Z on 1 March is already 2 March 12:00 in Auckland.
      [`2026-03-01T23:00:00Z`, `2026-03-03`],
    ],
  },
  {
    name: `a floating start stays floating and reads the instant in the given zone`,
    rule: `FREQ=DAILY`,
    start: { kind: IcalDateKind.Floating, date: `2026-03-28`, time: `09:00:00` },
    timeZone: `Europe/Berlin`,
    steps: [
      // 08:00Z is 09:00 in Berlin on 28 March: not strictly before the occurrence.
      [`2026-03-28T08:00:00Z`, `2026-03-29T09:00:00`],
      [`2026-03-28T07:59:59Z`, `2026-03-28T09:00:00`],
    ],
  },
  {
    name: `a floating start is read as UTC without a zone`,
    rule: `FREQ=DAILY`,
    start: { kind: IcalDateKind.Floating, date: `2026-03-28`, time: `09:00:00` },
    steps: [[`2026-03-28T09:00:00Z`, `2026-03-29T09:00:00`]],
  },
  {
    name: `a zoned start keeps its zone`,
    rule: `FREQ=WEEKLY`,
    start: {
      kind: IcalDateKind.Zoned,
      date: `2026-01-05`,
      time: `18:15:30`,
      tzid: `America/New_York`,
    },
    steps: [[`2026-01-05T23:15:30Z`, `2026-01-12T18:15:30[America/New_York]`]],
  },
  {
    name: `daily at 09:00 in Berlin stays at 09:00 wall clock through spring forward`,
    rule: `FREQ=DAILY`,
    start: berlin(`2026-03-27`),
    steps: [
      [`2026-03-28T08:00:00Z`, `2026-03-29T09:00:00[Europe/Berlin]`],
      [`2026-03-29T07:00:00Z`, `2026-03-30T09:00:00[Europe/Berlin]`],
    ],
  },
  {
    name: `daily at 09:00 in Berlin stays at 09:00 wall clock through fall back`,
    rule: `FREQ=DAILY`,
    start: berlin(`2026-10-23`),
    steps: [
      [`2026-10-24T07:00:00Z`, `2026-10-25T09:00:00[Europe/Berlin]`],
      [`2026-10-25T08:00:00Z`, `2026-10-26T09:00:00[Europe/Berlin]`],
    ],
  },
  {
    name: `a wall clock skipped by spring forward keeps its date`,
    rule: `FREQ=WEEKLY`,
    start: berlin(`2026-03-22`, `02:30:00`),
    steps: [
      [`2026-03-22T01:30:00Z`, `2026-03-29T02:30:00[Europe/Berlin]`],
      [`2026-03-29T01:30:00Z`, `2026-04-05T02:30:00[Europe/Berlin]`],
    ],
  },
  {
    name: `a wall clock repeated by fall back occurs once, at its first reading`,
    rule: `FREQ=DAILY`,
    start: berlin(`2026-10-24`, `02:30:00`),
    steps: [
      // 02:30 on 25 October is 00:30Z (summer time) and again 01:30Z (winter time).
      [`2026-10-24T00:30:00Z`, `2026-10-25T02:30:00[Europe/Berlin]`],
      [`2026-10-25T00:30:00Z`, `2026-10-26T02:30:00[Europe/Berlin]`],
      [`2026-10-25T01:30:00Z`, `2026-10-26T02:30:00[Europe/Berlin]`],
    ],
  },
  {
    name: `New York spring forward on a Sunday at 02:30`,
    rule: `FREQ=WEEKLY;BYDAY=SU`,
    start: {
      kind: IcalDateKind.Zoned,
      date: `2026-03-01`,
      time: `02:30:00`,
      tzid: `America/New_York`,
    },
    steps: [
      [`2026-03-01T07:30:00Z`, `2026-03-08T02:30:00[America/New_York]`],
      [`2026-03-08T07:30:00Z`, `2026-03-15T02:30:00[America/New_York]`],
    ],
  },
  {
    name: `monthly on the last Sunday in Berlin crosses both clock changes`,
    rule: `FREQ=MONTHLY;BYDAY=-1SU`,
    start: berlin(`2026-02-22`, `01:30:00`),
    steps: [
      [`2026-02-22T00:30:00Z`, `2026-03-29T01:30:00[Europe/Berlin]`],
      [`2026-03-29T00:30:00Z`, `2026-04-26T01:30:00[Europe/Berlin]`],
      [`2026-09-27T00:30:00Z`, `2026-10-25T01:30:00[Europe/Berlin]`],
    ],
  },
  {
    name: `a zoned monthly 31st falls back to the last day`,
    rule: `FREQ=MONTHLY`,
    start: berlin(`2026-01-31`),
    steps: [[`2026-01-31T08:00:00Z`, `2026-02-28T09:00:00[Europe/Berlin]`]],
  },
]

for (const row of rows) {
  Deno.test(`nextOccurrence: ${row.name}`, () => {
    for (const [after, expected] of row.steps) {
      assertEquals(
        next(row.rule, row.start, after, row.timeZone),
        expected,
        `${row.rule} after ${after}`,
      )
    }
  })
}

Deno.test(`nextOccurrence moves 23 hours over spring forward and 25 over fall back`, () => {
  const hours = (from: string, text: string, start: IcalDateValue) => {
    const result = nextOccurrence(rule(text), { start, after: new Date(from) })
    if (!result.success || !result.output) throw new Error(`no result`)
    return (resolveInstant(result.output)!.getTime() - new Date(from).getTime()) / 3_600_000
  }
  assertEquals(hours(`2026-03-28T08:00:00Z`, `FREQ=DAILY`, berlin(`2026-03-27`)), 23)
  assertEquals(hours(`2026-10-24T07:00:00Z`, `FREQ=DAILY`, berlin(`2026-10-23`)), 25)
})

Deno.test(`nextOccurrence chains due date to next date the way Tasks.org completes a task`, () => {
  // Tasks.org passes the due date as both start and after, even when the task is overdue, and
  // lowers COUNT by one per completion; the series ends when COUNT is 1.
  const chain = (text: string, due: string, count: number | null) => {
    const dates: string[] = []
    let current: IcalDateValue = utc(due)
    for (;;) {
      const rule_ = rule(count === null ? text : `${text};COUNT=${count}`)
      const result = nextOccurrence(rule_, {
        start: current,
        after: new Date(`${current.date}T${current.time}Z`),
      })
      if (!result.success) throw new Error(result.error.message)
      if (result.output === null) return dates
      dates.push(result.output.date)
      current = result.output
      if (count !== null) count--
    }
  }
  assertEquals(chain(`FREQ=MONTHLY`, `2026-01-31`, 3), [`2026-02-28`, `2026-03-28`])
  assertEquals(chain(`FREQ=WEEKLY;BYDAY=MO,TH`, `2026-01-01`, 4), [
    `2026-01-05`,
    `2026-01-08`,
    `2026-01-12`,
  ])
  assertEquals(chain(`FREQ=DAILY;INTERVAL=3`, `2026-12-30`, 2), [`2027-01-02`])
  assertEquals(chain(`FREQ=MONTHLY`, `2026-01-31`, 1), [])
})

Deno.test(`nextOccurrence answers a huge COUNT from a distant start in under a second`, () => {
  const began = performance.now()
  const result = nextOccurrence(rule(`FREQ=DAILY;COUNT=1000000`), {
    start: utc(`1700-01-01`),
    after: new Date(`2026-10-08T12:00:00Z`),
  })
  assert(result.success)
  assertEquals(label(result.output), `2026-10-09T09:00:00Z`)
  assert(performance.now() - began < 1000, `took ${performance.now() - began} ms`)
})

Deno.test(`nextOccurrence reads a UTC start against a far-east zone without skipping a day`, () => {
  // 22:00Z on 7 October is already 8 October 12:00 in Kiritimati (UTC+14): the UTC occurrence
  // at 09:00Z on 8 October is still ahead, so a search that cut by the zone's date would skip it.
  assertEquals(
    next(`FREQ=DAILY`, utc(`2026-10-01`), `2026-10-07T22:00:00Z`, `Pacific/Kiritimati`),
    `2026-10-08T09:00:00Z`,
  )
})

Deno.test(`nextOccurrence skips ahead without changing the answer`, () => {
  // A COUNT rule is walked from its start; the same rule without COUNT is jumped to `after`.
  for (
    const text of [
      `FREQ=DAILY;INTERVAL=7`,
      `FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,SA`,
      `FREQ=MONTHLY;BYDAY=2MO`,
      `FREQ=MONTHLY;INTERVAL=5`,
      `FREQ=YEARLY;INTERVAL=3;BYMONTH=2,8;BYMONTHDAY=29`,
    ]
  ) {
    const start = berlin(`2000-01-10`)
    const after = new Date(`2026-10-08T12:00:00Z`)
    const jumped = nextOccurrence(rule(text), { start, after })
    const walked = nextOccurrence(rule(`${text};COUNT=1000000`), { start, after })
    assert(jumped.success && walked.success, text)
    assertEquals(label(jumped.output), label(walked.output), text)
    assert(jumped.output !== null, text)
  }
})

Deno.test(`nextOccurrence ends at year 9999 instead of failing`, () => {
  const result = nextOccurrence(rule(`FREQ=YEARLY`), {
    start: utc(`9999-06-01`),
    after: new Date(`9999-06-01T09:00:00Z`),
  })
  assert(result.success)
  assertEquals(result.output, null)
})

Deno.test(`nextOccurrence reports a rule that never matches`, () => {
  const result = nextOccurrence(rule(`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`), {
    start: utc(`2026-02-01`),
    after: new Date(`2026-01-01T00:00:00Z`),
  })
  assert(!result.success)
  assertEquals(result.error.code, RruleErrorCode.SearchLimit)
})

Deno.test(`nextOccurrence refuses a start or zone it cannot use`, () => {
  const bad: [IcalDateValue, string | undefined][] = [
    [{ kind: IcalDateKind.Date, date: `2026-02-30` }, undefined],
    [{ kind: IcalDateKind.Date, date: `2026-01-05`, time: `09:00:00` }, undefined],
    [{ kind: IcalDateKind.Utc, date: `2026-01-05` }, undefined],
    [{ kind: IcalDateKind.Zoned, date: `2026-01-05`, time: `09:00:00` }, undefined],
    [{ ...berlin(`2026-01-05`), tzid: `W. Europe Standard Time` }, undefined],
    [{ kind: IcalDateKind.Floating, date: `2026-01-05`, time: `09:00:00` }, `Mars/Olympus`],
  ]
  for (const [start, timeZone] of bad) {
    const result = nextOccurrence(rule(`FREQ=DAILY`), {
      start,
      after: new Date(`2026-01-01T00:00:00Z`),
      timeZone,
    })
    assert(!result.success, JSON.stringify(start))
    assertEquals(result.error.code, RruleErrorCode.InvalidStart)
  }
})

const descriptions: [string, string][] = [
  [`FREQ=DAILY`, `Daily`],
  [`FREQ=DAILY;INTERVAL=1`, `Daily`],
  [`FREQ=DAILY;INTERVAL=3`, `Every 3 days`],
  [`FREQ=WEEKLY`, `Weekly`],
  [`FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`, `Every 2 weeks on Mon, Thu`],
  [`FREQ=MONTHLY`, `Monthly`],
  [`FREQ=MONTHLY;INTERVAL=6`, `Every 6 months`],
  [`FREQ=MONTHLY;BYDAY=-1FR`, `Monthly on the last Friday`],
  [`FREQ=MONTHLY;BYDAY=2MO`, `Monthly on the second Monday`],
  [`FREQ=MONTHLY;BYDAY=1FR,-1FR`, `Monthly on the first Friday and the last Friday`],
  [`FREQ=MONTHLY;BYDAY=-2SU`, `Monthly on the second to last Sunday`],
  [`FREQ=MONTHLY;BYMONTHDAY=15`, `Monthly on day 15`],
  [`FREQ=MONTHLY;BYMONTHDAY=-1`, `Monthly on the last day`],
  [`FREQ=MONTHLY;BYMONTHDAY=-3`, `Monthly on the 3rd to last day`],
  [`FREQ=MONTHLY;BYMONTHDAY=15,1,-1`, `Monthly on day 1, day 15 and the last day`],
  [`FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13`, `Monthly on every Fri when it is day 13`],
  [`FREQ=MONTHLY;BYMONTH=9,3`, `Monthly in Mar, Sep`],
  [`FREQ=YEARLY`, `Yearly`],
  [`FREQ=YEARLY;INTERVAL=2`, `Every 2 years`],
  [`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29`, `Yearly on day 29 in Feb`],
  [`FREQ=DAILY;COUNT=5`, `Daily, 5 times`],
  [`FREQ=DAILY;COUNT=1`, `Daily, 1 time`],
  [`FREQ=WEEKLY;UNTIL=20261231T235959Z`, `Weekly, until 2026-12-31`],
]

Deno.test(`describeRrule gives an English label for every rule form`, () => {
  for (const [text, label] of descriptions) {
    assertEquals(describeRrule(rule(text)), label, text)
  }
})

Deno.test(`the owner's 18 Tasks.org rules all parse, step and describe`, async () => {
  const lines =
    (await Deno.readTextFile(new URL(`./testdata/tasks-org-rrules.txt`, import.meta.url)))
      .split(`\n`).filter((line) => line !== ``)
  assertEquals(lines.length, 18)
  for (const line of lines) {
    const parsed = parseRrule(line)
    assert(parsed.success, `${line} should parse`)
    assert(describeRrule(parsed.output).length > 0, line)
    const result = nextOccurrence(parsed.output, {
      start: berlin(`2026-01-31`),
      after: new Date(`2026-10-08T00:00:00Z`),
    })
    assert(result.success && result.output !== null, `${line} should have a next occurrence`)
    assert(result.output.date >= `2026-10-08`, line)
  }
})

Deno.test(`time/rrule and its local imports use web-platform APIs only`, async () => {
  const seen = new Set<string>()
  const queue = [new URL(`./rrule.ts`, import.meta.url)]
  while (queue.length > 0) {
    const url = queue.pop()!
    if (seen.has(url.href)) continue
    seen.add(url.href)
    const code = (await Deno.readTextFile(url))
      .replace(/\/\*[\s\S]*?\*\//g, ``)
      .replace(/(^|\s)\/\/.*$/gm, `$1`)
    assertEquals(/\bDeno\./.test(code), false, `${url.pathname} uses Deno.*`)
    for (const [, specifier] of code.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert(specifier!.startsWith(`./`), `${url.pathname} imports ${specifier}`)
      queue.push(new URL(specifier!, url))
    }
  }
  assertEquals(seen.size, 5, `rrule.ts, ical.ts, ics-core.ts, tz.ts and date.ts`)
})
