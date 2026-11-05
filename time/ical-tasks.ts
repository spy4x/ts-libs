/**
 * Tasks (VTODO) and events (VEVENT) on top of the lossless iCalendar model in `./ical.ts`:
 * read the fields an app shows, patch only the fields it changes, create a new object.
 *
 * A patch changes the patched properties plus DTSTAMP and LAST-MODIFIED. SEQUENCE goes up by one
 * on an event patch, and on a task patch that really changes DTSTART, DUE, RRULE or STATUS (RFC
 * 5545 §3.8.7.4); a task patch of a title, reminder or category, or one that repeats those four
 * with their stored values, leaves it. Every other
 * line, including reminders, vendor `X-` properties, time zones and recurrence overrides, is
 * written back byte for byte. CREATED is never rewritten, and COMPLETED of an already completed
 * task is kept. A patch is atomic: when it is
 * refused, the document is left as it was.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`. The clock, the
 * UID and the PRODID come from the caller; nothing here reads the time or generates a random.
 *
 * ## Tasks and events
 *
 * `time/ical-tasks` reads and patches a VTODO or VEVENT without losing the rest of the object.
 *
 * ```ts
 * import { patchTodo, readTodo, TodoStatus } from "@spy4x/time/ical-tasks"
 *
 * const todo = readTodo(root) // summary, status, due, relatedTo (PARENT by default), sortOrder, alarms…
 * const result = patchTodo(root, { status: TodoStatus.Completed, priority: null }, {
 *   now: new Date(),
 * })
 * if (!result.success) throw new Error(result.error.message) // root is unchanged
 * ```
 *
 * A patch changes the patched fields plus DTSTAMP and LAST-MODIFIED; `null` clears a field. SEQUENCE
 * goes up by one on an event patch, and on a task patch that changes `start`, `due`, `rrule` or `status` to a different value
 * (repeating the stored value, as a form that saves every field does, changes nothing).
 * `alarms` writes reminders: a list replaces the VALARMs (an equal one stays as it is), `null` removes
 * them all, and leaving it out keeps them. A reminder counted from the start or end needs that date on
 * the task or event.
 * A patch that clears that date while such a reminder stays is refused and names the
 * date and the reminder; pass `alarms` in the same patch to change or remove it.
 * A repeat rule on a task needs DUE, the date `completeTodo` moves the task from: `patchTodo` and
 * `newTodo` refuse a new or changed `rrule` when the task has no DUE after the patch, and `due: null`
 * on a task whose rule stays, naming the rule; the same patch may set DUE or pass `rrule: null`. A
 * task that already repeats without DUE (another app wrote it) takes any patch that does not write a
 * rule.
 * Completing sets STATUS, COMPLETED and PERCENT-COMPLETE together, reopening clears them. A repeating
 * task keeps its RRULE and reads `repeats: true`; completing one is refused unless the options say
 * `completeSeries: true`. `newTodo` and `newEvent` take `uid`, `now` and `prodid` from the caller.
 *
 * `describeAlarmTrigger(alarm.trigger, { owner, locale, timeZone })` words a reminder for a list:
 * `15 minutes before due`, `1 hour after start`, `at end`, or for an absolute trigger the date in the
 * given zone and locale. `owner` (`AlarmOwner.Task` by default, or `AlarmOwner.Event`) decides whether
 * an end-related trigger says `due` or `end`. A trigger it cannot describe, or a VALARM with none,
 * gives `undefined`: show the raw value. The words are English; only the date of an absolute
 * trigger follows `locale`.
 *
 * `completeTodo` completes a task the way Tasks.org does. A plain task is completed; a repeating task
 * moves to its next occurrence and stays open. The next date is the first occurrence after DUE (never
 * DTSTART, never "now": an overdue task moves one step), DTSTART moves by the same offset, `COUNT`
 * goes down by one, and the series ends in a completed task at `COUNT=1` or after `UNTIL`. A rule
 * outside `time/rrule`, or one Tasks.org reads differently, is refused with a code and the document
 * untouched. `reopenTodo` undoes a completion.
 *
 * A task counts its next date from the day it was completed, not from its due date, when its VTODO
 * has the line `X-REPEAT-FROM:COMPLETION` (`Todo.repeatFrom` and `Task.repeatFrom` then read
 * `RepeatFrom.Completion`; no line means from the due date). The series starts again at the
 * completion day: a weekly task due on the 11th and completed on the 14th is due on the 21st, not the
 * 18th. The due date keeps its time of day, DTSTART and the reminders at a fixed time move as far as
 * the due date did, and `COUNT` goes down by one however late the task was. A weekly rule with `BYDAY`
 * moves to the next listed weekday after the completion day, after skipping `INTERVAL - 1` weeks, as
 * Tasks.org does. `UNTIL` ends the series when the next date would pass it. Which day "the day it was
 * completed" is depends on the zone: a due time with a `TZID` uses that zone, and every other due
 * date uses `options.timeZone`, the zone of the person completing the task. Without that option such
 * a task is refused with `UnusableDate`. A task with this line, a rule and no DUE gets a date-only
 * DUE counted the same way, unless its DTSTART has a time or it has a `DURATION`; without the line it
 * is refused with `NoDueDate` as before.
 *
 * The line is this library's own. Tasks.org has the same switch ("repeat after completion") but keeps
 * it in the phone's database and writes nothing about it to the VTODO, so the phone and this library
 * can be set differently for one task. Each app then follows its own setting: the app the task is
 * completed in decides the next date. Tasks.org's source keeps a line it does not know when it saves
 * the task; that has not been checked on a phone yet. The old `FROM=COMPLETION` part inside an
 * `RRULE` is not this setting: a rule with it is refused as an unsupported part, and it is never
 * written.
 *
 * ```ts
 * import { completeTodo, CompleteTodoKind } from "@spy4x/time/ical-tasks"
 *
 * const done = completeTodo(root, { now: new Date(), timeZone: "Europe/Berlin" })
 * if (!done.success) throw new Error(done.error.message) // root is unchanged
 * done.output.kind === CompleteTodoKind.Advanced // the repeating task is open on its next date
 * ```
 *
 * @module
 */

export * from "./ical-tasks-todo.ts"
export * from "./ical-tasks-complete.ts"
