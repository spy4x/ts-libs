/**
 * What a task list shows: the orders it can be sorted in, the subtask tree, search over title,
 * notes and tags, and the Today and Upcoming views. Pure functions of the tasks, the current
 * moment and the viewer's time zone.
 *
 * The same names as `@spy4x/platform/universal/ical-tasks-view`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * const byDue = sortTasks(tasks, SortMode.Due, "Europe/Berlin")
 * ```
 *
 * ```ts
 * import { parseTask } from "@spy4x/tasks/model"
 * import { SortMode, sortTasks, todayView } from "@spy4x/tasks/view"
 * import { parseQuickAdd } from "@spy4x/tasks/quick-add"
 *
 * const zone = "Europe/Berlin"
 * const tasks = resources.map(parseTask).flatMap((result) => result.success ? [result.output] : [])
 *
 * const byDue = sortTasks(tasks, SortMode.Due, zone)
 * const { overdue, today } = todayView(tasks, new Date(), zone)
 *
 * const typed = parseQuickAdd("Call Anna @phone #work tomorrow 3pm !high", {
 *   now: new Date(),
 *   timeZone: zone,
 * })
 * typed.title // "Call Anna"
 * ```
 *
 * Everything in `./view` is a pure function of the tasks, the current moment and the viewer's time
 * zone; nothing reads the clock. Days are the viewer's, and only tasks that still need doing appear
 * in the Today and Upcoming views. A repeating task is shown where its due value says; the next
 * occurrence is not computed here.
 *
 * @module
 */
export * from "@spy4x/platform/universal/ical-tasks-view"
