/**
 * Tasks (VTODO) and events (VEVENT) on top of the lossless iCalendar model in `./ical.ts`:
 * read the fields an app shows, patch only the fields it changes, create a new object.
 *
 * A patch changes the patched properties plus DTSTAMP and LAST-MODIFIED. SEQUENCE goes up by one
 * on an event patch, and on a task patch that really changes DTSTART, DUE, RRULE or STATUS (RFC
 * 5545 §3.8.7.4); a task patch of a title, reminder or category, or one that repeats those four
 * with their stored values, leaves it. Every other
 * line, including reminders, vendor `X-` properties, time zones and recurrence overrides, is
 * written back byte for byte. CREATED is never rewritten, and COMPLETED of an already completed
 * task is kept. A patch is atomic: when it is
 * refused, the document is left as it was.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`. The clock, the
 * UID and the PRODID come from the caller; nothing here reads the time or generates a random.
 * @module
 */

export * from "./ical-tasks-todo.ts"
export * from "./ical-tasks-complete.ts"
