// Behaviour tests for completing and reopening tasks. The fixtures in `testdata/ical/complete/`
// are `<name>.before.ics` and `<name>.after.ics`: the "before" files copy the shape of repeating
// tasks written by Tasks.org (text anonymised), the "after" files were written by hand from the
// rules of Tasks.org's RepeatTaskHelper (commit b5c8b08), not captured from a phone.

import { assert, assertEquals } from "@std/assert"
import { getProperty, IcalComponent, parseIcal, serializeIcal } from "./ical.ts"
import {
  completeTodo,
  CompleteTodoErrorCode,
  CompleteTodoKind,
  readTodo,
  reopenTodo,
  TodoStatus,
} from "./ical-tasks.ts"

const FIXTURES = new URL("./testdata/ical/complete/", import.meta.url)
const NOW = new Date("2026-10-08T12:30:45.678Z")
const OPTIONS = { now: NOW }

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES))
}

function parse(text: string): IcalComponent {
  const result = parseIcal(text)
  if (!result.success) throw new Error(`parse failed: ${result.error.message}`)
  return result.output
}

/** A before fixture with one line replaced, so each refusal starts from a real shape. */
async function withLine(name: string, from: string | RegExp, to: string): Promise<string> {
  const text = await fixture(`${name}.before.ics`)
  const changed = text.replace(from, to)
  assert(changed !== text, `${name} has no line matching ${from}`)
  return changed
}

function complete(text: string, options: { now: Date } = OPTIONS) {
  const root = parse(text)
  const result = completeTodo(root, options)
  return { root, result, text: serializeIcal(root) }
}

function assertRefused(
  text: string,
  code: CompleteTodoErrorCode,
  options: { now: Date } = OPTIONS,
): string | undefined {
  const { result, text: after } = complete(text, options)
  assert(!result.success, `expected a refusal with code ${code}`)
  assertEquals(result.error.code, code)
  assertEquals(after, serializeIcal(parse(text)), `a refusal leaves the document as it was`)
  return result.error.part
}

const PAIRS: [string, CompleteTodoKind][] = [
  ["daily-overdue", CompleteTodoKind.Advanced],
  ["weekly-start-differs-from-due", CompleteTodoKind.Advanced],
  ["count-lowered", CompleteTodoKind.Advanced],
  ["count-one-ends-series", CompleteTodoKind.Completed],
  ["monthly-date-only-short-month", CompleteTodoKind.Advanced],
  ["alarms-follow-due", CompleteTodoKind.Advanced],
  ["plain-task", CompleteTodoKind.Completed],
]

for (const [name, kind] of PAIRS) {
  Deno.test(`completing ${name} writes the text the Tasks.org rules give and nothing else`, async () => {
    const { result, text } = complete(await fixture(`${name}.before.ics`))
    assert(result.success)
    assertEquals(result.output.kind, kind)
    assertEquals(text, await fixture(`${name}.after.ics`))
  })
}

Deno.test(`an overdue task moves one step from its old due date, not to the future`, async () => {
  // NOW is almost two months after the due date of 14 August.
  const { result } = complete(await fixture(`daily-overdue.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.due?.date, `2026-08-15`)
  assert(result.output.todo.due!.date < `2026-10-08`)
})

Deno.test(`the series is anchored on DUE, not on DTSTART`, async () => {
  // DTSTART is Monday 10 August and DUE is Tuesday 18 August, every 2 weeks. From DTSTART the
  // next date would be a Monday; from DUE it is Tuesday 1 September.
  const { result } = complete(await fixture(`weekly-start-differs-from-due.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.due?.date, `2026-09-01`)
})

Deno.test(`DTSTART moves by the same offset as DUE and keeps the gap between them`, async () => {
  const { result } = complete(await fixture(`weekly-start-differs-from-due.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.start?.date, `2026-08-24`)
  assertEquals(result.output.todo.start?.time, `09:00:00`)
  assertEquals(result.output.todo.due?.time, `16:00:01`)
})

Deno.test(`a task without DTSTART gets none when it repeats`, async () => {
  const { root, result } = complete(await fixture(`daily-overdue.before.ics`))
  assert(result.success)
  assertEquals(getProperty(root.components[0]!, `DTSTART`), undefined)
})

Deno.test(`COUNT is lowered by one and the other rule parts stay in place`, async () => {
  const { result } = complete(await fixture(`count-lowered.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.rrule, `FREQ=DAILY;COUNT=2;INTERVAL=3`)
})

Deno.test(`a rule with COUNT=1 completes the task and keeps its rule`, async () => {
  const { result } = complete(await fixture(`count-one-ends-series.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.status, TodoStatus.Completed)
  assertEquals(result.output.todo.rrule, `FREQ=DAILY;COUNT=1`)
  assertEquals(result.output.todo.completed?.date, `2026-10-08`)
})

Deno.test(`COUNT=1 completes the task even when DUE is not a day the rule selects`, async () => {
  // DUE is a Tuesday; the rule selects Mondays, so the next Monday would be the first occurrence.
  const text = await withLine(
    `weekly-start-differs-from-due`,
    `RRULE:FREQ=WEEKLY;INTERVAL=2`,
    `RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=1`,
  )
  const { result } = complete(text)
  assert(result.success)
  assertEquals(result.output.kind, CompleteTodoKind.Completed)
  assertEquals(result.output.todo.due?.date, `2026-08-18`)
})

Deno.test(`a rule with no occurrence left completes the task instead of moving it`, async () => {
  const text = await withLine(
    `daily-overdue`,
    `RRULE:FREQ=DAILY;INTERVAL=1`,
    `RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20260814T040000Z`,
  )
  const { result } = complete(text)
  assert(result.success)
  assertEquals(result.output.kind, CompleteTodoKind.Completed)
  assertEquals(result.output.todo.due?.date, `2026-08-14`)
})

Deno.test(`the end of a month is used when the next month is shorter`, async () => {
  const { result } = complete(await fixture(`monthly-date-only-short-month.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.due?.date, `2026-09-30`)
})

Deno.test(`a repeating task stays open: no COMPLETED and the status is kept`, async () => {
  const { result } = complete(await fixture(`daily-overdue.before.ics`))
  assert(result.success)
  assertEquals(result.output.todo.status, TodoStatus.NeedsAction)
  assertEquals(result.output.todo.completed, undefined)
  assertEquals(result.output.todo.sequence, 1)
})

Deno.test(`the snooze is dropped and absolute alarms follow the due date`, async () => {
  const { text } = complete(await fixture(`alarms-follow-due.before.ics`))
  assert(!text.includes(`X-MOZ-SNOOZE-TIME`))
  assert(text.includes(`TRIGGER;VALUE=DATE-TIME:20260823T020000Z`))
  assert(text.includes(`TRIGGER;RELATED=END:PT0S`), `a relative trigger is kept as it is`)
})

Deno.test(`FROM=COMPLETION is refused as an unsupported rule part`, async () => {
  const text = await withLine(
    `daily-overdue`,
    `RRULE:FREQ=DAILY;INTERVAL=1`,
    `RRULE:FREQ=DAILY;INTERVAL=1;FROM=COMPLETION`,
  )
  assertEquals(assertRefused(text, CompleteTodoErrorCode.UnsupportedRule), `FROM`)
})

Deno.test(`an hourly rule is refused as unsupported`, async () => {
  const text = await withLine(`daily-overdue`, `FREQ=DAILY`, `FREQ=HOURLY`)
  assertEquals(assertRefused(text, CompleteTodoErrorCode.UnsupportedRule), `FREQ`)
})

Deno.test(`BYDAY on a daily rule is refused because Tasks.org ignores it`, async () => {
  const text = await withLine(`daily-overdue`, `FREQ=DAILY;INTERVAL=1`, `FREQ=DAILY;BYDAY=MO`)
  assertEquals(assertRefused(text, CompleteTodoErrorCode.UnsupportedRule), `BYDAY`)
})

Deno.test(`a repeating task with no DUE is refused`, async () => {
  const text = await withLine(`daily-overdue`, /DUE;[^\r]*\r\n/, ``)
  assertRefused(text, CompleteTodoErrorCode.NoDueDate)
})

Deno.test(`a due date in a vendor time zone is refused as unusable`, async () => {
  const text = await withLine(`daily-overdue`, /DUE;TZID=[^:]*:/, `DUE;TZID=Vendor Standard Time:`)
  assertRefused(text, CompleteTodoErrorCode.UnusableDate)
})

Deno.test(`a start date in a vendor time zone is refused as unusable`, async () => {
  const text = await withLine(
    `weekly-start-differs-from-due`,
    /DTSTART;TZID=[^:]*:/,
    `DTSTART;TZID=Vendor Standard Time:`,
  )
  assertRefused(text, CompleteTodoErrorCode.UnusableDate)
})

Deno.test(`a completed task cannot be completed again`, async () => {
  assertRefused(await fixture(`plain-task.after.ics`), CompleteTodoErrorCode.AlreadyCompleted)
})

Deno.test(`a document with no VTODO is refused`, () => {
  assertRefused(
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\nEND:VCALENDAR\r\n`,
    CompleteTodoErrorCode.NoTodo,
  )
})

Deno.test(`a floating due time moves a day and keeps its time of day`, async () => {
  const text = await withLine(`daily-overdue`, /DUE;TZID=[^:]*:/, `DUE:`)
  const { result } = complete(text)
  assert(result.success)
  assertEquals(result.output.todo.due?.date, `2026-08-15`)
  assertEquals(result.output.todo.due?.time, `11:00:01`)
})

Deno.test(`reopening a completed task restores NEEDS-ACTION and drops COMPLETED and 100 percent`, async () => {
  const root = parse(await fixture(`plain-task.after.ics`))
  const result = reopenTodo(root, { now: new Date(`2026-10-09T08:00:00Z`) })
  assert(result.success)
  assertEquals(result.output.status, TodoStatus.NeedsAction)
  const text = serializeIcal(root)
  assert(!text.includes(`COMPLETED:`) && !text.includes(`PERCENT-COMPLETE`))
  assert(text.includes(`SEQUENCE:2`) && text.includes(`LAST-MODIFIED:20261009T080000Z`))
  assertEquals(readTodo(root)?.due?.date, `2026-08-04`)
})

Deno.test(`reopening a task that is not completed is refused and changes nothing`, async () => {
  const text = await fixture(`plain-task.before.ics`)
  const root = parse(text)
  const result = reopenTodo(root, OPTIONS)
  assert(!result.success)
  assertEquals(result.error.code, CompleteTodoErrorCode.NotCompleted)
  assertEquals(serializeIcal(root), text)
})
