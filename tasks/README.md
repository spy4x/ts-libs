# `@spy4x/tasks`

The to-do model that the CalDAV task apps share: the task a screen shows, writing it back, which
reminders are due, the list views, the quick-add syntax and the runner that sends reminders. A
domain model, not a general helper, which is why it has a package of its own instead of a general
name in `@spy4x/platform` or `@spy4x/time`.

| Entry point                    | Exports                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@spy4x/tasks/model`           | The `Task` a screen shows, read from a CalDAV resource: `parseTask`, `priorityBand`, `PriorityBand`, `TaskStatus`, `isOpen`, `dateInstant`, `dateDay`     |
| `@spy4x/tasks/edit`            | Writing a task back: `createTask`, `editTask`, `completeTask`, `reopenTask`, `rebaseEdit`, `keepMine`, `keepMineText`, `collisions`                       |
| `@spy4x/tasks/reminders`       | `dueReminders`: the reminders of one task that fall in a time window                                                                                      |
| `@spy4x/tasks/view`            | List screens for that `Task`: `SortMode`, `sortTasks`, `reorderTask`, `buildTree`, `flattenTree`, `searchTasks`, `todayView`, `upcomingView`, `isOverdue` |
| `@spy4x/tasks/quick-add`       | `parseQuickAdd`: one task line to title, tags, contexts, due date, priority and token spans                                                               |
| `@spy4x/tasks/reminder-runner` | `createReminderRunner`, `ReminderStatePort`, `ReminderRunnerState`, `ReminderNotifyResult`: sends the task reminders that came due since the last run     |

The low-level iCalendar reading and patching of a VTODO stays in `@spy4x/time/ical-tasks`, and
talking to the server in `@spy4x/caldav`.

## Install

```bash
deno add jsr:@spy4x/tasks
```

Runs on: shared. `./model`, `./view` and `./quick-add` are pure functions for the server and a
browser bundle. `./reminder-runner` belongs on a server; it touches no `Deno.*` API, and its clock
and timer are parameters.

```ts
import { parseTask } from "@spy4x/tasks/model"
import { SortMode, sortTasks, todayView } from "@spy4x/tasks/view"
import { parseQuickAdd } from "@spy4x/tasks/quick-add"

const zone = "Europe/Berlin"
const tasks = resources.map(parseTask).flatMap((result) => result.success ? [result.output] : [])

const byDue = sortTasks(tasks, SortMode.Due, zone)
const { overdue, today } = todayView(tasks, new Date(), zone)

const typed = parseQuickAdd("Call Anna @phone #work tomorrow 3pm !high", {
  now: new Date(),
  timeZone: zone,
})
typed.title // "Call Anna"
```

## The model

`parseTask` reads one CalDAV resource (`href`, `etag`, `listHref` and the iCalendar text) into a
`Task`. A resource with no VTODO, or with one that has no `UID`, is a failure with a message, never
a throw: one odd resource must not take the whole list down. `priorityBand` turns the iCalendar
`PRIORITY` (0 to 9) into the band a screen shows, `isOpen` says whether a task still needs doing,
and `dateInstant` and `dateDay` turn a task's date into a moment or a `YYYY-MM-DD` day in the
viewer's time zone.

## Writing a task back

`createTask` builds the text of a new task or subtask and the `href` to create it at; the caller
passes the new `UID` and the clock. `editTask` applies what the editor changed as a patch of the
original text, so lines another app wrote survive, and says where a task moved to another list
goes. `completeTask` completes a task or moves a repeating one to its next occurrence, with the
text to write back for an undo; `reopenTask` reopens a completed one. After a 412 on `If-Match`,
`rebaseEdit`, `keepMine` and `keepMineText` re-apply the edit to the server's fresh copy.

## Due reminders

`dueReminders` reads one task's `VALARM`s and snooze and returns the reminders whose moment falls
after `after` and up to `upTo`, each with a key that is the same on every read. It never throws for
a task it cannot read; such a task has no reminders. `createReminderRunner` below calls it on a
timer.

## The views

Everything in `./view` is a pure function of the tasks, the current moment and the viewer's time
zone; nothing reads the clock. Days are the viewer's, and only tasks that still need doing appear
in the Today and Upcoming views. A repeating task is shown where its due value says; the next
occurrence is not computed here.

## Quick add

`parseQuickAdd` takes the line a person types and the current moment and time zone. It returns the
title without its tokens, the `#tags`, the `@contexts`, a due date, a priority, and the position of
every recognised token, so a field can highlight them as the person types.

## The reminder runner

`createReminderRunner` ticks once a minute, reads the tasks again each time, and hands every
reminder that came due since its last run to `notify`. It keeps its last run and what it sent in a
state port, so a restart neither repeats nor skips one; after a long stop it catches up one hour at
most. `notify` answers `"delivered"` (also by returning nothing), `"retry"` (also by throwing) or
`"drop"` for a reminder that can never be sent, which is reported once and not tried again;
`createReminderNotify` in `@spy4x/integrations/push-reminders` is a ready `notify` for Web Push. One
tick has a deadline (`tickTimeoutMs`, two minutes by default): a `listTasks` or `notify` that never
settles gets its abort signal fired, the tick is abandoned and reported, and the next one runs.
`stop()` fires the same signal, so it does not wait for a call that hangs; it resolves once the tick
has ended. A mistyped `zone` and a `catchUpMs` shorter than `intervalMs + tickTimeoutMs` are refused
when the runner is built: with a shorter one, a tick that takes time would skip reminders.

```ts
import { createReminderRunner } from "@spy4x/tasks/reminder-runner"
import { createReminderNotify } from "@spy4x/integrations/push-reminders"

const runner = createReminderRunner({
  listTasks: () => fetchTaskIcsTexts(),
  notify: createReminderNotify({ sender, userId: "owner", url: "/" }),
  state: store.state("reminders"),
  zone: "Europe/Berlin",
  onError: (error, step) => console.error(`reminders: ${step} failed`, error),
})
runner.start()
```

## The old import paths

Before this package, these entry points had general names. Those paths keep working until 2.0
and hand out the very same values, so an app can move one import at a time:

| Old path, kept until 2.0                    | Import from                    |
| ------------------------------------------- | ------------------------------ |
| `@spy4x/time/ical-tasks-model`              | `@spy4x/tasks/model`           |
| `@spy4x/time/ical-tasks-edit`               | `@spy4x/tasks/edit`            |
| `@spy4x/time/ical-tasks-reminders`          | `@spy4x/tasks/reminders`       |
| `@spy4x/platform/universal/ical-tasks-view` | `@spy4x/tasks/view`            |
| `@spy4x/platform/universal/quick-add`       | `@spy4x/tasks/quick-add`       |
| `@spy4x/platform/server/reminder-runner`    | `@spy4x/tasks/reminder-runner` |

Until 2.0 the code itself still sits in `platform/` and `time/`, and this package re-exports it.
JSR refuses two packages that depend on each other, and each file is needed where it is: the views
and the runner use `@spy4x/platform`'s sort, text search, clock and timer helpers, and the modules
of `@spy4x/time` that write a task back import the model. At 2.0 the old paths go and the files
move here.
