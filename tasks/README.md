# `@spy4x/tasks`

The to-do model that the CalDAV task apps share: the task a screen shows, writing it back, which
reminders are due, the list views, the quick-add syntax and the runner that sends reminders. A
domain model, not a general helper, which is why it has a package of its own instead of a general
name in `@spy4x/platform` or `@spy4x/time`. The low-level iCalendar reading and patching of a VTODO
stays in `@spy4x/time/ical-tasks`, and talking to the server in `@spy4x/caldav`.

## Install

```bash
deno add jsr:@spy4x/tasks
```

Runs on: shared. `./model`, `./view` and `./quick-add` are pure functions for the server and a
browser bundle. `./reminder-runner` belongs on a server; it touches no `Deno.*` API, and its clock
and timer are parameters.

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

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/tasks/model`](model.ts): The `Task` a to-do screen shows, read from a CalDAV resource.
- [`@spy4x/tasks/edit`](edit.ts): Writes a task back to CalDAV.
- [`@spy4x/tasks/reminders`](reminders.ts): Which reminders of a task are due.
- [`@spy4x/tasks/view`](view.ts): What a task list shows.
- [`@spy4x/tasks/quick-add`](quick-add.ts): Parse one quick-add line such as `Call Anna @phone #work tomorrow 3pm !high` into a title, tags, contexts, a due date and a priority, plus the position of every recognised token.
- [`@spy4x/tasks/reminder-runner`](reminder-runner.ts): A reminder runner.
