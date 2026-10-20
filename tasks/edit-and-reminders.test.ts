// An app that imports only `@spy4x/tasks` can create, edit and complete a task and ask which of its
// reminders are due (#677). Each call goes through the package's own entry points.

import { expect } from "@std/expect"
import { completeTask, createTask, editTask } from "@spy4x/tasks/edit"
import { dueReminders } from "@spy4x/tasks/reminders"
import { parseTask, TaskStatus } from "@spy4x/tasks/model"
import { IcalDateKind } from "@spy4x/time/ical"
import { AlarmRelated, AlarmTriggerKind } from "@spy4x/time/ical-tasks"

const NOW = new Date("2026-11-01T08:00:00Z")
const LIST = "/dav/tasks/"

Deno.test("a task made, edited and completed through @spy4x/tasks rings its reminder", () => {
  const created = createTask(
    {
      title: "Water the plants",
      due: { kind: IcalDateKind.Utc, date: "2026-11-02", time: "09:00:00" },
    },
    {
      uid: "0193a0f0-0000-7000-8000-000000000001",
      now: NOW,
      prodid: "-//test//EN",
      listHref: LIST,
    },
  )
  if (!created.success) throw new Error(created.error)
  expect(created.output.href).toBe(`${LIST}0193a0f0-0000-7000-8000-000000000001.ics`)

  const parsed = parseTask({
    href: created.output.href,
    etag: `"1"`,
    listHref: LIST,
    ics: created.output.ics,
  })
  if (!parsed.success) throw new Error(parsed.error)

  const edited = editTask(parsed.output, {
    title: "Water the ferns",
    reminders: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H", related: AlarmRelated.End },
    }],
  }, NOW)
  if (!edited.success) throw new Error(edited.error)
  expect(edited.output.task.title).toBe("Water the ferns")

  const due = dueReminders(
    edited.output.ics,
    { after: NOW, upTo: new Date("2026-11-02T09:00:00Z") },
    { zone: "Europe/Berlin" },
  )
  expect(due.map((reminder) => reminder.at.toISOString())).toEqual(["2026-11-02T08:00:00.000Z"])

  const completed = completeTask(edited.output.task, NOW)
  if (!completed.success) throw new Error(completed.error.message)
  expect(completed.output.task.status).toBe(TaskStatus.Completed)
})
