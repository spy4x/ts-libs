/**
 * Which reminders of a task are due: `dueReminders` reads the moments a task's `VALARM`s and its
 * snooze denote and keeps the ones inside a time window.
 *
 * The same names as `@spy4x/time/ical-tasks-reminders`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * const due = dueReminders(task.ics, { after: lastRun, upTo: new Date() }, { zone: "Europe/Berlin" })
 * ```
 * @module
 */
export * from "@spy4x/time/ical-tasks-reminders"
