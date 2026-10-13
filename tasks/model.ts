/**
 * The `Task` a to-do screen shows, read from a CalDAV resource: `parseTask`, the priority bands,
 * and the helpers that turn a task's date into a day or an instant.
 *
 * The same names as `@spy4x/time/ical-tasks-model`, where the code sits until 2.0: the modules of
 * `@spy4x/time` that write a task back import it there.
 *
 * @example
 * ```ts
 * import { isOpen, parseTask } from "@spy4x/tasks/model"
 *
 * const parsed = parseTask({ href: "/dav/tasks/1.ics", etag: `"1"`, listHref: "/dav/tasks/", ics })
 * if (parsed.success && isOpen(parsed.output)) show(parsed.output)
 * ```
 * @module
 */
export * from "@spy4x/time/ical-tasks-model"
