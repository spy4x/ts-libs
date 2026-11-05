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
 *
 * `dueReminders` reads one task's `VALARM`s and snooze and returns the reminders whose moment falls
 * after `after` and up to `upTo`, each with a key that is the same on every read. It never throws for
 * a task it cannot read; such a task has no reminders. `createReminderRunner` below calls it on a
 * timer.
 *
 * @module
 */
export * from "@spy4x/time/ical-tasks-reminders"
