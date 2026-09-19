/**
 * CalDAV/WebDAV domain types, the shared error codes and the result envelope.
 *
 * Ported from `caldav-mcp/caldav/types.ts` (issue #13). Two deviations from the
 * source, both deliberate:
 *
 *  - every fallible operation in this package returns a {@link CalDavResult}
 *    instead of throwing or returning a sentinel, so a transport failure is
 *    never confused with a valid empty answer;
 *  - a `STATUS` value the source silently mapped to `NEEDS-ACTION` is preserved
 *    verbatim as a property, so a calendar holding `STATUS:X-CUSTOM` no longer
 *    comes back as a different task than the one on the server.
 */

/** RFC 4791 §5.2.3 calendar component kinds a collection can hold. */
export enum ComponentType {
  VEVENT = 1,
  VTODO = 2,
  VJOURNAL = 3,
}

/**
 * Wire name of a {@link ComponentType} member.
 *
 * The map is authoritative rather than the enum key, so a member cannot be
 * renamed by accident and silently start emitting a name no server accepts.
 */
export const ComponentTypeLabel: Record<ComponentType, string> = {
  [ComponentType.VEVENT]: "VEVENT",
  [ComponentType.VTODO]: "VTODO",
  [ComponentType.VJOURNAL]: "VJOURNAL",
}

/** RFC 5545 §3.2.15 `RELTYPE` values permitted on `RELATED-TO`. */
export enum RelatedType {
  PARENT = 1,
  CHILD = 2,
  SIBLING = 3,
}

/** Wire name of a {@link RelatedType} member. */
export const RelatedTypeLabel: Record<RelatedType, string> = {
  [RelatedType.PARENT]: "PARENT",
  [RelatedType.CHILD]: "CHILD",
  [RelatedType.SIBLING]: "SIBLING",
}

/**
 * Reverse of {@link RelatedTypeLabel}.
 *
 * `RELATED-TO` without a `RELTYPE` parameter means `PARENT` (RFC 5545 §3.8.4.5),
 * which callers apply themselves by treating an unresolved name as the default.
 */
export const LabelRelatedType: Record<string, RelatedType> = {
  PARENT: RelatedType.PARENT,
  CHILD: RelatedType.CHILD,
  SIBLING: RelatedType.SIBLING,
}

/** RFC 5545 §3.8.1.11 `STATUS` value for a `VTODO`. */
export enum TodoStatus {
  NEEDS_ACTION = 1,
  IN_PROCESS = 2,
  COMPLETED = 3,
  CANCELLED = 4,
}

/** Wire name of a {@link TodoStatus} member. */
export const TodoStatusLabel: Record<TodoStatus, string> = {
  [TodoStatus.NEEDS_ACTION]: "NEEDS-ACTION",
  [TodoStatus.IN_PROCESS]: "IN-PROCESS",
  [TodoStatus.COMPLETED]: "COMPLETED",
  [TodoStatus.CANCELLED]: "CANCELLED",
}

/**
 * Reverse of {@link TodoStatusLabel}.
 *
 * A `STATUS` outside this set is *not* a `NEEDS-ACTION`; only the task's
 * `status` enum falls back, and the raw string stays available on
 * {@link Todo.statusLabel}. Treating an unknown value as a known one would
 * report a cancelled task as open.
 */
export const LabelTodoStatus: Record<string, TodoStatus> = {
  "NEEDS-ACTION": TodoStatus.NEEDS_ACTION,
  "IN-PROCESS": TodoStatus.IN_PROCESS,
  COMPLETED: TodoStatus.COMPLETED,
  CANCELLED: TodoStatus.CANCELLED,
}

/**
 * Why an operation failed. A closed set, so a caller can branch on the cause
 * instead of matching on a message string.
 */
export enum CalDavErrorCode {
  /** An argument was unusable before any request was attempted. */
  INVALID_ARGUMENT = 1,
  /** The server refused the credentials (`401`, `403`). */
  UNAUTHORIZED = 2,
  /** The resource does not exist (`404`, `410`). */
  NOT_FOUND = 3,
  /** `fetch` rejected: DNS, TLS, connection reset, abort. */
  TRANSPORT = 4,
  /** A response arrived but carried an unexpected status. */
  HTTP_STATUS = 5,
  /** A response arrived but the body could not be understood. */
  PARSE = 6,
  /** The collection precondition failed (`412`), i.e. a stale `If-Match`. */
  PRECONDITION_FAILED = 7,
}

/** Structured failure returned by every fallible operation in this package. */
export interface CalDavError {
  /** Machine-readable cause. */
  code: CalDavErrorCode
  /** Human-readable description; safe to log, never carries credentials. */
  message: string
  /** HTTP status, present when a response arrived. */
  status?: number
  /** Request URL the failure belongs to, present for transport and HTTP failures. */
  url?: string
}

/**
 * The house result envelope.
 *
 * A failed outcome carries an optional partial `output`, which is what makes
 * degradation visible instead of silent: a fan-out query that lost one calendar
 * still returns the other calendars' tasks *and* the reason, so a caller can tell
 * a partial answer from a complete one.
 */
export interface CalDavFailure<T> {
  success: false
  error: CalDavError
  /** A usable partial answer, present only when one exists. */
  output?: T
}

/**
 * The house result envelope: exactly one of success and failure.
 *
 * `CalDavFailure` is a named type rather than an inline union member so that a
 * function returning *a* failure can declare `CalDavFailure<never>`, which is
 * assignable to any `CalDavResult<T>` without a cast and without inventing an
 * `output` for a type it never produces.
 */
export type CalDavResult<T> =
  | { success: true; output: T; warnings?: readonly string[] }
  | CalDavFailure<T>

/** Build a successful envelope; `warnings` is omitted when empty. */
export function ok<T>(output: T, warnings: readonly string[] = []): CalDavResult<T> {
  return warnings.length === 0 ? { success: true, output } : { success: true, output, warnings }
}

/** Build a failed envelope with no partial answer. */
export function fail(
  code: CalDavErrorCode,
  message: string,
  extra: { status?: number; url?: string } = {},
): CalDavFailure<never> {
  const error: CalDavError = { code, message, status: extra.status, url: extra.url }
  return { success: false, error }
}

/** Build a failed envelope that still carries a usable partial `output`. */
export function partial<T>(error: CalDavError, output: T): CalDavFailure<T> {
  return { success: false, error, output }
}

/**
 * Re-shape a failure from one result type into another.
 *
 * Only the error travels: `code`, `message`, `status` and `url`. The failing
 * envelope's own partial `output` is deliberately **dropped**, because it
 * belongs to the stage that produced it. Carrying it across a type change is a
 * lie the compiler cannot see — a failed `listCalendars` hands back
 * `{calendars, warnings}`, and forwarding that as the `output` of a
 * `CalDavResult<TodoQueryResult>` produced an object with no `todos` field at
 * all, which a caller reading `output.todos` would then crash on. A stage that
 * genuinely has a partial answer for *its own* type builds it with
 * {@link partial} instead.
 */
export function reshapeFailure<T>(failure: CalDavFailure<unknown>): CalDavFailure<T> {
  const error: CalDavError = {
    code: failure.error.code,
    message: failure.error.message,
    status: failure.error.status,
    url: failure.error.url,
  }
  return { success: false, error }
}

/** One calendar collection as reported by the server. */
export interface Calendar {
  /** Absolute URL of the collection, resolved against the server root. */
  url: string
  /** `DAV:displayname`, or the URL's last path segment when the server omits it. */
  displayName: string
  /**
   * Components the collection advertises. Empty means the server sent an
   * explicitly empty `supported-calendar-component-set` and must be believed —
   * see `caldav/README.md`, it is not the same as "the property is missing".
   */
  components: ComponentType[]
  /** `http://calendarserver.org/ns/` `calendar-color`. */
  color?: string
  /** `DAV:description`. */
  description?: string
  /** `http://calendarserver.org/ns/` `getctag`; a change marker, not a version. */
  ctag?: string
}

/** A `RELATED-TO` edge: the other task's `UID` and the relation kind. */
export interface RelatedTo {
  /** `UID` of the related component. */
  uid: string
  /** `RELTYPE`, defaulted to `PARENT` when the parameter is absent. */
  reltype: RelatedType
}

/** A `VTODO` as parsed from the wire. */
export interface Todo {
  /** `SUMMARY`, defaulted to `Untitled` when the property is absent. */
  summary: string
  /** `DESCRIPTION`, verbatim after unescaping. */
  description?: string
  /** `CATEGORIES`, split on *unescaped* commas and unescaped per item. */
  categories?: string[]
  /** Parsed `STATUS`; unknown values fall back to `NEEDS_ACTION`. */
  status: TodoStatus
  /**
   * `STATUS` exactly as it appeared on the wire. Authoritative: an unknown value
   * is preserved here while {@link Todo.status} falls back, so a caller is never
   * told a task is open when the server said something else.
   */
  statusLabel: string
  /** `PRIORITY` 1-9; absent outside that range, per RFC 5545 §3.8.1.9. */
  priority?: number
  /** `DUE` as ISO 8601; a `VALUE=DATE` due date stays `YYYY-MM-DD`. */
  due?: string
  /** `COMPLETED` as ISO 8601 UTC. */
  completed?: string
  /** `PERCENT-COMPLETE` 0-100. */
  percentComplete?: number
  /** Deduplicated `RELATED-TO` edges, in document order. Absent when there are none. */
  relatedTo?: RelatedTo[]
  /** Absolute URL of the resource this task was read from. */
  url: string
  /** `DAV:getetag` for the resource, empty when the server sent none. */
  etag: string
  /** `displayName` of the collection the task came from. */
  calendarName: string
  /** `UID`; empty when the resource carried none. */
  uid: string
}

/** A `VEVENT` as parsed from the wire. */
export interface Event {
  /** `SUMMARY`, defaulted to `Untitled` when the property is absent. */
  summary: string
  /** `DESCRIPTION`, verbatim after unescaping. */
  description?: string
  /** `DTSTART` as ISO 8601 UTC, or `YYYY-MM-DD` for a `VALUE=DATE` start. */
  start: string
  /** `DTEND`, or `DTSTART` when the event has no end. */
  end: string
  /** `LOCATION`, verbatim after unescaping. */
  location?: string
  /** Absolute URL of the resource this event was read from. */
  url: string
  /** `DAV:getetag` for the resource, empty when the server sent none. */
  etag: string
  /** `displayName` of the collection the event came from. */
  calendarName: string
  /** `UID`; empty when the resource carried none. */
  uid: string
  /** `STATUS` verbatim; `CONFIRMED`, `TENTATIVE` or `CANCELLED` per RFC 5545. */
  status?: string
}

/** RFC 5545 `PRIORITY` banding used by the aggregator: 1-3, 4-6, 7-9, none. */
export interface PriorityCounts {
  high: number
  medium: number
  low: number
  none: number
}

/** One calendar that could not be queried, and why. */
export interface CalendarFailure {
  /** The collection's `displayName`, or its URL when unnamed. */
  calendarName: string
  /** The collection's URL. */
  url: string
  /** The underlying failure, already stripped of credentials. */
  error: CalDavError
}

/** Aggregated `VTODO` query result. */
export interface TodoQueryResult {
  /** Number of tasks collected before truncation. */
  total: number
  /** Count per `STATUS` label; an unknown status appears under its own label. */
  byStatus: Record<string, number>
  /** Count per `PRIORITY` band. */
  byPriority: PriorityCounts
  /** Tasks that are `NEEDS-ACTION`/`IN-PROCESS` and due strictly before `now`. */
  overdue: number
  /** True when `total` exceeded the response cap, i.e. `todos` is incomplete. */
  truncated: boolean
  /** At most `TODO_LIMIT` tasks, in the order the calendars reported them. */
  todos: TodoSummary[]
  /**
   * Calendars whose query failed. Present and non-empty only when the fan-out
   * lost part of the answer — the other calendars' tasks are still in `todos`.
   */
  failures?: CalendarFailure[]
  /**
   * Notices from the calendar listing the fan-out used, present only when there
   * is one: a collection that was skipped because it is off the configured
   * origin, a `/username/` fallback that had to be used.
   *
   * Independent of `failures`, and load-bearing: without it, a query whose only
   * collection was skipped is indistinguishable from a query over an account
   * with no calendars — both are `{ total: 0 }` with nothing else set.
   */
  warnings?: string[]
}

/** A {@link Todo} projected down to the fields a caller acts on. */
export interface TodoSummary {
  summary: string
  description?: string
  categories?: string[]
  /** `STATUS` label as reported. */
  status: string
  priority?: number
  due?: string
  relatedTo?: RelatedTo[]
  calendarName: string
  url: string
  etag: string
}

/** Aggregated `VEVENT` query result. */
export interface EventQueryResult {
  /** Number of events collected before truncation. */
  total: number
  /** Events starting at or after `now`. */
  upcoming: number
  /** True when `total` exceeded the response cap, i.e. `events` is incomplete. */
  truncated: boolean
  /** At most `EVENT_LIMIT` events. */
  events: EventSummary[]
  /** Calendars whose query failed; see {@link TodoQueryResult.failures}. */
  failures?: CalendarFailure[]
  /** Listing notices; see {@link TodoQueryResult.warnings}. */
  warnings?: string[]
}

/** An {@link Event} projected down to the fields a caller acts on. */
export interface EventSummary {
  summary: string
  description?: string
  start: string
  end: string
  location?: string
  calendarName: string
  url: string
  etag: string
}

/** Client-side `PRIORITY` range filter, applied after the REPORT. */
export interface PriorityFilter {
  /** Lowest accepted priority (1 is highest). Defaults to 1. */
  min?: number
  /** Highest accepted priority (9 is lowest). Defaults to 9. */
  max?: number
}
