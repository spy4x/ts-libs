/**
 * Tasks (VTODO) and events (VEVENT) on top of the lossless iCalendar model in `./ical.ts`:
 * read the fields an app shows, patch only the fields it changes, create a new object.
 *
 * A patch changes the patched properties plus DTSTAMP, LAST-MODIFIED and SEQUENCE. Every other
 * line, including reminders, vendor `X-` properties, time zones and recurrence overrides, is
 * written back byte for byte. CREATED is never rewritten. A patch is atomic: when it is
 * refused, the document is left as it was.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`. The clock, the
 * UID and the PRODID come from the caller; nothing here reads the time or generates a random.
 * @module
 */

import {
  getParameter,
  getProperties,
  getProperty,
  IcalComponent,
  IcalDateKind,
  IcalDateValue,
  IcalErrorCode,
  IcalParameter,
  IcalProperty,
  IcalResult,
  readDate,
  readList,
  readText,
  removeProperty,
  setProperty,
  writeDate,
  writeList,
  writeText,
} from "./ical.ts"
import { icsEscape } from "./ics-core.ts"

/** The STATUS of a task. */
export enum TodoStatus {
  NeedsAction = 1,
  InProcess,
  Completed,
  Cancelled,
}

/** The STATUS of an event. */
export enum EventStatus {
  Tentative = 1,
  Confirmed,
  Cancelled,
}

/** Whether a reminder's trigger is an offset or a moment. */
export enum AlarmTriggerKind {
  /** A duration such as `-PT15M`, counted from the start or the end of the task or event. */
  Relative = 1,
  /** A UTC moment. */
  Absolute,
}

/** What a relative trigger is counted from (`RELATED`, default `START`). */
export enum AlarmRelated {
  Start = 1,
  End,
}

/** The trigger of a reminder. */
export type AlarmTrigger =
  | { kind: AlarmTriggerKind.Relative; duration: string; related: AlarmRelated }
  | { kind: AlarmTriggerKind.Absolute; at: IcalDateValue }

/** A reminder (VALARM), read-only. */
export interface Alarm {
  /** `DISPLAY`, `AUDIO`, `EMAIL`, … as written. */
  action?: string
  trigger?: AlarmTrigger
}

/** A link to another task (RELATED-TO). */
export interface RelatedTo {
  uid: string
  /** Upper-case RELTYPE; `PARENT` when the property has none, as Tasks.org writes it. */
  type: string
}

/** The fields of a task that apps read. A field the task does not have is absent. */
export interface Todo {
  uid?: string
  summary?: string
  description?: string
  status?: TodoStatus
  /** 0 (undefined) to 9, as written. */
  priority?: number
  start?: IcalDateValue
  due?: IcalDateValue
  /** Always UTC when valid. */
  completed?: IcalDateValue
  percentComplete?: number
  categories: string[]
  relatedTo: RelatedTo[]
  /** The RRULE value as written, such as `FREQ=DAILY;INTERVAL=1`. */
  rrule?: string
  /** Whether the task has an RRULE. The helpers never complete a series by themselves. */
  repeats: boolean
  /** X-APPLE-SORT-ORDER, which Tasks.org and Apple Reminders order tasks by. */
  sortOrder?: number
  alarms: Alarm[]
  hasAlarms: boolean
  created?: IcalDateValue
  lastModified?: IcalDateValue
  sequence?: number
}

/** The fields of an event that apps read. */
export interface CalendarEvent {
  uid?: string
  summary?: string
  description?: string
  location?: string
  status?: EventStatus
  start?: IcalDateValue
  end?: IcalDateValue
  /** DURATION as written, such as `PT1H`. */
  duration?: string
  categories: string[]
  rrule?: string
  repeats: boolean
  alarms: Alarm[]
  hasAlarms: boolean
  created?: IcalDateValue
  lastModified?: IcalDateValue
  sequence?: number
}

/**
 * Changes to a task. A field left out stays as it is; `null` clears it.
 *
 * - `status: Completed` also sets COMPLETED (to `now`, UTC) and PERCENT-COMPLETE:100.
 *   `status` set to anything else, or cleared, removes COMPLETED and a PERCENT-COMPLETE of 100.
 * - A task with an RRULE keeps it; set `rrule: null` to end the series.
 * - A zoned `start` or `due` needs its VTIMEZONE in the document already.
 */
export interface TodoPatch {
  summary?: string | null
  description?: string | null
  status?: TodoStatus | null
  priority?: number | null
  start?: IcalDateValue | null
  due?: IcalDateValue | null
  /** Only with `status: Completed`: a UTC moment other than `now`. */
  completed?: IcalDateValue | null
  percentComplete?: number | null
  categories?: string[] | null
  /** Replaces the list. An entry already present with the same uid and type keeps its line. */
  relatedTo?: { uid: string; type?: string }[] | null
  rrule?: string | null
  sortOrder?: number | null
}

/** Changes to an event. A field left out stays as it is; `null` clears it. */
export interface EventPatch {
  summary?: string | null
  description?: string | null
  location?: string | null
  status?: EventStatus | null
  start?: IcalDateValue | null
  /** Setting `end` removes DURATION; setting `duration` removes DTEND. */
  end?: IcalDateValue | null
  duration?: string | null
  categories?: string[] | null
  rrule?: string | null
}

/** Caller-supplied inputs: the clock is never read here. */
export interface PatchOptions {
  /** The moment of the edit: DTSTAMP, LAST-MODIFIED and, for completing, COMPLETED. */
  now: Date
}

/** Caller-supplied inputs for a new object. */
export interface NewOptions extends PatchOptions {
  uid: string
  /** The PRODID of the calling product, such as `-//Example//Tasks 1.0//EN`. */
  prodid: string
}

const STATUS_TODO: [string, TodoStatus][] = [
  ["NEEDS-ACTION", TodoStatus.NeedsAction],
  ["IN-PROCESS", TodoStatus.InProcess],
  ["COMPLETED", TodoStatus.Completed],
  ["CANCELLED", TodoStatus.Cancelled],
]
const STATUS_EVENT: [string, EventStatus][] = [
  ["TENTATIVE", EventStatus.Tentative],
  ["CONFIRMED", EventStatus.Confirmed],
  ["CANCELLED", EventStatus.Cancelled],
]

function fail(code: IcalErrorCode, message: string): IcalResult<never> {
  return { success: false, output: null, error: { code, message } }
}

function ok<T>(output: T): IcalResult<T> {
  return { success: true, output, error: null }
}

/** The component an app edits: `root` itself, or the first child of that name that is not an override. */
function findMaster(root: IcalComponent, name: string): IcalComponent | undefined {
  if (root.name.toUpperCase() === name) return root
  return root.components.find((component) =>
    component.name.toUpperCase() === name && !getProperty(component, "RECURRENCE-ID")
  )
}

function textOf(component: IcalComponent, name: string): string | undefined {
  const property = getProperty(component, name)
  return property ? readText(property) : undefined
}

function dateOf(component: IcalComponent, name: string): IcalDateValue | undefined {
  const property = getProperty(component, name)
  return property ? readDate(property) : undefined
}

function integerOf(component: IcalComponent, name: string): number | undefined {
  const value = getProperty(component, name)?.value.trim()
  return value !== undefined && /^[+-]?\d{1,15}$/.test(value) ? Number(value) : undefined
}

function readAlarm(alarm: IcalComponent): Alarm {
  const out: Alarm = {}
  const action = getProperty(alarm, "ACTION")
  if (action) out.action = action.value
  const trigger = getProperty(alarm, "TRIGGER")
  if (trigger) {
    if (getParameter(trigger, "VALUE")?.values[0]?.toUpperCase() === "DATE-TIME") {
      const at = readDate(trigger)
      if (at) out.trigger = { kind: AlarmTriggerKind.Absolute, at }
    } else {
      const end = getParameter(trigger, "RELATED")?.values[0]?.toUpperCase() === "END"
      out.trigger = {
        kind: AlarmTriggerKind.Relative,
        duration: trigger.value,
        related: end ? AlarmRelated.End : AlarmRelated.Start,
      }
    }
  }
  return out
}

function readAlarms(component: IcalComponent): Alarm[] {
  return component.components.filter((child) => child.name.toUpperCase() === "VALARM")
    .map(readAlarm)
}

function relatedOf(property: IcalProperty): RelatedTo {
  return {
    uid: readText(property),
    type: getParameter(property, "RELTYPE")?.values[0]?.toUpperCase() || "PARENT",
  }
}

/** Fields both kinds share. */
function readCommon(component: IcalComponent) {
  const rrule = getProperty(component, "RRULE")?.value
  const alarms = readAlarms(component)
  return {
    uid: textOf(component, "UID"),
    summary: textOf(component, "SUMMARY"),
    description: textOf(component, "DESCRIPTION"),
    start: dateOf(component, "DTSTART"),
    categories: readList(component, "CATEGORIES"),
    rrule,
    repeats: rrule !== undefined,
    alarms,
    hasAlarms: alarms.length > 0,
    created: dateOf(component, "CREATED"),
    lastModified: dateOf(component, "LAST-MODIFIED"),
    sequence: integerOf(component, "SEQUENCE"),
  }
}

/** Drop absent fields so `"summary" in todo` means the task has one. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}

function readStatus<T>(component: IcalComponent, table: [string, T][]): T | undefined {
  const value = getProperty(component, "STATUS")?.value.trim().toUpperCase()
  return table.find(([name]) => name === value)?.[1]
}

/**
 * Read the first VTODO of `root` that is not a recurrence override. Returns `undefined` when
 * there is none.
 */
export function readTodo(root: IcalComponent): Todo | undefined {
  const todo = findMaster(root, `VTODO`)
  if (!todo) return undefined
  return compact({
    ...readCommon(todo),
    status: readStatus(todo, STATUS_TODO),
    priority: integerOf(todo, "PRIORITY"),
    start: dateOf(todo, "DTSTART"),
    due: dateOf(todo, "DUE"),
    completed: dateOf(todo, "COMPLETED"),
    percentComplete: integerOf(todo, "PERCENT-COMPLETE"),
    relatedTo: getProperties(todo, "RELATED-TO").map(relatedOf),
    sortOrder: integerOf(todo, "X-APPLE-SORT-ORDER"),
  })
}

/**
 * Read the first VEVENT of `root` that is not a recurrence override. Returns `undefined` when
 * there is none.
 */
export function readEvent(root: IcalComponent): CalendarEvent | undefined {
  const event = findMaster(root, `VEVENT`)
  if (!event) return undefined
  return compact({
    ...readCommon(event),
    location: textOf(event, "LOCATION"),
    status: readStatus(event, STATUS_EVENT),
    end: dateOf(event, "DTEND"),
    duration: getProperty(event, "DURATION")?.value,
  })
}

// ---------------------------------------------------------------------------------------------
// Writing

/** `now` as a UTC date value, whole seconds. */
function utcOf(now: Date): IcalDateValue | undefined {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return undefined
  const iso = now.toISOString()
  if (iso.startsWith(`+`) || iso.startsWith(`-`)) return undefined
  return { kind: IcalDateKind.Utc, date: iso.slice(0, 10), time: iso.slice(11, 19) }
}

/**
 * Write one date. `writeDate` checks DUE/DTEND against the DTSTART that is still in the
 * component, which would refuse a patch that changes both; the caller has already checked the
 * final pair, so this writes through a component that holds the property alone.
 */
function putDate(
  component: IcalComponent,
  root: IcalComponent,
  name: string,
  value: IcalDateValue,
): IcalResult<IcalProperty> {
  const existing = getProperty(component, name)
  const alone: IcalComponent = {
    name: component.name,
    properties: existing ? [existing] : [],
    components: [],
  }
  const result = writeDate(alone, name, value, { root })
  if (result.success && !existing) component.properties.push(result.output)
  return result
}

/** Whether a date value is a plain date, for the DUE/DTEND versus DTSTART rule. */
function isDateOnly(value: IcalDateValue | undefined): boolean | undefined {
  return value ? value.kind === IcalDateKind.Date : undefined
}

/** Refuse a patch after which the two values would differ in type (RFC 5545 §3.8.2). */
function checkPair(
  component: IcalComponent,
  patch: Record<string, unknown>,
  first: [string, string],
  second: [string, string],
): IcalResult<true> | undefined {
  const [firstKey, firstName] = first
  const [secondKey, secondName] = second
  if (patch[firstKey] === undefined && patch[secondKey] === undefined) return undefined
  const final = (key: string, name: string) =>
    patch[key] === undefined
      ? isDateOnly(dateOf(component, name))
      : isDateOnly(patch[key] as IcalDateValue | null ?? undefined)
  const a = final(firstKey, firstName)
  const b = final(secondKey, secondName)
  if (a !== undefined && b !== undefined && a !== b) {
    return fail(
      IcalErrorCode.ValueTypeMismatch,
      `${firstName} and ${secondName} must both be dates or both be date-times`,
    )
  }
  return undefined
}

function writeOptionalDate(
  component: IcalComponent,
  root: IcalComponent,
  name: string,
  value: IcalDateValue | null | undefined,
): IcalResult<unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null) {
    removeProperty(component, name)
    return undefined
  }
  const result = putDate(component, root, name, value)
  return result.success ? undefined : result
}

function writeOptionalText(
  component: IcalComponent,
  name: string,
  value: string | null | undefined,
) {
  if (value === undefined) return
  if (value === null) removeProperty(component, name)
  else writeText(component, name, value)
}

function writeOptionalInteger(
  component: IcalComponent,
  name: string,
  value: number | null | undefined,
  min: number,
  max: number,
): IcalResult<unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null) {
    removeProperty(component, name)
    return undefined
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    return fail(IcalErrorCode.InvalidValue, `${name} must be an integer from ${min} to ${max}`)
  }
  setProperty(component, name, String(value))
  return undefined
}

function writeRrule(component: IcalComponent, value: string | null | undefined) {
  if (value === undefined) return undefined
  if (value === null) {
    removeProperty(component, "RRULE")
    return undefined
  }
  if (!/^(?:[^\r\n]*;)?FREQ=[A-Z]+(?:;[^\r\n]*)?$/.test(value)) {
    return fail(IcalErrorCode.InvalidValue, `RRULE must be a recurrence rule with FREQ`)
  }
  setProperty(component, "RRULE", value)
  return undefined
}

function writeCategories(component: IcalComponent, value: string[] | null | undefined) {
  if (value === undefined) return
  writeList(component, "CATEGORIES", value ?? [])
}

function writeRelatedTo(
  component: IcalComponent,
  value: { uid: string; type?: string }[] | null | undefined,
): IcalResult<unknown> | undefined {
  if (value === undefined) return undefined
  const wanted = value ?? []
  for (const entry of wanted) {
    if (!entry.uid || /[\r\n]/.test(entry.uid) || /[^A-Za-z0-9-]/.test(entry.type ?? "")) {
      return fail(IcalErrorCode.InvalidValue, `RELATED-TO needs a uid and a plain RELTYPE`)
    }
  }
  const existing = getProperties(component, "RELATED-TO")
  const keep = new Set<IcalProperty>()
  const fresh: IcalProperty[] = []
  for (const entry of wanted) {
    const type = entry.type?.toUpperCase() ?? "PARENT"
    const match = existing.find((property) => {
      if (keep.has(property)) return false
      const related = relatedOf(property)
      return related.uid === entry.uid && related.type === type
    })
    if (match) keep.add(match)
    else {
      const params: IcalParameter[] = entry.type
        ? [{ name: "RELTYPE", values: [entry.type.toUpperCase()] }]
        : []
      fresh.push({ name: "RELATED-TO", params, value: icsEscape(entry.uid) })
    }
  }
  component.properties = component.properties.filter((property) =>
    property.name.toUpperCase() !== "RELATED-TO" || keep.has(property)
  )
  component.properties.push(...fresh)
  return undefined
}

/** DTSTAMP and LAST-MODIFIED to `now`; SEQUENCE up by one unless `fresh`. */
function stamp(
  component: IcalComponent,
  root: IcalComponent,
  now: IcalDateValue,
  fresh: boolean,
): IcalResult<unknown> | undefined {
  for (const name of ["DTSTAMP", "LAST-MODIFIED"]) {
    const result = putDate(component, root, name, now)
    if (!result.success) return result
  }
  if (!fresh) {
    const current = integerOf(component, "SEQUENCE")
    setProperty(
      component,
      "SEQUENCE",
      String((current !== undefined && current > 0 ? current : 0) + 1),
    )
  }
  return undefined
}

/** Run the writers in order and stop at the first refusal. */
function firstFailure(
  ...steps: (() => IcalResult<unknown> | undefined | void)[]
): IcalResult<never> | undefined {
  for (const step of steps) {
    const result = step()
    if (result && !result.success) return result as IcalResult<never>
  }
  return undefined
}

function applyTodo(
  todo: IcalComponent,
  root: IcalComponent,
  patch: TodoPatch,
  now: IcalDateValue,
  fresh: boolean,
): IcalResult<never> | undefined {
  const mismatch = checkPair(todo, patch as Record<string, unknown>, ["start", "DTSTART"], [
    "due",
    "DUE",
  ])
  if (mismatch) return mismatch as IcalResult<never>
  if (patch.completed != null && patch.status !== TodoStatus.Completed) {
    return fail(IcalErrorCode.InvalidValue, `completed only goes with status Completed`)
  }
  if (
    patch.status === TodoStatus.Completed && patch.percentComplete !== undefined &&
    patch.percentComplete !== 100
  ) {
    return fail(IcalErrorCode.InvalidValue, `a completed task is 100 percent complete`)
  }
  if (
    patch.status !== undefined && patch.status !== null &&
    !STATUS_TODO.some(([, value]) => value === patch.status)
  ) {
    return fail(IcalErrorCode.InvalidValue, `unknown task status ${String(patch.status)}`)
  }
  return firstFailure(
    () => writeOptionalText(todo, "SUMMARY", patch.summary),
    () => writeOptionalText(todo, "DESCRIPTION", patch.description),
    () => writeOptionalDate(todo, root, "DTSTART", patch.start),
    () => writeOptionalDate(todo, root, "DUE", patch.due),
    () => writeOptionalInteger(todo, "PRIORITY", patch.priority, 0, 9),
    () => writeOptionalInteger(todo, "PERCENT-COMPLETE", patch.percentComplete, 0, 100),
    () =>
      writeOptionalInteger(
        todo,
        "X-APPLE-SORT-ORDER",
        patch.sortOrder,
        -(2 ** 53 - 1),
        2 ** 53 - 1,
      ),
    () => writeCategories(todo, patch.categories),
    () => writeRelatedTo(todo, patch.relatedTo),
    () => writeRrule(todo, patch.rrule),
    () => applyStatus(todo, root, patch, now),
    () => stamp(todo, root, now, fresh),
  )
}

/** STATUS with COMPLETED and PERCENT-COMPLETE kept consistent with it. */
function applyStatus(
  todo: IcalComponent,
  root: IcalComponent,
  patch: TodoPatch,
  now: IcalDateValue,
): IcalResult<unknown> | undefined {
  if (patch.status === undefined) return undefined
  if (patch.status === TodoStatus.Completed) {
    setProperty(todo, "STATUS", "COMPLETED")
    setProperty(todo, "PERCENT-COMPLETE", "100")
    return putDate(todo, root, "COMPLETED", patch.completed ?? now).success
      ? undefined
      : fail(IcalErrorCode.InvalidValue, `COMPLETED must be a UTC date-time`)
  }
  if (patch.status === null) removeProperty(todo, "STATUS")
  else setProperty(todo, "STATUS", STATUS_TODO.find(([, value]) => value === patch.status)![0])
  removeProperty(todo, "COMPLETED")
  if (integerOf(todo, "PERCENT-COMPLETE") === 100) removeProperty(todo, "PERCENT-COMPLETE")
  return undefined
}

function hasKeys(patch: object): boolean {
  return Object.values(patch).some((value) => value !== undefined)
}

/** Apply `change` to a copy of `root` and, if it succeeds, move the copy's contents into `root`. */
function transaction(
  root: IcalComponent,
  name: string,
  change: (component: IcalComponent, copy: IcalComponent) => IcalResult<never> | undefined,
): IcalResult<true> {
  const copy = structuredClone(root)
  const component = findMaster(copy, name)
  if (!component) return fail(IcalErrorCode.Malformed, `no ${name} to patch`)
  const failure = change(component, copy)
  if (failure) return failure
  root.properties = copy.properties
  root.components = copy.components
  return ok(true)
}

/**
 * Patch the first VTODO of `root` in place and return the task as it now reads.
 *
 * Changes only the patched fields plus DTSTAMP, LAST-MODIFIED (both `options.now`) and
 * SEQUENCE (+1). A patch with no fields is a no-op: nothing is stamped. See {@link TodoPatch}.
 *
 * Refuses, leaving `root` untouched: no VTODO ({@link IcalErrorCode.Malformed}); a DUE and
 * DTSTART that would differ in value type ({@link IcalErrorCode.ValueTypeMismatch}); a zoned
 * date with no VTIMEZONE ({@link IcalErrorCode.UnknownTzid}); a bad priority, percent, status,
 * date, RRULE or RELATED-TO ({@link IcalErrorCode.InvalidValue}).
 *
 * A repeating task stays repeating: `status: Completed` is written as asked and the result has
 * `repeats: true`, so the caller can tell. Moving a series to its next occurrence is not done
 * here.
 */
export function patchTodo(
  root: IcalComponent,
  patch: TodoPatch,
  options: PatchOptions,
): IcalResult<Todo> {
  const now = utcOf(options.now)
  if (!now) return fail(IcalErrorCode.InvalidValue, `now is not a valid date`)
  if (!hasKeys(patch)) {
    const current = readTodo(root)
    return current ? ok(current) : fail(IcalErrorCode.Malformed, `no VTODO to patch`)
  }
  const done = transaction(
    root,
    `VTODO`,
    (todo, copy) => applyTodo(todo, copy, patch, now, false),
  )
  return done.success ? ok(readTodo(root)!) : done
}

/**
 * Patch the first VEVENT of `root` in place and return the event as it now reads. Changes only
 * the patched fields plus DTSTAMP, LAST-MODIFIED and SEQUENCE (+1); recurrence overrides are
 * untouched. Refusals are those of {@link patchTodo}, with DTEND in place of DUE.
 */
export function patchEvent(
  root: IcalComponent,
  patch: EventPatch,
  options: PatchOptions,
): IcalResult<CalendarEvent> {
  const now = utcOf(options.now)
  if (!now) return fail(IcalErrorCode.InvalidValue, `now is not a valid date`)
  if (!hasKeys(patch)) {
    const current = readEvent(root)
    return current ? ok(current) : fail(IcalErrorCode.Malformed, `no VEVENT to patch`)
  }
  const done = transaction(
    root,
    `VEVENT`,
    (event, copy) => applyEvent(event, copy, patch, now, false),
  )
  return done.success ? ok(readEvent(root)!) : done
}

function applyEvent(
  event: IcalComponent,
  root: IcalComponent,
  patch: EventPatch,
  now: IcalDateValue,
  fresh: boolean,
): IcalResult<never> | undefined {
  if (patch.end && patch.duration) {
    return fail(IcalErrorCode.InvalidValue, `an event has an end or a duration, not both`)
  }
  if (
    patch.status !== undefined && patch.status !== null &&
    !STATUS_EVENT.some(([, value]) => value === patch.status)
  ) {
    return fail(IcalErrorCode.InvalidValue, `unknown event status ${String(patch.status)}`)
  }
  if (
    patch.duration != null &&
    !/^[+-]?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(patch.duration)
  ) {
    return fail(IcalErrorCode.InvalidValue, `DURATION must be an ISO 8601 duration`)
  }
  const mismatch = checkPair(event, patch as Record<string, unknown>, ["start", "DTSTART"], [
    "end",
    "DTEND",
  ])
  if (mismatch) return mismatch as IcalResult<never>
  return firstFailure(
    () => writeOptionalText(event, "SUMMARY", patch.summary),
    () => writeOptionalText(event, "DESCRIPTION", patch.description),
    () => writeOptionalText(event, "LOCATION", patch.location),
    () => writeOptionalDate(event, root, "DTSTART", patch.start),
    () => writeOptionalDate(event, root, "DTEND", patch.end),
    () => {
      if (patch.end) removeProperty(event, "DURATION")
      if (patch.duration) removeProperty(event, "DTEND")
      if (patch.duration === null) removeProperty(event, "DURATION")
      if (patch.duration) setProperty(event, "DURATION", patch.duration)
    },
    () => {
      if (patch.status === undefined) return
      if (patch.status === null) removeProperty(event, "STATUS")
      else setProperty(event, "STATUS", STATUS_EVENT.find(([, v]) => v === patch.status)![0])
    },
    () => writeCategories(event, patch.categories),
    () => writeRrule(event, patch.rrule),
    () => stamp(event, root, now, fresh),
  )
}

/** A VCALENDAR with the VERSION and PRODID headers and an empty component of `name`. */
function skeleton(name: string, options: NewOptions): IcalResult<[IcalComponent, IcalComponent]> {
  if (!options.uid || /[\r\n]/.test(options.uid)) {
    return fail(IcalErrorCode.InvalidValue, `uid must be a non-empty single line`)
  }
  if (!options.prodid || /[\r\n]/.test(options.prodid)) {
    return fail(IcalErrorCode.InvalidValue, `prodid must be a non-empty single line`)
  }
  const item: IcalComponent = { name, properties: [], components: [] }
  setProperty(item, "UID", icsEscape(options.uid))
  const root: IcalComponent = {
    name: "VCALENDAR",
    properties: [],
    components: [item],
  }
  setProperty(root, "VERSION", "2.0")
  setProperty(root, "PRODID", options.prodid)
  return ok([root, item])
}

/**
 * Build a new calendar object holding one VTODO from `fields`, with UID, DTSTAMP, CREATED and
 * LAST-MODIFIED from `options`. Serialise it with `serializeIcal`. Fields are those of
 * {@link TodoPatch}; `null` is the same as leaving a field out. Refuses what {@link patchTodo}
 * refuses; a zoned date is refused because a new document has no VTIMEZONE.
 */
export function newTodo(fields: TodoPatch, options: NewOptions): IcalResult<IcalComponent> {
  const now = utcOf(options.now)
  if (!now) return fail(IcalErrorCode.InvalidValue, `now is not a valid date`)
  const made = skeleton("VTODO", options)
  if (!made.success) return made
  const [root, todo] = made.output
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as TodoPatch
  const failure = applyTodo(todo, root, clean, now, true) ?? addCreated(todo, root, now)
  return failure ?? ok(root)
}

/** Build a new calendar object holding one VEVENT; see {@link newTodo}. */
export function newEvent(fields: EventPatch, options: NewOptions): IcalResult<IcalComponent> {
  const now = utcOf(options.now)
  if (!now) return fail(IcalErrorCode.InvalidValue, `now is not a valid date`)
  const made = skeleton("VEVENT", options)
  if (!made.success) return made
  const [root, event] = made.output
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as EventPatch
  const failure = applyEvent(event, root, clean, now, true) ?? addCreated(event, root, now)
  return failure ?? ok(root)
}

function addCreated(
  component: IcalComponent,
  root: IcalComponent,
  now: IcalDateValue,
): IcalResult<never> | undefined {
  const result = putDate(component, root, "CREATED", now)
  return result.success ? undefined : (result as IcalResult<never>)
}
