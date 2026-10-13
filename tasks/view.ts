/**
 * What a task list shows: the orders it can be sorted in, the subtask tree, search over title,
 * notes and tags, and the Today and Upcoming views. Pure functions of the tasks, the current
 * moment and the viewer's time zone.
 *
 * The same names as `@spy4x/platform/universal/ical-tasks-view`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * import { SortMode, sortTasks } from "@spy4x/tasks/view"
 *
 * const byDue = sortTasks(tasks, SortMode.Due, "Europe/Berlin")
 * ```
 * @module
 */
export * from "@spy4x/platform/universal/ical-tasks-view"
