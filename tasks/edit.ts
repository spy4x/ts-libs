/**
 * Writes a task back to CalDAV: `createTask` builds a new task or subtask, `editTask` applies an
 * editor change as a lossless patch, `completeTask` and `reopenTask` complete and reopen, and
 * `rebaseEdit`, `keepMine` and `keepMineText` re-apply an edit after the server's copy changed.
 *
 * The same names as `@spy4x/time/ical-tasks-edit`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * const created = createTask({ title: "Water the plants" }, { uid, now, prodid, listHref })
 * const done = completeTask(task, new Date(), { timeZone: "Europe/Berlin" })
 * ```
 * @module
 */
export * from "@spy4x/time/ical-tasks-edit"
