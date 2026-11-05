/**
 * The `Task` a to-do screen shows, read from a CalDAV resource: `parseTask`, the priority bands,
 * and the helpers that turn a task's date into a day or an instant.
 *
 * The same names as `@spy4x/time/ical-tasks-model`, where the code sits until 2.0: the modules of
 * `@spy4x/time` that write a task back import it there.
 *
 * @example
 * ```ts
 * const parsed = parseTask({ href: "/dav/tasks/1.ics", etag: `"1"`, listHref: "/dav/tasks/", ics })
 * if (parsed.success && isOpen(parsed.output)) show(parsed.output)
 * ```
 *
 * `parseTask` reads one CalDAV resource (`href`, `etag`, `listHref` and the iCalendar text) into a
 * `Task`. A resource with no VTODO, or with one that has no `UID`, is a failure with a message, never
 * a throw: one odd resource must not take the whole list down. `priorityBand` turns the iCalendar
 * `PRIORITY` (0 to 9) into the band a screen shows, `isOpen` says whether a task still needs doing,
 * and `dateInstant` and `dateDay` turn a task's date into a moment or a `YYYY-MM-DD` day in the
 * viewer's time zone.
 *
 * @module
 */
export * from "@spy4x/time/ical-tasks-model"
