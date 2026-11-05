/**
 * A reminder runner: on a timer, it reads the current tasks, works out which reminders became due
 * since its last run, and hands each one to the caller's `notify`. It runs on a server, on any
 * runtime: the clock and the timer are parameters.
 *
 * The same names as `@spy4x/platform/server/reminder-runner`, where the code sits until 2.0.
 *
 * @example
 * ```ts
 * const runner = createReminderRunner({ listTasks, notify, state, zone: "Europe/Berlin" })
 * runner.start()
 * ```
 *
 * `createReminderRunner` ticks once a minute, reads the tasks again each time, and hands every
 * reminder that came due since its last run to `notify`. It keeps its last run and what it sent in a
 * state port, so a restart neither repeats nor skips one; after a long stop it catches up one hour at
 * most. `notify` answers `"delivered"` (also by returning nothing), `"retry"` (also by throwing) or
 * `"drop"` for a reminder that can never be sent, which is reported once and not tried again;
 * `createReminderNotify` in `@spy4x/integrations/push-reminders` is a ready `notify` for Web Push. One
 * tick has a deadline (`tickTimeoutMs`, two minutes by default): a `listTasks` or `notify` that never
 * settles gets its abort signal fired, the tick is abandoned and reported, and the next one runs.
 * `stop()` fires the same signal, so it does not wait for a call that hangs; it resolves once the tick
 * has ended. A mistyped `zone` and a `catchUpMs` shorter than `intervalMs + tickTimeoutMs` are refused
 * when the runner is built: with a shorter one, a tick that takes time would skip reminders.
 *
 * ```ts
 * import { createReminderRunner } from "@spy4x/tasks/reminder-runner"
 * import { createReminderNotify } from "@spy4x/integrations/push-reminders"
 *
 * const runner = createReminderRunner({
 *   listTasks: () => fetchTaskIcsTexts(),
 *   notify: createReminderNotify({ sender, userId: "owner", url: "/" }),
 *   state: store.state("reminders"),
 *   zone: "Europe/Berlin",
 *   onError: (error, step) => console.error(`reminders: ${step} failed`, error),
 * })
 * runner.start()
 * ```
 *
 * @module
 */
export * from "@spy4x/platform/server/reminder-runner"
