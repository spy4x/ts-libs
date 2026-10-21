import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { dueReminders, type DueRemindersOptions } from "./ical-tasks-reminders.ts"

const BERLIN: DueRemindersOptions = { zone: "Europe/Berlin" }
/** A window wide enough to hold every moment of a test. */
const ALL = { after: new Date("2020-01-01T00:00:00Z"), upTo: new Date("2030-01-01T00:00:00Z") }

/** One VALARM with this TRIGGER line and any further lines. */
function alarm(trigger: string, extra: string[] = []): string[] {
  return ["BEGIN:VALARM", trigger, "ACTION:DISPLAY", "DESCRIPTION:Reminder", ...extra, "END:VALARM"]
}

/** A task resource the way Tasks.org writes one, with these VTODO lines. */
function task(lines: string[], uid = "task-1"): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:+//IDN tasks.org//android-150904//EN",
    "BEGIN:VTODO",
    "DTSTAMP:20261001T080000Z",
    ...(uid ? [`UID:${uid}`] : []),
    "SUMMARY:Water the plants",
    ...lines,
    "END:VTODO",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

/** The moments of the task's reminders, as ISO strings. */
function moments(ics: string, options = BERLIN, window = ALL): string[] {
  return dueReminders(ics, window, options).map((reminder) => reminder.at.toISOString())
}

function capture(name: string): Promise<string> {
  return Deno.readTextFile(new URL(`./testdata/ical/${name}`, import.meta.url))
}

describe("dueReminders: where a trigger lands", () => {
  it("counts a RELATED=END trigger from the due date", () => {
    const ics = task([
      "DTSTART:20261010T080000Z",
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=END:-PT1H"),
    ])
    expect(moments(ics)).toEqual(["2026-10-12T09:00:00.000Z"])
  })

  it("counts a trigger with no RELATED, or RELATED=START, from the start date", () => {
    const ics = task([
      "DTSTART:20261010T080000Z",
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER:-PT10M"),
      ...alarm("TRIGGER;RELATED=START:PT30M"),
    ])
    expect(moments(ics)).toEqual(["2026-10-10T07:50:00.000Z", "2026-10-10T08:30:00.000Z"])
  })

  it("adds weeks, days, hours, minutes and seconds of a duration", () => {
    const ics = task([
      "DUE:20261020T100000Z",
      ...alarm("TRIGGER;RELATED=END:-P1W"),
      ...alarm("TRIGGER;VALUE=DURATION;RELATED=END:-P1DT2H3M4S"),
    ])
    expect(moments(ics)).toEqual(["2026-10-13T10:00:00.000Z", "2026-10-19T07:56:56.000Z"])
  })

  it("takes an absolute trigger as its own moment, whatever the task's dates", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;VALUE=DATE-TIME:20261011T063000Z"),
    ])
    expect(moments(ics)).toEqual(["2026-10-11T06:30:00.000Z"])
  })

  it("reads a date-only due date at midnight in the given zone", () => {
    const ics = task(["DUE;VALUE=DATE:20261012", ...alarm("TRIGGER;RELATED=END:PT0S")])
    expect(moments(ics, { zone: "Europe/Berlin" })).toEqual(["2026-10-11T22:00:00.000Z"])
    expect(moments(ics, { zone: "Asia/Tokyo" })).toEqual(["2026-10-11T15:00:00.000Z"])
  })

  it("reads a date-only due date at dateOnlyTime when one is given", () => {
    const ics = task(["DUE;VALUE=DATE:20261012", ...alarm("TRIGGER;RELATED=END:-PT15M")])
    expect(moments(ics, { zone: "Europe/Berlin", dateOnlyTime: "09:00" })).toEqual([
      "2026-10-12T06:45:00.000Z",
    ])
    expect(moments(ics, { zone: "Europe/Berlin", dateOnlyTime: "09:00:30" })).toEqual([
      "2026-10-12T06:45:30.000Z",
    ])
  })

  it("leaves a due date that has a time alone when dateOnlyTime is given", () => {
    const ics = task(["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:PT0S")])
    expect(moments(ics, { zone: "Europe/Berlin", dateOnlyTime: "09:00" })).toEqual([
      "2026-10-12T10:00:00.000Z",
    ])
  })

  it("reads a floating due time as that wall clock in the given zone", () => {
    const ics = task(["DUE:20261012T100000", ...alarm("TRIGGER;RELATED=END:PT0S")])
    expect(moments(ics, { zone: "Europe/Berlin" })).toEqual(["2026-10-12T08:00:00.000Z"])
    expect(moments(ics, { zone: "America/New_York" })).toEqual(["2026-10-12T14:00:00.000Z"])
  })

  it("keeps the zone of a TZID due time, whatever zone is given", () => {
    const ics = task([
      "DUE;TZID=Asia/Ho_Chi_Minh:20261012T100000",
      ...alarm("TRIGGER;RELATED=END:PT0S"),
    ])
    expect(moments(ics, { zone: "Europe/Berlin" })).toEqual(["2026-10-12T03:00:00.000Z"])
  })

  it("reads a TZID this runtime does not know as a wall clock in the given zone", () => {
    const ics = task([
      "DUE;TZID=Head Office Time:20261012T100000",
      ...alarm("TRIGGER;RELATED=END:PT0S"),
    ])
    expect(moments(ics, { zone: "Europe/Berlin" })).toEqual(["2026-10-12T08:00:00.000Z"])
  })
})

describe("dueReminders: the window", () => {
  const ics = task(["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:PT0S")])
  const at = (iso: string) => new Date(iso)

  it("leaves out a reminder at exactly `after` and one before it", () => {
    const upTo = at("2026-10-12T11:00:00Z")
    expect(dueReminders(ics, { after: at("2026-10-12T10:00:00Z"), upTo }, BERLIN)).toEqual([])
    expect(dueReminders(ics, { after: at("2026-10-12T10:30:00Z"), upTo }, BERLIN)).toEqual([])
    expect(dueReminders(ics, { after: at("2026-10-12T09:59:59.999Z"), upTo }, BERLIN)).toHaveLength(
      1,
    )
  })

  it("includes a reminder at exactly `upTo` and leaves out one after it", () => {
    const after = at("2026-10-12T09:00:00Z")
    expect(dueReminders(ics, { after, upTo: at("2026-10-12T10:00:00Z") }, BERLIN)).toHaveLength(1)
    expect(dueReminders(ics, { after, upTo: at("2026-10-12T09:59:59.999Z") }, BERLIN)).toEqual([])
  })
})

describe("dueReminders: what it returns", () => {
  it("gives the UID, the summary, the moment and a key of UID plus moment", () => {
    const ics = task(["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:-PT1H")], "abc-123")
    expect(dueReminders(ics, ALL, BERLIN)).toEqual([{
      uid: "abc-123",
      summary: "Water the plants",
      at: new Date("2026-10-12T09:00:00Z"),
      key: "abc-123|2026-10-12T09:00:00.000Z",
    }])
  })

  it("gives one reminder for two alarms at the same moment", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=END:-PT1H"),
      ...alarm("TRIGGER;VALUE=DATE-TIME:20261012T090000Z"),
    ])
    expect(moments(ics)).toEqual(["2026-10-12T09:00:00.000Z"])
  })
})

describe("dueReminders: what has no reminder", () => {
  const live = ["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:PT0S")]

  it("returns nothing for a completed task", () => {
    expect(moments(task(["STATUS:COMPLETED", ...live]))).toEqual([])
  })

  it("returns nothing for a cancelled task", () => {
    expect(moments(task(["STATUS:CANCELLED", ...live]))).toEqual([])
  })

  it("returns nothing for a task with a COMPLETED date and no STATUS", () => {
    expect(moments(task(["COMPLETED:20261011T100000Z", ...live]))).toEqual([])
  })

  it("still reminds for an open task and one in process", () => {
    expect(moments(task(["STATUS:NEEDS-ACTION", ...live]))).toHaveLength(1)
    expect(moments(task(["STATUS:IN-PROCESS", ...live]))).toHaveLength(1)
  })

  it("skips a trigger relative to a date the task lacks and keeps the others", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=START:-PT10M"),
      ...alarm("TRIGGER;RELATED=END:-PT5M"),
    ])
    expect(moments(ics)).toEqual(["2026-10-12T09:55:00.000Z"])
    expect(moments(task(["DTSTART:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:PT0S")])))
      .toEqual([])
  })

  it("skips a trigger that is not a duration, and an alarm with no trigger", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=END:-P1M"),
      ...alarm("TRIGGER;RELATED=END:PT"),
      ...alarm("TRIGGER;RELATED=END:soon"),
      ...alarm("X-NOTHING:1"),
    ])
    expect(moments(ics)).toEqual([])
  })

  it("returns nothing, without throwing, for text that is not a task with a UID", () => {
    expect(moments("not a calendar")).toEqual([])
    expect(moments("")).toEqual([])
    expect(moments("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")).toEqual([])
    expect(moments(task(live, ""))).toEqual([])
  })

  it("returns nothing for a date that does not exist", () => {
    expect(moments(task(["DUE;VALUE=DATE:20261341", ...alarm("TRIGGER;RELATED=END:PT0S")])))
      .toEqual([])
  })

  it("returns nothing, without throwing, for a trigger further away than a date can hold", () => {
    const far = task(["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:P99999999W")])
    const everything = { after: new Date(-8.64e15), upTo: new Date(8.64e15) }
    expect(moments(far, BERLIN, everything)).toEqual([])
    expect(moments(far.replace(":P9", ":-P9"), BERLIN, everything)).toEqual([])
  })

  it("refuses a dateOnlyTime that is not a time of day", () => {
    const ics = task(live)
    for (const dateOnlyTime of ["9", "24:00", "09:60", "09:00:61", "0900", ""]) {
      expect(() => dueReminders(ics, ALL, { zone: "Europe/Berlin", dateOnlyTime })).toThrow(
        TypeError,
      )
    }
  })
})

describe("dueReminders: how Tasks.org writes reminders and snoozes", () => {
  it("reads the default alarm, a picked date and time, and a snooze of a real capture", async () => {
    const ics = await capture("complete/alarms-follow-due.before.ics")
    expect(dueReminders(ics, ALL, BERLIN)).toEqual([
      "2026-08-16T02:00:00.000Z", // TRIGGER;VALUE=DATE-TIME
      "2026-08-17T02:00:01.000Z", // TRIGGER;RELATED=END:PT0S on DUE;TZID=Asia/Ho_Chi_Minh
      "2026-08-19T02:14:56.000Z", // X-MOZ-SNOOZE-TIME
    ].map((iso) => ({
      uid: "00000000-0000-4000-8000-000000000006",
      summary: "Water the plants",
      at: new Date(iso),
      key: `00000000-0000-4000-8000-000000000006|${iso}`,
    })))
  })

  it("leaves only the snooze of a snoozed task, because its reminder was acknowledged", async () => {
    // X-MOZ-LASTACK:20260818T190429Z, X-MOZ-SNOOZE-TIME 15 minutes later, due four days earlier.
    const ics = await capture("stalwart-tasksorg-recurring.ics")
    expect(moments(ics)).toEqual(["2026-08-18T19:19:29.000Z"])
  })

  it("drops a reminder at or before the task's X-MOZ-LASTACK and keeps a later one", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      "X-MOZ-LASTACK:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=END:-PT1H"),
      ...alarm("TRIGGER;RELATED=END:PT0S"),
      ...alarm("TRIGGER;RELATED=END:PT1S"),
    ])
    expect(moments(ics)).toEqual(["2026-10-12T10:00:01.000Z"])
  })

  it("drops a snooze that was itself acknowledged", () => {
    const ics = task([
      "X-MOZ-LASTACK:20261012T101500Z",
      "X-MOZ-SNOOZE-TIME:20261012T101500Z",
    ])
    expect(moments(ics)).toEqual([])
  })

  it("reminds at the snooze of a task with no alarm and no dates", () => {
    expect(moments(task(["X-MOZ-SNOOZE-TIME:20261012T101500Z"]))).toEqual([
      "2026-10-12T10:15:00.000Z",
    ])
  })

  it("drops only the alarm that carries its own ACKNOWLEDGED or X-MOZ-LASTACK", () => {
    const ics = task([
      "DUE:20261012T100000Z",
      ...alarm("TRIGGER;RELATED=END:-PT3H", ["ACKNOWLEDGED:20261012T080000Z"]),
      ...alarm("TRIGGER;RELATED=END:-PT2H", ["X-MOZ-LASTACK:20261012T080000Z"]),
      ...alarm("TRIGGER;RELATED=END:-PT1H"),
    ])
    expect(moments(ics)).toEqual(["2026-10-12T09:00:00.000Z"])
  })

  it("stops reminding once the task is completed elsewhere", () => {
    const open = task(["DUE:20261012T100000Z", ...alarm("TRIGGER;RELATED=END:PT0S")])
    const done = task([
      "DUE:20261012T100000Z",
      "STATUS:COMPLETED",
      "COMPLETED:20261012T095000Z",
      "PERCENT-COMPLETE:100",
      ...alarm("TRIGGER;RELATED=END:PT0S"),
    ])
    expect(moments(open)).toHaveLength(1)
    expect(moments(done)).toEqual([])
  })
})

describe("dueReminders: a TZID the resource's own VTIMEZONE defines", () => {
  /** A task in `Head Office Time`, a zone at +09:00 that only the resource's VTIMEZONE defines. */
  function headOffice(lines: string[]): string {
    return task(lines).replace(
      "BEGIN:VTODO",
      [
        "BEGIN:VTIMEZONE",
        "TZID:Head Office Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T000000",
        "TZOFFSETFROM:+0900",
        "TZOFFSETTO:+0900",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VTODO",
      ].join("\r\n"),
    )
  }

  it("counts a relative reminder from the due time in that zone", () => {
    const ics = headOffice([
      "DUE;TZID=Head Office Time:20261012T090000",
      ...alarm("TRIGGER;RELATED=END:-PT15M"),
    ])
    expect(moments(ics)).toEqual(["2026-10-11T23:45:00.000Z"])
  })

  it("places an absolute reminder and a snooze in that zone", () => {
    const ics = headOffice([
      "DUE:20261020T090000Z",
      ...alarm("TRIGGER;VALUE=DATE-TIME;TZID=Head Office Time:20261012T090000"),
      "X-MOZ-SNOOZE-TIME;TZID=Head Office Time:20261013T090000",
    ])
    expect(moments(ics)).toEqual(["2026-10-12T00:00:00.000Z", "2026-10-13T00:00:00.000Z"])
  })

  // Reminders at 09:00 and 11:00 Head Office Time (00:00 and 02:00 UTC), acknowledged at 10:00 in
  // that zone (01:00 UTC): only the 11:00 one is left. Read in the given zone, Kiritimati at
  // +14:00, the acknowledgement would fall before both and drop neither.
  const KIRITIMATI: DueRemindersOptions = { zone: "Pacific/Kiritimati" }
  const NINE = "TRIGGER;VALUE=DATE-TIME;TZID=Head Office Time:20261012T090000"
  const ELEVEN = alarm("TRIGGER;VALUE=DATE-TIME;TZID=Head Office Time:20261012T110000")

  it("reads the task's X-MOZ-LASTACK in that zone", () => {
    const ics = headOffice([
      "DUE:20261020T090000Z",
      "X-MOZ-LASTACK;TZID=Head Office Time:20261012T100000",
      ...alarm(NINE),
      ...ELEVEN,
    ])
    expect(moments(ics, KIRITIMATI)).toEqual(["2026-10-12T02:00:00.000Z"])
  })

  it("reads an alarm's X-MOZ-LASTACK in that zone", () => {
    const ics = headOffice([
      "DUE:20261020T090000Z",
      ...alarm(NINE, ["X-MOZ-LASTACK;TZID=Head Office Time:20261012T100000"]),
      ...ELEVEN,
    ])
    expect(moments(ics, KIRITIMATI)).toEqual(["2026-10-12T02:00:00.000Z"])
  })

  it("reads an alarm's ACKNOWLEDGED in that zone", () => {
    const ics = headOffice([
      "DUE:20261020T090000Z",
      ...alarm(NINE, ["ACKNOWLEDGED;TZID=Head Office Time:20261012T100000"]),
      ...ELEVEN,
    ])
    expect(moments(ics, KIRITIMATI)).toEqual(["2026-10-12T02:00:00.000Z"])
  })
})
