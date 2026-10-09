import { expect } from "@std/expect"
import { IcalDateKind } from "./ical.ts"
import { type AlarmInput, AlarmRelated, AlarmTriggerKind } from "./ical-tasks.ts"
import {
  EditField,
  editTask,
  keepMine,
  rebaseEdit,
  RebaseKind,
  type TaskEdit,
} from "./ical-tasks-edit.ts"
import type { Task } from "./ical-tasks-model.ts"
import { fixtureTask, task } from "./testdata/tasks/fixtures.ts"

const NOW = new Date(`2026-10-08T12:30:45.678Z`)
const LATER = new Date(`2026-10-08T13:00:00.000Z`)

/** A repeating task with a due date, a vendor line and a reminder with a vendor line. */
const REPEATING = [
  `BEGIN:VCALENDAR`,
  `VERSION:2.0`,
  `PRODID:+//IDN tasks.org//android-150904//EN`,
  `BEGIN:VTODO`,
  `DTSTAMP:20261001T080000Z`,
  `CREATED:20260930T080000Z`,
  `UID:r1`,
  `SUMMARY:Water the plants`,
  `DUE;VALUE=DATE:20261009`,
  `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO`,
  `X-VENDOR:keep me`,
  `BEGIN:VALARM`,
  `TRIGGER;RELATED=END:PT0S`,
  `ACTION:DISPLAY`,
  `DESCRIPTION:Default Tasks.org description`,
  `X-MOZ-LASTACK:20261008T000000Z`,
  `END:VALARM`,
  `BEGIN:VALARM`,
  `TRIGGER;RELATED=END:-PT1H`,
  `ACTION:AUDIO`,
  `X-KEEP:1`,
  `END:VALARM`,
  `END:VTODO`,
  `END:VCALENDAR`,
  ``,
].join(`\r\n`)

const BASE = fixtureTask(REPEATING)
const PLAIN = fixtureTask(task(`p1`, `Plain`, [`DUE;VALUE=DATE:20261009`]))
/** A task with a due date and no reminder at all. */
const NAKED = fixtureTask(
  PLAIN.ics.replace(/BEGIN:VALARM[\s\S]*END:VALARM\r\n/, ``),
)

function edit(from: Task, change: TaskEdit) {
  const result = editTask(from, change, NOW)
  if (!result.success) throw new Error(result.error)
  return result.output
}

const lines = (text: string) => text.split(`\r\n`)

/** The lines of `before` that `after` lacks, and the lines of `after` that `before` lacks. */
function changed(before: string, after: string) {
  const left = lines(before)
  const right = lines(after)
  return {
    removed: left.filter((line) => !right.includes(line)),
    added: right.filter((line) => !left.includes(line)),
  }
}

const HOUSEKEEPING = /^(DTSTAMP|LAST-MODIFIED|SEQUENCE)[:;]/

Deno.test(`setting a repeat rule on a task without one adds only the RRULE`, () => {
  const out = edit(PLAIN, { repeatRule: `FREQ=DAILY;INTERVAL=2` })
  const { removed, added } = changed(PLAIN.ics, out.ics)
  expect(added.filter((line) => !HOUSEKEEPING.test(line))).toEqual([`RRULE:FREQ=DAILY;INTERVAL=2`])
  expect(removed.filter((line) => !HOUSEKEEPING.test(line))).toEqual([])
  expect(out.task.repeatRule).toBe(`FREQ=DAILY;INTERVAL=2`)
})

Deno.test(`changing the repeat rule replaces the RRULE and keeps every other line`, () => {
  const out = edit(BASE, { repeatRule: `FREQ=MONTHLY;INTERVAL=1` })
  const { removed, added } = changed(BASE.ics, out.ics)
  expect(removed.filter((line) => !HOUSEKEEPING.test(line))).toEqual([
    `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO`,
  ])
  expect(added.filter((line) => !HOUSEKEEPING.test(line))).toEqual([
    `RRULE:FREQ=MONTHLY;INTERVAL=1`,
  ])
})

Deno.test(`clearing the repeat rule removes the RRULE and nothing else`, () => {
  const out = edit(BASE, { repeatRule: null })
  const { removed, added } = changed(BASE.ics, out.ics)
  expect(removed.filter((line) => !HOUSEKEEPING.test(line))).toEqual([
    `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO`,
  ])
  expect(added.filter((line) => !HOUSEKEEPING.test(line))).toEqual([])
  expect(out.task.repeatRule).toBeUndefined()
})

Deno.test(`clearing the repeat rule of a task that has none leaves the text alone`, () => {
  const out = edit(PLAIN, { repeatRule: null })
  expect(out.ics).toBe(PLAIN.ics)
})

Deno.test(`a repeat rule sent back in another spelling keeps the original line`, () => {
  for (
    const same of [
      `freq=weekly;byday=mo`,
      `FREQ=WEEKLY;BYDAY=MO;WKST=MO`,
      `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO`,
    ]
  ) {
    expect(edit(BASE, { repeatRule: same }).ics).toBe(BASE.ics)
  }
})

Deno.test(`a repeat rule outside what parseRrule reads is refused and the task stays as it was`, () => {
  for (const bad of [`FREQ=HOURLY`, `FREQ=WEEKLY;BYSETPOS=1`, `FREQ=DAILY;BYDAY=MO`, `nonsense`]) {
    const result = editTask(BASE, { repeatRule: bad }, NOW)
    expect(result.success).toBe(false)
    expect(result.error).toEqual(expect.any(String))
  }
})

Deno.test(`adding a reminder keeps the existing VALARMs byte for byte`, () => {
  const out = edit(BASE, {
    reminders: [
      ...BASE.reminders.map((r) => ({
        trigger: {
          kind: AlarmTriggerKind.Relative as const,
          duration: r.trigger,
          related: AlarmRelated.End,
        },
      })),
      {
        trigger: { kind: AlarmTriggerKind.Relative, duration: `-PT15M`, related: AlarmRelated.End },
      },
    ],
  })
  const { removed, added } = changed(BASE.ics, out.ics)
  expect(removed.filter((line) => !HOUSEKEEPING.test(line))).toEqual([])
  expect(added).toContain(`TRIGGER;RELATED=END:-PT15M`)
  expect(out.ics).toContain(`X-MOZ-LASTACK:20261008T000000Z`)
  // The AUDIO reminder was sent back without an action and stays an AUDIO one with its vendor line.
  expect(out.ics).toContain(`ACTION:AUDIO\r\nX-KEEP:1`)
  expect(out.task.reminders.map((r) => r.trigger)).toEqual([`PT0S`, `-PT1H`, `-PT15M`])
})

Deno.test(`removing one reminder removes only its VALARM`, () => {
  const out = edit(BASE, {
    reminders: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: `PT0S`, related: AlarmRelated.End },
    }],
  })
  expect(out.ics).not.toContain(`-PT1H`)
  expect(out.ics).not.toContain(`X-KEEP:1`)
  expect(out.ics).toContain(`X-MOZ-LASTACK:20261008T000000Z`)
  expect(out.ics).toContain(`X-VENDOR:keep me`)
  expect(out.task.reminders.map((r) => r.trigger)).toEqual([`PT0S`])
})

Deno.test(`an empty reminder list removes every VALARM and nothing else`, () => {
  const out = edit(BASE, { reminders: [] })
  expect(out.ics).not.toContain(`VALARM`)
  expect(out.task.reminders).toEqual([])
  expect(out.ics).toContain(`RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO`)
  expect(out.ics).toContain(`X-VENDOR:keep me`)
})

Deno.test(`an empty reminder list on a task without reminders leaves the text alone`, () => {
  expect(edit(NAKED, { reminders: [] }).ics).toBe(NAKED.ics)
})

Deno.test(`an absolute reminder is written as a UTC DATE-TIME trigger`, () => {
  const out = edit(NAKED, {
    reminders: [{
      trigger: {
        kind: AlarmTriggerKind.Absolute,
        at: { kind: IcalDateKind.Utc, date: `2026-10-09`, time: `07:30:00` },
      },
    }],
  })
  expect(out.ics).toContain(`TRIGGER;VALUE=DATE-TIME:20261009T073000Z`)
  expect(out.task.reminders[0]!.alarm.kind).toBe(AlarmTriggerKind.Absolute)
})

Deno.test(`a reminder counted from a date the task lacks is refused`, () => {
  const bare = fixtureTask(task(`b1`, `No dates`))
  const result = editTask(bare, {
    reminders: [{ trigger: { kind: AlarmTriggerKind.Relative, duration: `-PT1H` } }],
  }, NOW)
  expect(result.success).toBe(false)
})

Deno.test(`a form that sends the reminders back unchanged keeps the text`, () => {
  const sameReminders = BASE.reminders.map((r) => ({ trigger: r.alarm }))
  expect(edit(BASE, { reminders: sameReminders }).ics).toBe(BASE.ics)
})

Deno.test(`a reminder trigger in another case counts as the same reminder`, () => {
  const out = edit(BASE, {
    title: `Renamed`,
    reminders: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: `pt0s`, related: AlarmRelated.End },
    }, {
      trigger: { kind: AlarmTriggerKind.Relative, duration: `-pt1h`, related: AlarmRelated.End },
    }],
  })
  expect(out.ics).toContain(`X-MOZ-LASTACK:20261008T000000Z`)
  expect(out.ics).toContain(`X-KEEP:1`)
})

function elsewhere(change: TaskEdit): Task {
  return { ...edit(BASE, change).task, etag: `"2"` }
}

Deno.test(`both sides setting different repeat rules is a collision on the repeat field`, () => {
  const result = rebaseEdit(
    BASE,
    { repeatRule: `FREQ=DAILY;INTERVAL=1` },
    elsewhere({ repeatRule: `FREQ=MONTHLY;INTERVAL=1` }),
    LATER,
  )
  expect(result.output).toEqual({ kind: RebaseKind.Collision, fields: [EditField.Repeat] })
})

Deno.test(`both sides setting the same repeat rule in different spellings is not a collision`, () => {
  const result = rebaseEdit(
    BASE,
    { repeatRule: `freq=daily` },
    elsewhere({ repeatRule: `FREQ=DAILY;INTERVAL=1` }),
    LATER,
  )
  expect(result.output).toMatchObject({ kind: RebaseKind.Applied })
})

Deno.test(`clearing a repeat rule the server changed is a collision`, () => {
  const result = rebaseEdit(
    BASE,
    { repeatRule: null },
    elsewhere({ repeatRule: `FREQ=MONTHLY;INTERVAL=1` }),
    LATER,
  )
  expect(result.output).toEqual({ kind: RebaseKind.Collision, fields: [EditField.Repeat] })
})

Deno.test(`both sides changing the reminders to different lists is a collision on the reminders`, () => {
  const relative = (duration: string) => ({
    trigger: { kind: AlarmTriggerKind.Relative as const, duration, related: AlarmRelated.End },
  })
  const result = rebaseEdit(
    BASE,
    { reminders: [relative(`-PT5M`)] },
    elsewhere({ reminders: [relative(`-PT10M`)] }),
    LATER,
  )
  expect(result.output).toEqual({ kind: RebaseKind.Collision, fields: [EditField.Reminders] })
})

Deno.test(`a whole-form edit that only changes the title keeps the repeat rule and reminders the server changed`, () => {
  const theirs = elsewhere({
    repeatRule: `FREQ=MONTHLY;INTERVAL=1`,
    reminders: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: `-PT30M`, related: AlarmRelated.End },
    }],
  })
  const wholeForm: TaskEdit = {
    title: `Mine`,
    repeatRule: BASE.repeatRule,
    reminders: BASE.reminders.map((r) => ({ trigger: r.alarm })),
  }
  const kept = keepMine(BASE, wholeForm, theirs, LATER)
  if (!kept.success) throw new Error(kept.error)
  expect(kept.output.task.title).toBe(`Mine`)
  expect(kept.output.task.repeatRule).toBe(`FREQ=MONTHLY;INTERVAL=1`)
  expect(kept.output.task.reminders.map((r) => r.trigger)).toEqual([`-PT30M`])
  const rebased = rebaseEdit(BASE, wholeForm, theirs, LATER)
  if (!rebased.success || rebased.output.kind !== RebaseKind.Applied) {
    throw new Error(`expected an applied rebase`)
  }
  expect(rebased.output.task.repeatRule).toBe(`FREQ=MONTHLY;INTERVAL=1`)
  expect(rebased.output.task.reminders.map((r) => r.trigger)).toEqual([`-PT30M`])
})

Deno.test(`keep mine applies my repeat rule and reminders over the server's`, () => {
  const theirs = elsewhere({ repeatRule: `FREQ=MONTHLY;INTERVAL=1` })
  const kept = keepMine(BASE, { repeatRule: `FREQ=DAILY;INTERVAL=3`, reminders: [] }, theirs, LATER)
  if (!kept.success) throw new Error(kept.error)
  expect(kept.output.task.repeatRule).toBe(`FREQ=DAILY;INTERVAL=3`)
  expect(kept.output.task.reminders).toEqual([])
})

/** A task with two reminders on one trigger (DISPLAY and AUDIO), an EMAIL one and one without trigger. */
const MIXED = fixtureTask(
  [
    `BEGIN:VCALENDAR`,
    `VERSION:2.0`,
    `PRODID:+//IDN tasks.org//android-150904//EN`,
    `BEGIN:VTODO`,
    `DTSTAMP:20261001T080000Z`,
    `UID:m1`,
    `SUMMARY:Mixed`,
    `DUE;VALUE=DATE:20261009`,
    `BEGIN:VALARM`,
    `TRIGGER;RELATED=END:-PT1H`,
    `ACTION:DISPLAY`,
    `DESCRIPTION:shown`,
    `X-SHOWN:1`,
    `END:VALARM`,
    `BEGIN:VALARM`,
    `TRIGGER;RELATED=END:-PT1H`,
    `ACTION:AUDIO`,
    `X-SOUND:1`,
    `END:VALARM`,
    `BEGIN:VALARM`,
    `TRIGGER;RELATED=END:-P1D`,
    `ACTION:EMAIL`,
    `ATTENDEE:mailto:a@example.com`,
    `SUMMARY:mail`,
    `DESCRIPTION:body`,
    `END:VALARM`,
    `BEGIN:VALARM`,
    `ACTION:DISPLAY`,
    `DESCRIPTION:no trigger`,
    `END:VALARM`,
    `END:VTODO`,
    `END:VCALENDAR`,
    ``,
  ].join(`\r\n`),
)

const end = (duration: string, action?: `DISPLAY` | `AUDIO`, description?: string) => {
  const reminder: AlarmInput = {
    trigger: { kind: AlarmTriggerKind.Relative, duration, related: AlarmRelated.End },
  }
  if (action) reminder.action = action
  if (description) reminder.description = description
  return reminder
}

const block = (ics: string, marker: string) =>
  ics.match(
    new RegExp(`BEGIN:VALARM\\r\\n(?:(?!END:VALARM)[\\s\\S])*${marker}[\\s\\S]*?END:VALARM\\r\\n`),
  )
    ?.[0]

Deno.test(`two reminders on one trigger both survive adding a third, vendor lines included`, () => {
  const out = edit(MIXED, { reminders: [end(`-PT1H`), end(`-PT1H`), end(`PT0S`)] })
  for (const kept of [`X-SHOWN:1`, `X-SOUND:1`]) {
    expect(block(out.ics, kept)).toBe(block(MIXED.ics, kept))
  }
  expect(out.ics.match(/ACTION:AUDIO/g)).toHaveLength(1)
  expect(out.ics).toContain(`TRIGGER;RELATED=END:PT0S`)
  // The order they were sent in is the order they are paired in.
  const swapped = edit(MIXED, { reminders: [end(`-PT1H`, `AUDIO`), end(`-PT1H`), end(`PT0S`)] })
  expect(block(swapped.ics, `X-SHOWN:1`)).toBe(block(MIXED.ics, `X-SHOWN:1`))
  expect(block(swapped.ics, `X-SOUND:1`)).toBe(block(MIXED.ics, `X-SOUND:1`))
})

Deno.test(`a reminder the editor cannot write (EMAIL, no trigger) stays as it was`, () => {
  const out = edit(MIXED, { reminders: [end(`-PT1H`), end(`-PT1H`), end(`PT0S`)] })
  expect(block(out.ics, `ACTION:EMAIL`)).toBe(block(MIXED.ics, `ACTION:EMAIL`))
  expect(block(out.ics, `no trigger`)).toBe(block(MIXED.ics, `no trigger`))
  const cleared = edit(MIXED, { reminders: [] })
  expect(cleared.ics).toContain(`ACTION:EMAIL`)
  expect(cleared.ics).toContain(`DESCRIPTION:no trigger`)
  expect(cleared.ics).not.toContain(`X-SHOWN`)
  expect(cleared.ics).not.toContain(`X-SOUND`)
})

Deno.test(`the list read from a task, sent back, does not duplicate an EMAIL reminder`, () => {
  const sameList = MIXED.reminders.map((r) => ({ trigger: r.alarm }))
  expect(edit(MIXED, { reminders: sameList }).ics).toBe(MIXED.ics)
  const more = edit(MIXED, { reminders: [...sameList, end(`PT0S`)] })
  expect(more.ics.match(/ACTION:EMAIL/g)).toHaveLength(1)
  expect(more.ics.match(/-P1D/g)).toHaveLength(1)
})

Deno.test(`an action or description sent for a reminder is written, not ignored`, () => {
  const toDisplay = edit(MIXED, { reminders: [end(`-PT1H`, `DISPLAY`), end(`-PT1H`, `DISPLAY`)] })
  expect(toDisplay.ics).not.toContain(`ACTION:AUDIO`)
  expect(toDisplay.ics).not.toContain(`X-SOUND`)
  const described = edit(MIXED, {
    reminders: [end(`-PT1H`, undefined, `new words`), end(`-PT1H`, `AUDIO`)],
  })
  expect(described.ics).toContain(`DESCRIPTION:new words`)
  expect(described.ics).not.toContain(`DESCRIPTION:shown`)
  expect(described.ics).toContain(`X-SOUND:1`)
})

Deno.test(`a reminder before the start is not the same as one before the due date`, () => {
  const fromStart: AlarmInput = {
    trigger: { kind: AlarmTriggerKind.Relative, duration: `-PT1H`, related: AlarmRelated.Start },
  }
  const dated = fixtureTask(
    NAKED.ics.replace(
      `DUE;VALUE=DATE:20261009`,
      `DTSTART:20261009T080000Z\r\nDUE:20261009T090000Z`,
    ),
  )
  const before = edit(dated, { reminders: [end(`-PT1H`)] })
  const after = edit(fixtureTask(before.ics), { reminders: [fromStart] })
  expect(before.task.reminders[0]!.alarm).toMatchObject({ related: AlarmRelated.End })
  expect(after.task.reminders).toHaveLength(1)
  expect(after.task.reminders[0]!.alarm).toMatchObject({ related: AlarmRelated.Start })
  expect(after.ics).not.toContain(`RELATED=END`)
})

Deno.test(`a repeat rule is written in the formatRrule spelling, not the caller's`, () => {
  const out = edit(PLAIN, { repeatRule: `freq=daily;interval=2` })
  expect(out.ics).toContain(`\r\nRRULE:FREQ=DAILY;INTERVAL=2\r\n`)
  expect(out.ics).not.toContain(`freq=daily`)
})

Deno.test(`a repeat rule needs a start or due date, and clearing one never does`, () => {
  const bare = fixtureTask(task(`b2`, `No dates`))
  const refused = editTask(bare, { repeatRule: `FREQ=DAILY;INTERVAL=1` }, NOW)
  expect(refused.success).toBe(false)
  expect(refused.error).toContain(`start or due`)
  // The same edit may bring the date.
  const together = edit(bare, {
    repeatRule: `FREQ=DAILY;INTERVAL=1`,
    due: { kind: IcalDateKind.Date, date: `2026-10-09` },
  })
  expect(together.task.repeatRule).toBe(`FREQ=DAILY;INTERVAL=1`)
  // Removing the due date in the same edit leaves nothing to repeat from.
  expect(editTask(PLAIN, { repeatRule: `FREQ=DAILY;INTERVAL=1`, due: null }, NOW).success)
    .toBe(false)
  // A task that repeats and has lost its date can still stop repeating.
  const dateless = fixtureTask(BASE.ics.replace(`DUE;VALUE=DATE:20261009\r\n`, ``))
  expect(edit(dateless, { repeatRule: null }).task.repeatRule).toBeUndefined()
})
