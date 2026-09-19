/**
 * Parallel CalDAV query fan-out and aggregation.
 *
 * Ported from `caldav-mcp/caldav/query.ts` (issue #13). Deviations from the
 * source, all deliberate:
 *
 *  - a calendar whose query failed is **reported**. The source's
 *    `catch { return { xml: '' } }` fed `xml: ''` into the loop below, where
 *    `if (!xml) continue` skipped the calendar; a transport failure and a
 *    calendar holding nothing produced the same answer. Failures now travel in
 *    `output.failures`, and the envelope succeeds only when at least one
 *    calendar answered.
 *  - the clock is injected, so `overdue` and `upcoming` are computable in a test
 *    without freezing `Date`. The source called `new Date()` inside the
 *    aggregator.
 *  - the client's credential is read through
 *    `client.authorizationHeader()`, not `client["username"]`.
 *  - `parseIcal`-derived tasks keep their raw `STATUS`, so `byStatus` counts what
 *    the server said rather than what the client wished it had said.
 *
 * Fan-out is `Promise.allSettled`-shaped but not literally: each calendar's
 * result is mapped individually so a rejection cannot discard the sibling
 * results already in flight.
 */

import {
  buildEventIcal,
  buildTodoIcal,
  type IcalBuildOptions,
  parseEvents,
  parseTodos,
  resourceUrl,
  type TodoIcalInput,
} from "./ical.ts"
import { CalDavClient } from "./client.ts"
import {
  CalDavErrorCode,
  type CalDavResult,
  type Calendar,
  type CalendarFailure,
  ComponentType,
  type Event,
  type EventQueryResult,
  type EventSummary,
  fail,
  ok,
  partial,
  type PriorityCounts,
  type PriorityFilter,
  reshapeFailure,
  type Todo,
  type TodoQueryResult,
  TodoStatus,
  TodoStatusLabel,
  type TodoSummary,
} from "./types.ts"
import { normalizeEtag, resourceName } from "./xml.ts"

/**
 * Maximum tasks returned in one response.
 *
 * A cap, not a page size: there is no paging cursor, so a caller that hits it
 * must narrow its filters. `truncated` is how it finds out.
 */
export const TODO_LIMIT = 200

/** Maximum events returned in one response; see {@link TODO_LIMIT}. */
export const EVENT_LIMIT = 200

/** Filters accepted by {@link QueryEngine.queryTodos}. */
export interface TodoQueryOptions {
  /** Restrict the query to one collection URL instead of every advertised one. */
  calendarUrl?: string
  /** `STATUS` text match, passed to the server. */
  status?: string
  /** `SUMMARY` text match, passed to the server. */
  text?: string
  /** Upper bound on `DUE`, passed to the server. */
  dueBefore?: string
  /** Priority range applied **client-side**, after the response. */
  priority?: PriorityFilter
  /** Override the response cap; mainly for tests. Defaults to {@link TODO_LIMIT}. */
  limit?: number
}

/** Filters accepted by {@link QueryEngine.queryEvents}. */
export interface EventQueryOptions {
  /** Restrict the query to one collection URL instead of every advertised one. */
  calendarUrl?: string
  /** Lower `DTSTART` bound, passed to the server. */
  dateFrom?: string
  /** Upper `DTSTART` bound, passed to the server. */
  dateTo?: string
  /** `SUMMARY` text match, passed to the server. */
  text?: string
  /** Override the response cap; mainly for tests. Defaults to {@link EVENT_LIMIT}. */
  limit?: number
}

/** Everything {@link QueryEngine} needs, all injected. */
export interface QueryEngineOptions {
  /** The transport-owning client. */
  client: CalDavClient
  /** Clock used for `overdue` and `upcoming`. Defaults to `new Date()`. */
  now?: Date | (() => Date)
  /** `calendarName` used when a query targets a URL the client did not list. */
  calendarNameFromUrl?: (url: string) => string
}

/** Fields a caller can change on an existing todo. */
export type TodoUpdate = Partial<
  Pick<
    TodoIcalInput,
    "summary" | "description" | "categories" | "due" | "priority" | "status" | "percentComplete"
  >
>

/** Fields a caller can change on an existing event. */
export interface EventUpdate {
  summary?: string
  description?: string
  start?: string
  end?: string
  location?: string
}

/** Aggregated counts plus the tasks themselves, for one page of results. */
export interface TodoAggregate extends TodoQueryResult {
  /** `UID` of every collected task, before filtering; aids dedup across calendars. */
  uids: string[]
}

/**
 * One calendar's contribution to a fan-out, either its tasks or its failure.
 *
 * The source modelled this as `{ xml: string, calendar }` with `''` for failure;
 * this type makes the two cases impossible to confuse.
 */
type CalendarOutcome<T> =
  | { ok: true; calendar: Calendar; items: T[] }
  | { ok: false; calendar: Calendar; failure: CalendarFailure }

/**
 * Default `calendarName` for a URL: the collection's own path segment, decoded.
 *
 * When the URL names a resource (it ends in `.ics`) the segment before it is the
 * collection, so calling this with a task's URL yields `tasks` rather than
 * `a.ics` — the source's `extractCalendarName` walked backwards looking for a
 * segment without a dot, which is the same idea spelled differently.
 */
export function calendarNameFromUrl(url: string): string {
  let segments = url.split("?")[0]!.split("/").filter((segment) => segment !== "")
  const last = segments[segments.length - 1]
  if (last === undefined) return "Unknown"
  if (/\.ics$/i.test(last) && segments.length > 1) segments = segments.slice(0, -1)
  const name = segments[segments.length - 1]!
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * Count tasks by status, priority band and overdue state, then cap the list.
 *
 * `byStatus` is keyed by the label the server reported, so an unknown `STATUS`
 * is counted under its own name rather than silently folded into
 * `NEEDS-ACTION`. `overdue` counts only tasks that are still open and whose
 * `due` is **strictly before** `now`; a task due exactly now is not overdue.
 */
export function aggregateTodos(
  tasks: readonly Todo[],
  now: Date,
  limit = TODO_LIMIT,
): TodoAggregate {
  const byStatus: Record<string, number> = {}
  const byPriority: PriorityCounts = { high: 0, medium: 0, low: 0, none: 0 }
  let overdue = 0

  for (const task of tasks) {
    byStatus[task.statusLabel] = (byStatus[task.statusLabel] ?? 0) + 1

    if (task.priority === undefined) byPriority.none++
    else if (task.priority <= 3) byPriority.high++
    else if (task.priority <= 6) byPriority.medium++
    else byPriority.low++

    if (
      (task.status === TodoStatus.NEEDS_ACTION || task.status === TodoStatus.IN_PROCESS) &&
      task.due !== undefined
    ) {
      const due = new Date(task.due)
      if (!Number.isNaN(due.getTime()) && due.getTime() < now.getTime()) overdue++
    }
  }

  return {
    total: tasks.length,
    byStatus,
    byPriority,
    overdue,
    truncated: tasks.length > limit,
    todos: tasks.slice(0, limit).map(summarizeTodo),
    uids: tasks.map((task) => task.uid),
  }
}

/** Project a {@link Todo} down to the fields a caller acts on. */
export function summarizeTodo(task: Todo): TodoSummary {
  return {
    summary: task.summary,
    description: task.description,
    categories: task.categories,
    status: task.statusLabel,
    priority: task.priority,
    due: task.due,
    relatedTo: task.relatedTo,
    calendarName: task.calendarName,
    url: task.url,
    etag: task.etag,
  }
}

/** Project an {@link Event} down to the fields a caller acts on. */
export function summarizeEvent(event: Event): EventSummary {
  return {
    summary: event.summary,
    description: event.description,
    start: event.start,
    end: event.end,
    location: event.location,
    calendarName: event.calendarName,
    url: event.url,
    etag: event.etag,
  }
}

/**
 * Count events starting at or after `now`, then cap the list.
 *
 * An event with no readable `DTSTART` is never `upcoming`: the parser leaves
 * `start` empty rather than inventing a time, and an empty string is not a
 * future instant.
 */
export function aggregateEvents(
  events: readonly Event[],
  now: Date,
  limit = EVENT_LIMIT,
): EventQueryResult {
  let upcoming = 0
  for (const event of events) {
    const start = new Date(event.start)
    if (!Number.isNaN(start.getTime()) && start.getTime() >= now.getTime()) upcoming++
  }
  return {
    total: events.length,
    upcoming,
    truncated: events.length > limit,
    events: events.slice(0, limit).map(summarizeEvent),
  }
}

/** Apply a client-side priority range filter, treating an omitted bound as open. */
export function filterByPriority(tasks: readonly Todo[], filter: PriorityFilter): Todo[] {
  const min = filter.min ?? 1
  const max = filter.max ?? 9
  return tasks.filter((task) =>
    task.priority !== undefined && task.priority >= min && task.priority <= max
  )
}

/**
 * Build a `UID` → ETag map from one collection's REPORT resources.
 *
 * Keyed by the resource name, which is how a CalDAV server names a task's `.ics`
 * file, and scoped to one collection because a `UID` is only unique inside its
 * own calendar.
 */
function etagsFor(
  resources: readonly { href: string; etag: string }[],
): Map<string, string> {
  const etags = new Map<string, string>()
  for (const resource of resources) {
    if (resource.etag === "") continue
    etags.set(resourceName(resource.href), normalizeEtag(resource.etag))
  }
  return etags
}

/** CalDAV/WebDAV operations over one account, with per-collection error isolation. */
export class QueryEngine {
  private readonly client: CalDavClient
  private readonly clock: () => Date
  private readonly nameOf: (url: string) => string

  constructor(options: QueryEngineOptions) {
    this.client = options.client
    const now = options.now
    this.clock = typeof now === "function" ? now : () => now ?? new Date()
    this.nameOf = options.calendarNameFromUrl ?? calendarNameFromUrl
  }

  /** The `Authorization` header value this engine's client uses, if any. */
  authorizationHeader(): string | undefined {
    return this.client.authorizationHeader()
  }

  /** The client, for a caller that needs a transport-level operation. */
  get transport(): CalDavClient {
    return this.client
  }

  /** List the account's calendars. */
  listCalendars(): Promise<CalDavResult<{ calendars: Calendar[]; warnings: string[] }>> {
    return this.client.listCalendars()
  }

  /** The collections to fan out over, honouring an explicit URL override. */
  private async targetCalendars(
    component: ComponentType.VTODO | ComponentType.VEVENT,
    calendarUrl?: string,
  ): Promise<CalDavResult<Calendar[]>> {
    if (calendarUrl !== undefined) {
      return ok([{
        url: calendarUrl,
        displayName: this.nameOf(calendarUrl),
        components: [component],
      }])
    }
    const listed = await this.client.listCalendars()
    if (!listed.success) return reshapeFailure(listed)
    return ok(listed.output.calendars.filter((calendar) => calendar.components.includes(component)))
  }

  /**
   * Query `VTODO` across every calendar that advertises the component.
   *
   * A calendar whose REPORT fails does not abort the fan-out: its tasks are
   * missing from `output.todos` and the reason is in `output.failures`. The
   * envelope is a failure only when *no* calendar answered — a caller that
   * ignores `success` still gets a usable aggregate, which is what makes
   * partial degradation possible without hiding the failure.
   */
  async queryTodos(options: TodoQueryOptions = {}): Promise<CalDavResult<TodoQueryResult>> {
    const calendars = await this.targetCalendars(ComponentType.VTODO, options.calendarUrl)
    if (!calendars.success) return reshapeFailure(calendars)

    const outcomes = await Promise.all(
      calendars.output.map(async (calendar): Promise<CalendarOutcome<Todo>> => {
        const response = await this.client.queryTodos(calendar.url, {
          status: options.status,
          text: options.text,
          dueBefore: options.dueBefore,
        })
        if (!response.success) {
          return {
            ok: false,
            calendar,
            failure: {
              calendarName: calendar.displayName,
              url: calendar.url,
              error: response.error,
            },
          }
        }
        const { resources, failures } = this.client.readReport(response.output)
        if (failures.length > 0 && resources.length === 0) {
          return {
            ok: false,
            calendar,
            failure: {
              calendarName: calendar.displayName,
              url: calendar.url,
              error: {
                code: CalDavErrorCode.HTTP_STATUS,
                message: `every resource failed: ${failures[0]!.status}`,
                url: calendar.url,
              },
            },
          }
        }
        return { ok: true, calendar, items: this.todosFromResources(calendar, resources) }
      }),
    )

    const tasks: Todo[] = []
    const failures: CalendarFailure[] = []
    for (const outcome of outcomes) {
      if (outcome.ok) tasks.push(...outcome.items)
      else failures.push(outcome.failure)
    }

    const filtered = options.priority ? filterByPriority(tasks, options.priority) : tasks
    const aggregate = aggregateTodos(filtered, this.clock(), options.limit)
    const output: TodoQueryResult = failures.length === 0 ? aggregate : { ...aggregate, failures }
    if (failures.length === calendars.output.length && calendars.output.length > 0) {
      return partial(
        {
          code: CalDavErrorCode.TRANSPORT,
          message: `all ${failures.length} calendar(s) failed: ${failures[0]!.error.message}`,
        },
        output,
      )
    }
    return ok(output)
  }

  /** Parse the tasks out of a `calendar-query` response's resources. */
  private todosFromResources(
    calendar: Calendar,
    resources: { href: string; etag: string; calendarData: string }[],
  ): Todo[] {
    const tasks: Todo[] = []
    // One ETag map per collection: a UID is only unique within its own calendar,
    // and two collections may legitimately hold the same UID for different tasks.
    const etags = etagsFor(resources)
    for (const resource of resources) {
      if (resource.calendarData.trim() === "") continue
      const parsed = parseTodos(resource.calendarData, {
        calendarName: calendar.displayName,
        calendarUrl: calendar.url,
        etags,
      })
      if (!parsed.success) continue
      tasks.push(...parsed.output.todos)
    }
    return tasks
  }

  /** Parse the events out of a `calendar-query` response's resources. */
  private eventsFromResources(
    calendar: Calendar,
    resources: { href: string; etag: string; calendarData: string }[],
  ): Event[] {
    const events: Event[] = []
    const etags = etagsFor(resources)
    for (const resource of resources) {
      if (resource.calendarData.trim() === "") continue
      const parsed = parseEvents(resource.calendarData, {
        calendarName: calendar.displayName,
        calendarUrl: calendar.url,
        etags,
      })
      if (!parsed.success) continue
      events.push(...parsed.output.events)
    }
    return events
  }

  /** Query `VEVENT` across every calendar that advertises the component. */
  async queryEvents(options: EventQueryOptions = {}): Promise<CalDavResult<EventQueryResult>> {
    const calendars = await this.targetCalendars(ComponentType.VEVENT, options.calendarUrl)
    if (!calendars.success) return reshapeFailure(calendars)

    const outcomes = await Promise.all(
      calendars.output.map(async (calendar): Promise<CalendarOutcome<Event>> => {
        const response = await this.client.queryEvents(calendar.url, {
          dateFrom: options.dateFrom,
          dateTo: options.dateTo,
          text: options.text,
        })
        if (!response.success) {
          return {
            ok: false,
            calendar,
            failure: {
              calendarName: calendar.displayName,
              url: calendar.url,
              error: response.error,
            },
          }
        }
        const { resources, failures } = this.client.readReport(response.output)
        if (failures.length > 0 && resources.length === 0) {
          return {
            ok: false,
            calendar,
            failure: {
              calendarName: calendar.displayName,
              url: calendar.url,
              error: {
                code: CalDavErrorCode.HTTP_STATUS,
                message: `every resource failed: ${failures[0]!.status}`,
                url: calendar.url,
              },
            },
          }
        }
        return { ok: true, calendar, items: this.eventsFromResources(calendar, resources) }
      }),
    )

    const events: Event[] = []
    const failures: CalendarFailure[] = []
    for (const outcome of outcomes) {
      if (outcome.ok) events.push(...outcome.items)
      else failures.push(outcome.failure)
    }

    const aggregate = aggregateEvents(events, this.clock(), options.limit)
    const output: EventQueryResult = failures.length === 0 ? aggregate : { ...aggregate, failures }
    if (failures.length === calendars.output.length && calendars.output.length > 0) {
      return partial(
        {
          code: CalDavErrorCode.TRANSPORT,
          message: `all ${failures.length} calendar(s) failed: ${failures[0]!.error.message}`,
        },
        output,
      )
    }
    return ok(output)
  }

  /**
   * Read one task by resource URL.
   *
   * A `404` comes back as `ok(null)` — "there is no task here" is a valid answer,
   * not a failure — while a transport error, an unreadable body or any other
   * status is a failure. The source returned `null` for all of those, so a server
   * that was down looked exactly like a deleted task.
   */
  async getTodo(url: string): Promise<CalDavResult<Todo | null>> {
    const resource = await this.client.getIcalResource(url)
    if (!resource.success) {
      if (resource.error.code === CalDavErrorCode.NOT_FOUND) return ok(null)
      return reshapeFailure(resource)
    }
    const uid = CalDavClient.icalUid(resource.output.data)
    const etags = new Map<string, string>()
    if (uid !== undefined) etags.set(uid, resource.output.etag)
    const parsed = parseTodos(resource.output.data, {
      calendarName: this.nameOf(url),
      calendarUrl: url,
      etags,
    })
    if (!parsed.success) return reshapeFailure(parsed)
    return ok(parsed.output.todos[0] ?? null)
  }

  /** Read one event by resource URL; see {@link QueryEngine.getTodo}. */
  async getEvent(url: string): Promise<CalDavResult<Event | null>> {
    const resource = await this.client.getIcalResource(url)
    if (!resource.success) {
      if (resource.error.code === CalDavErrorCode.NOT_FOUND) return ok(null)
      return reshapeFailure(resource)
    }
    const uid = CalDavClient.icalUid(resource.output.data)
    const etags = new Map<string, string>()
    if (uid !== undefined) etags.set(uid, resource.output.etag)
    const parsed = parseEvents(resource.output.data, {
      calendarName: this.nameOf(url),
      calendarUrl: url,
      etags,
    })
    if (!parsed.success) return reshapeFailure(parsed)
    return ok(parsed.output.events[0] ?? null)
  }

  /** Write a new task into a collection. */
  async createTodo(
    calendarUrl: string,
    todo: TodoIcalInput,
  ): Promise<CalDavResult<{ url: string; etag: string }>> {
    let ical: string
    try {
      ical = buildTodoIcal(todo, this.buildOptions())
    } catch (cause) {
      return invalidArgument(cause, "createTodo")
    }
    const uid = CalDavClient.icalUid(ical)
    if (uid === undefined) {
      return fail(CalDavErrorCode.PARSE, "generated VTODO carries no UID")
    }
    const url = resourceUrl(calendarUrl, uid)
    const written = await this.client.putIcal(url, ical)
    if (!written.success) return reshapeFailure(written)
    return ok({ url: written.output.url, etag: written.output.etag })
  }

  /** Write a new event into a collection. */
  async createEvent(
    calendarUrl: string,
    event: { summary: string; start: string; end: string; description?: string; location?: string },
  ): Promise<CalDavResult<{ url: string; etag: string }>> {
    let ical: string
    try {
      ical = buildEventIcal(event, this.buildOptions())
    } catch (cause) {
      return invalidArgument(cause, "createEvent")
    }
    const uid = CalDavClient.icalUid(ical)
    if (uid === undefined) {
      return fail(CalDavErrorCode.PARSE, "generated VEVENT carries no UID")
    }
    const url = resourceUrl(calendarUrl, uid)
    const written = await this.client.putIcal(url, ical)
    if (!written.success) return reshapeFailure(written)
    return ok({ url: written.output.url, etag: written.output.etag })
  }

  /**
   * Overwrite an existing task, preserving the fields the caller did not supply.
   *
   * The `If-Match` is the caller's ETag, so a concurrent edit produces
   * `PRECONDITION_FAILED` rather than a silent overwrite.
   */
  async updateTodo(
    url: string,
    etag: string,
    updates: TodoUpdate,
  ): Promise<CalDavResult<{ url: string; etag: string }>> {
    const existing = await this.getTodo(url)
    if (!existing.success) return reshapeFailure(existing)
    if (existing.output === null) {
      return fail(CalDavErrorCode.NOT_FOUND, `no todo at ${url}`, { status: 404, url })
    }
    const todo = existing.output
    let ical: string
    try {
      ical = buildTodoIcal({
        summary: updates.summary ?? todo.summary,
        description: updates.description ?? todo.description,
        categories: updates.categories ?? todo.categories,
        status: updates.status ?? todo.statusLabel,
        priority: updates.priority ?? todo.priority,
        due: updates.due ?? todo.due,
        percentComplete: updates.percentComplete ?? todo.percentComplete,
        relatedTo: todo.relatedTo,
      }, this.buildOptions(todo.uid))
    } catch (cause) {
      return invalidArgument(cause, "updateTodo")
    }
    const written = await this.client.putIcal(url, ical, etag)
    if (!written.success) return reshapeFailure(written)
    return ok({ url: written.output.url, etag: written.output.etag })
  }

  /** Overwrite an existing event, preserving the fields the caller did not supply. */
  async updateEvent(
    url: string,
    etag: string,
    updates: EventUpdate,
  ): Promise<CalDavResult<{ url: string; etag: string }>> {
    const existing = await this.getEvent(url)
    if (!existing.success) return reshapeFailure(existing)
    if (existing.output === null) {
      return fail(CalDavErrorCode.NOT_FOUND, `no event at ${url}`, { status: 404, url })
    }
    const event = existing.output
    let ical: string
    try {
      ical = buildEventIcal({
        summary: updates.summary ?? event.summary,
        description: updates.description ?? event.description,
        start: updates.start ?? event.start,
        end: updates.end ?? event.end,
        location: updates.location ?? event.location,
        status: event.status,
      }, this.buildOptions(event.uid))
    } catch (cause) {
      return invalidArgument(cause, "updateEvent")
    }
    const written = await this.client.putIcal(url, ical, etag)
    if (!written.success) return reshapeFailure(written)
    return ok({ url: written.output.url, etag: written.output.etag })
  }

  /** Delete a task's resource, conditionally on its ETag. */
  deleteTodo(url: string, etag: string): Promise<CalDavResult<null>> {
    return this.client.deleteResource(url, etag)
  }

  /** Delete an event's resource, conditionally on its ETag. */
  deleteEvent(url: string, etag: string): Promise<CalDavResult<null>> {
    return this.client.deleteResource(url, etag)
  }

  /** Builder options for this engine: the injected clock and the client's prodid. */
  private buildOptions(uid?: string): IcalBuildOptions {
    const dtstamp = this.clock()
    return uid === undefined ? { dtstamp } : { dtstamp, uid }
  }
}

/** Reshape a thrown builder error (an argument fault) into a failure envelope. */
function invalidArgument(cause: unknown, operation: string): CalDavResult<never> {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return fail(CalDavErrorCode.INVALID_ARGUMENT, `${operation}: ${detail}`)
}

/** Re-export so a caller can label a status without importing `types` twice. */
export { TodoStatus, TodoStatusLabel }
