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
 *
 * `createTask` builds the text of a new task or subtask and the `href` to create it at; the caller
 * passes the new `UID` and the clock. `editTask` applies what the editor changed as a patch of the
 * original text, so lines another app wrote survive, and says where a task moved to another list
 * goes. `completeTask` completes a task or moves a repeating one to its next occurrence, with the
 * text to write back for an undo; `reopenTask` reopens a completed one. After a 412 on `If-Match`,
 * `rebaseEdit`, `keepMine` and `keepMineText` re-apply the edit to the server's fresh copy.
 *
 * @module
 */
export * from "@spy4x/time/ical-tasks-edit"
