/**
 * A reminder runner: on a timer, it reads the current tasks, works out which reminders became due
 * since its last run, and hands each one to the caller's `notify`. It runs on a server, on any
 * runtime: the clock and the timer are parameters.
 *
 * The same names as `@spy4x/platform/server/reminder-runner`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * import { createReminderRunner } from "@spy4x/tasks/reminder-runner"
 *
 * const runner = createReminderRunner({ listTasks, notify, state, zone: "Europe/Berlin" })
 * runner.start()
 * ```
 * @module
 */
export * from "@spy4x/platform/server/reminder-runner"
