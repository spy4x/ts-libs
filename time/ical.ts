/**
 * A lossless iCalendar (RFC 5545) document model: parse a calendar object into components,
 * properties and parameters, edit what you need, and serialise it back.
 *
 * Every property keeps the physical lines it was read from. {@link serializeIcal} writes an
 * untouched property back byte for byte and re-serialises only the ones whose name, parameters
 * or value changed, so reminders, subtask links, sort orders, vendor `X-` properties, time zone
 * definitions and recurrence overrides survive an edit made by code that knows nothing about
 * them. Parse then serialise of untouched CRLF input is byte-identical, including the order of
 * a property that a server wrote after a subcomponent (Radicale does).
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`, no dependencies.
 * Built on the wire primitives of `./ics-core.ts` and the zone math of `./tz.ts`.
 * @module
 */

import {
  CRLF,
  foldLine,
  icsEscape,
  icsEscapeParameter,
  icsUnescape,
  icsUnescapeParameter,
} from "./ics-core.ts"
import { isValidTimeZone, zonedDateTime } from "./tz.ts"

/** One parameter of a property, such as `TZID=Europe/Berlin`. Values are decoded (RFC 6868). */
export interface IcalParameter {
  /** Upper-case parameter name. */
  name: string
  /** Decoded values, unquoted. Empty for a malformed parameter written without `=`. */
  values: string[]
}

/** One content line: a name, its parameters and its raw (still escaped) value. */
export interface IcalProperty {
  /** Upper-case property name. */
  name: string
  params: IcalParameter[]
  /** The value exactly as on the wire after unfolding: TEXT is still escaped. */
  value: string
  /**
   * The physical lines this property was parsed from, joined with CRLF. While name, params
   * and value still match it, {@link serializeIcal} writes these lines unchanged.
   */
  source?: string
}

/** A `BEGIN:…`/`END:…` block with its properties and nested components. */
export interface IcalComponent {
  /** Upper-case component name, such as `VCALENDAR`, `VTODO` or `VALARM`. */
  name: string
  properties: IcalProperty[]
  components: IcalComponent[]
  /** The original `BEGIN` and `END` lines, written back while `name` still matches them. */
  source?: { begin: string; end: string }
  /**
   * Set by {@link parseIcal} when this component was followed by a property of its parent in
   * the input. {@link serializeIcal} writes the component just before that property, so a
   * document that interleaves the two keeps its order. Without it, components follow the
   * parent's properties.
   *
   * It is an object reference into the parent's `properties`, so it survives `structuredClone`
   * but not a JSON round trip: a tree rebuilt from JSON writes such a component after the
   * parent's properties instead.
   */
  before?: IcalProperty
}

/** Whether a date value is a date, a floating time, a UTC time or a time in a named zone. */
export enum IcalDateKind {
  /** `VALUE=DATE`: a calendar date with no time. */
  Date = 1,
  /** A local time with no zone: the same wall clock wherever the reader is. */
  Floating,
  /** A UTC time, written with a trailing `Z`. */
  Utc,
  /** A local time in the zone named by the `TZID` parameter. */
  Zoned,
}

/** A DATE or DATE-TIME value in a form that keeps its kind through a round trip. */
export interface IcalDateValue {
  kind: IcalDateKind
  /** `YYYY-MM-DD`. */
  date: string
  /** `HH:MM:SS`; absent for {@link IcalDateKind.Date}. */
  time?: string
  /** The `TZID` parameter; only for {@link IcalDateKind.Zoned}. */
  tzid?: string
}

/** Why an operation of this module failed. */
export enum IcalErrorCode {
  /** The input is larger than `maxBytes`. */
  TooLarge = 1,
  /** Components nest deeper than `maxDepth`. */
  TooDeep,
  /** The input is not a well-formed iCalendar object. */
  Malformed,
  /** A value is not valid for the property it is written to. */
  InvalidValue,
  /** The edit would give DUE or DTEND a different value type than DTSTART (RFC 5545). */
  ValueTypeMismatch,
  /** A `TZID` is not defined by a VTIMEZONE in the document. */
  UnknownTzid,
}

/** The error half of {@link IcalResult}. */
export interface IcalError {
  code: IcalErrorCode
  message: string
  /** 1-based physical line of the input, for parse errors. */
  line?: number
}

/** `{ success, output, error }`: the output, or why there is none. */
export type IcalResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: IcalError }

/** Limits for {@link parseIcal}. */
export interface IcalParseOptions {
  /** Largest accepted input in UTF-8 octets. Default 4 MiB. */
  maxBytes?: number
  /** Deepest accepted component nesting; `VCALENDAR` is depth 1. Default 16. */
  maxDepth?: number
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 16
const NAME = /^[A-Za-z0-9-]+$/
const UTC_ONLY = new Set(["COMPLETED", "DTSTAMP", "CREATED", "LAST-MODIFIED"])

function ok<T>(output: T): IcalResult<T> {
  return { success: true, output, error: null }
}

function fail<T>(code: IcalErrorCode, message: string, line?: number): IcalResult<T> {
  return { success: false, output: null, error: { code, message, ...(line ? { line } : {}) } }
}

/** A content line split into its parts, or the reason it could not be. */
function parseContentLine(text: string): Omit<IcalProperty, "source"> | string {
  let index = 0
  const readName = (): string => {
    const start = index
    while (index < text.length && /[A-Za-z0-9-]/.test(text[index]!)) index++
    return text.slice(start, index)
  }
  const name = readName()
  if (name === "") return "missing property name"
  const params: IcalParameter[] = []
  while (text[index] === ";") {
    index++
    const paramName = readName()
    if (paramName === "") return `empty parameter name in ${name}`
    const values: string[] = []
    if (text[index] === "=") {
      do {
        index++
        if (text[index] === '"') {
          const close = text.indexOf('"', index + 1)
          if (close === -1) return `unterminated quoted parameter in ${name}`
          values.push(icsUnescapeParameter(text.slice(index + 1, close)))
          index = close + 1
        } else {
          const start = index
          while (index < text.length && !';:,"'.includes(text[index]!)) index++
          values.push(icsUnescapeParameter(text.slice(start, index)))
        }
      } while (text[index] === ",")
    }
    params.push({ name: paramName.toUpperCase(), values })
  }
  if (text[index] !== ":") return `expected ":" after ${name}`
  return { name: name.toUpperCase(), params, value: text.slice(index + 1) }
}

/** Physical lines with their 1-based numbers; bare LF is accepted, blank lines are skipped. */
function physicalLines(text: string): { text: string; number: number }[] {
  const lines = text.split(/\r?\n/)
  return lines.map((line, index) => ({ text: line, number: index + 1 })).filter((line) =>
    line.text !== ""
  )
}

/**
 * Parse one iCalendar object (normally a `VCALENDAR`) into a component tree.
 *
 * Accepts CRLF or bare LF line breaks and continuation lines that start with SPACE or HTAB.
 * Fails with {@link IcalErrorCode.TooLarge}, {@link IcalErrorCode.TooDeep} or
 * {@link IcalErrorCode.Malformed} — never throws for bad input. A leading byte-order mark and
 * blank lines are dropped; everything else is kept for {@link serializeIcal}.
 */
export function parseIcal(text: string, options: IcalParseOptions = {}): IcalResult<IcalComponent> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  // A UTF-16 code unit encodes to at most three UTF-8 octets, so encode only when it matters.
  if (text.length * 3 > maxBytes && new TextEncoder().encode(text).length > maxBytes) {
    return fail(IcalErrorCode.TooLarge, `input is larger than ${maxBytes} octets`)
  }
  if (text.startsWith("﻿")) text = text.slice(1)

  const lines = physicalLines(text)
  const stack: IcalComponent[] = []
  // Components waiting for the next property of their parent, which they then precede.
  const pending: IcalComponent[][] = []
  let root: IcalComponent | undefined

  for (let index = 0; index < lines.length;) {
    const first = lines[index]!
    if (first.text[0] === " " || first.text[0] === "\t") {
      return fail(
        IcalErrorCode.Malformed,
        "continuation line without a line to continue",
        first.number,
      )
    }
    const physical = [first.text]
    let unfolded = first.text
    index++
    while (
      index < lines.length && (lines[index]!.text[0] === " " || lines[index]!.text[0] === "\t")
    ) {
      physical.push(lines[index]!.text)
      unfolded += lines[index]!.text.slice(1)
      index++
    }
    const source = physical.join(CRLF)
    const parsed = parseContentLine(unfolded)
    if (typeof parsed === "string") return fail(IcalErrorCode.Malformed, parsed, first.number)

    if (parsed.name === "BEGIN" || parsed.name === "END") {
      const name = parsed.value.toUpperCase()
      if (!NAME.test(name) || parsed.params.length > 0) {
        return fail(IcalErrorCode.Malformed, `invalid ${parsed.name} line`, first.number)
      }
      if (parsed.name === "BEGIN") {
        if (root && stack.length === 0) {
          return fail(IcalErrorCode.Malformed, "more than one top-level component", first.number)
        }
        if (stack.length >= maxDepth) {
          return fail(
            IcalErrorCode.TooDeep,
            `components nest deeper than ${maxDepth}`,
            first.number,
          )
        }
        const component: IcalComponent = {
          name,
          properties: [],
          components: [],
          source: { begin: source, end: "" },
        }
        const parent = stack.at(-1)
        if (parent) {
          parent.components.push(component)
          pending.at(-1)!.push(component)
        } else root = component
        stack.push(component)
        pending.push([])
      } else {
        const open = stack.pop()
        pending.pop()
        if (!open || open.name !== name) {
          return fail(
            IcalErrorCode.Malformed,
            `END:${name} does not close ${open?.name ?? "anything"}`,
            first.number,
          )
        }
        open.source!.end = source
      }
      continue
    }

    const current = stack.at(-1)
    if (!current) return fail(IcalErrorCode.Malformed, "property outside a component", first.number)
    const property: IcalProperty = { ...parsed, source }
    for (const component of pending.at(-1)!) component.before = property
    pending[pending.length - 1] = []
    current.properties.push(property)
  }

  if (stack.length > 0) return fail(IcalErrorCode.Malformed, `${stack.at(-1)!.name} is not closed`)
  if (!root) return fail(IcalErrorCode.Malformed, "no component found")
  return ok(root)
}

function sameParams(a: IcalParameter[], b: IcalParameter[]): boolean {
  return a.length === b.length &&
    a.every((param, index) =>
      param.name === b[index]!.name && param.values.length === b[index]!.values.length &&
      param.values.every((value, valueIndex) => value === b[index]!.values[valueIndex])
    )
}

/** True when `source` still describes the property: the property has not been edited. */
function sourceMatches(property: IcalProperty): boolean {
  if (property.source === undefined) return false
  const parsed = parseContentLine(property.source.replace(/\r?\n[ \t]/g, ""))
  return typeof parsed !== "string" && parsed.name === property.name.toUpperCase() &&
    parsed.value === property.value && sameParams(parsed.params, property.params)
}

function assertName(name: string, what: string): void {
  if (!NAME.test(name)) throw new TypeError(`invalid ${what} name ${JSON.stringify(name)}`)
}

function assertNoLineBreak(value: string, what: string): void {
  if (/[\r\n]/.test(value)) {
    throw new TypeError(`${what} must not contain a line break; escape it first`)
  }
}

function formatParameterValue(value: string): string {
  const escaped = icsEscapeParameter(value)
  return /[:;,]/.test(escaped) ? `"${escaped}"` : escaped
}

/** A fresh, folded content line for an edited or new property. */
function formatProperty(property: IcalProperty): string {
  assertName(property.name, "property")
  assertNoLineBreak(property.value, `value of ${property.name}`)
  let line = property.name.toUpperCase()
  for (const param of property.params) {
    assertName(param.name, "parameter")
    line += `;${param.name.toUpperCase()}`
    if (param.values.length > 0) line += `=${param.values.map(formatParameterValue).join(",")}`
  }
  return foldLine(`${line}:${property.value}`)
}

function writeComponent(component: IcalComponent, out: string[]): void {
  assertName(component.name, "component")
  const name = component.name.toUpperCase()
  const { begin, end } = component.source ?? { begin: "", end: "" }
  const keeps = (line: string, keyword: string) =>
    line.replace(/\r?\n[ \t]/g, "").toUpperCase() === `${keyword}:${name}`
  out.push(keeps(begin, "BEGIN") ? begin : `BEGIN:${name}`)
  // One pass to group children by the property they precede keeps serialising linear.
  const present = new Set(component.properties)
  const preceding = new Map<IcalProperty, IcalComponent[]>()
  const trailing: IcalComponent[] = []
  for (const child of component.components) {
    if (child.before && present.has(child.before)) {
      const group = preceding.get(child.before)
      if (group) group.push(child)
      else preceding.set(child.before, [child])
    } else trailing.push(child)
  }
  for (const property of component.properties) {
    for (const child of preceding.get(property) ?? []) writeComponent(child, out)
    out.push(sourceMatches(property) ? property.source! : formatProperty(property))
  }
  for (const child of trailing) writeComponent(child, out)
  out.push(keeps(end, "END") ? end : `END:${name}`)
}

/**
 * Serialise a component tree to iCalendar text with CRLF line breaks, the last line included.
 *
 * Properties that still match their {@link IcalProperty.source} are written byte for byte;
 * every other property is written fresh and folded to at most 75 octets without splitting a
 * UTF-8 sequence. Throws a `TypeError` for a name that is not an iCalendar name or a raw value
 * holding a line break: both would let one value inject lines into the document.
 */
export function serializeIcal(root: IcalComponent): string {
  const out: string[] = []
  writeComponent(root, out)
  return out.join(CRLF) + CRLF
}

/** The first property named `name` (any case), or `undefined`. */
export function getProperty(component: IcalComponent, name: string): IcalProperty | undefined {
  const upper = name.toUpperCase()
  return component.properties.find((property) => property.name.toUpperCase() === upper)
}

/** Every property named `name` (any case), in document order. */
export function getProperties(component: IcalComponent, name: string): IcalProperty[] {
  const upper = name.toUpperCase()
  return component.properties.filter((property) => property.name.toUpperCase() === upper)
}

/** The first parameter named `name` (any case) of a property, or `undefined`. */
export function getParameter(property: IcalProperty, name: string): IcalParameter | undefined {
  const upper = name.toUpperCase()
  return property.params.find((param) => param.name.toUpperCase() === upper)
}

/**
 * Set the raw value of the first property named `name`, in place, or append a new property.
 *
 * `params` replaces the property's parameters; leave it out to keep the existing ones (a new
 * property then has none). The value is written as given, so TEXT must already be escaped —
 * use {@link writeText} for plain text. Throws a `TypeError` for an invalid name or a value
 * holding a line break.
 */
export function setProperty(
  component: IcalComponent,
  name: string,
  value: string,
  params?: IcalParameter[],
): IcalProperty {
  assertName(name, "property")
  assertNoLineBreak(value, `value of ${name}`)
  for (const param of params ?? []) assertName(param.name, "parameter")
  const existing = getProperty(component, name)
  if (existing) {
    existing.value = value
    if (params) existing.params = params
    return existing
  }
  const property: IcalProperty = { name: name.toUpperCase(), params: params ?? [], value }
  component.properties.push(property)
  return property
}

/** Remove every property named `name` (any case). Returns how many were removed. */
export function removeProperty(component: IcalComponent, name: string): number {
  const upper = name.toUpperCase()
  const before = component.properties.length
  component.properties = component.properties.filter((property) =>
    property.name.toUpperCase() !== upper
  )
  return before - component.properties.length
}

/** The unescaped TEXT value of a property (RFC 5545 §3.3.11). */
export function readText(property: IcalProperty): string {
  return icsUnescape(property.value)
}

/** Escape `text` as TEXT and set it with {@link setProperty}, keeping existing parameters. */
export function writeText(component: IcalComponent, name: string, text: string): IcalProperty {
  return setProperty(component, name, icsEscape(text))
}

/** Split a raw list value on commas that are not escaped with a backslash. */
function splitList(value: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\") index++
    else if (value[index] === ",") {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/**
 * Every item of every property named `name`, such as all CATEGORIES across several lines.
 * Splits only on unescaped commas and unescapes each item; an empty value adds nothing.
 */
export function readList(component: IcalComponent, name: string): string[] {
  return getProperties(component, name).flatMap((property) =>
    property.value === "" ? [] : splitList(property.value).map(icsUnescape)
  )
}

/**
 * Replace every property named `name` with one line listing `items`, each escaped as TEXT.
 * The merged line takes the place of the first original one. No items removes the property.
 */
export function writeList(component: IcalComponent, name: string, items: string[]): void {
  const first = getProperty(component, name)
  if (items.length === 0) {
    removeProperty(component, name)
    return
  }
  const value = items.map(icsEscape).join(",")
  if (!first) {
    setProperty(component, name, value)
    return
  }
  component.properties = component.properties.filter((property) =>
    property === first || property.name.toUpperCase() !== first.name.toUpperCase()
  )
  setProperty(component, name, value)
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

/**
 * Read a DATE or DATE-TIME property as an {@link IcalDateValue}, or `undefined` when its value
 * is not a valid date. For a list (EXDATE, RDATE) only the first item is read. A trailing `Z`
 * means UTC even when a TZID parameter is present.
 */
export function readDate(property: IcalProperty): IcalDateValue | undefined {
  const raw = splitList(property.value)[0]!
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(raw)
  if (!match) return undefined
  const [, year, month, day, hours, minutes, seconds, zulu] = match
  if (!validDate(Number(year), Number(month), Number(day))) return undefined
  const date = `${year}-${month}-${day}`
  const isDate = getParameter(property, "VALUE")?.values[0]?.toUpperCase() === "DATE"
  if (hours === undefined) {
    return isDate || !getParameter(property, "VALUE")
      ? { kind: IcalDateKind.Date, date }
      : undefined
  }
  if (isDate || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 60) return undefined
  const time = `${hours}:${minutes}:${seconds}`
  if (zulu) return { kind: IcalDateKind.Utc, date, time }
  const tzid = getParameter(property, "TZID")?.values[0]
  return tzid
    ? { kind: IcalDateKind.Zoned, date, time, tzid }
    : { kind: IcalDateKind.Floating, date, time }
}

/** Whether `root` (or any component under it) holds a VTIMEZONE whose TZID is `tzid`. */
function hasTimezone(root: IcalComponent, tzid: string): boolean {
  if (root.name.toUpperCase() === "VTIMEZONE" && getProperty(root, "TZID")?.value === tzid) {
    return true
  }
  return root.components.some((child) => hasTimezone(child, tzid))
}

/** The sibling whose value type must match `name`'s, per RFC 5545 §3.6.1 and §3.6.2. */
const PAIRED: Record<string, string[]> = {
  DTSTART: ["DUE", "DTEND"],
  DUE: ["DTSTART"],
  DTEND: ["DTSTART"],
}

/** Options for {@link writeDate}. */
export interface IcalWriteDateOptions {
  /** The document root; needed to check that a zoned value's TZID has a VTIMEZONE. */
  root?: IcalComponent
}

/**
 * Write `value` to the property `name` of `component`, keeping its kind: a date gets
 * `VALUE=DATE`, a zoned time gets `TZID`, a UTC time a trailing `Z`. Other parameters of an
 * existing property stay.
 *
 * Refuses, with an error instead of a write:
 * - a malformed date or time, or an unknown kind ({@link IcalErrorCode.InvalidValue});
 * - a property that holds a list, such as `EXDATE:d1,d2`: writing one date would drop the
 *   others ({@link IcalErrorCode.InvalidValue});
 * - a non-UTC value for COMPLETED, DTSTAMP, CREATED or LAST-MODIFIED, or a second CREATED
 *   ({@link IcalErrorCode.InvalidValue});
 * - a DUE, DTEND or DTSTART whose value type (date versus date-time) would differ from its
 *   partner's ({@link IcalErrorCode.ValueTypeMismatch}); to switch both, remove one first;
 * - a zoned value whose TZID has no VTIMEZONE in `options.root` ({@link IcalErrorCode.UnknownTzid}):
 *   this module never invents a VTIMEZONE.
 */
export function writeDate(
  component: IcalComponent,
  name: string,
  value: IcalDateValue,
  options: IcalWriteDateOptions = {},
): IcalResult<IcalProperty> {
  const upper = name.toUpperCase()
  if (!Object.values(IcalDateKind).includes(value.kind)) {
    return fail(IcalErrorCode.InvalidValue, `unknown date kind ${JSON.stringify(value.kind)}`)
  }
  const existing = getProperty(component, upper)
  if (existing && splitList(existing.value).length > 1) {
    return fail(IcalErrorCode.InvalidValue, `${upper} holds a list; writeDate writes one value`)
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.date)
  if (!dateMatch || !validDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))) {
    return fail(IcalErrorCode.InvalidValue, `invalid date ${JSON.stringify(value.date)}`)
  }
  const isDate = value.kind === IcalDateKind.Date
  const timeMatch = isDate
    ? null
    : /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)$/.exec(value.time ?? "")
  if (!isDate && !timeMatch) {
    return fail(IcalErrorCode.InvalidValue, `invalid time ${JSON.stringify(value.time)}`)
  }
  if (UTC_ONLY.has(upper) && value.kind !== IcalDateKind.Utc) {
    return fail(IcalErrorCode.InvalidValue, `${upper} must be a UTC date-time`)
  }
  if (upper === "CREATED" && getProperty(component, upper)) {
    return fail(IcalErrorCode.InvalidValue, "CREATED is set once and never rewritten")
  }
  for (const partner of PAIRED[upper] ?? []) {
    const other = getProperty(component, partner)
    const otherValue = other && readDate(other)
    if (otherValue && (otherValue.kind === IcalDateKind.Date) !== isDate) {
      return fail(
        IcalErrorCode.ValueTypeMismatch,
        `${upper} and ${partner} must both be dates or both be date-times`,
      )
    }
  }
  if (value.kind === IcalDateKind.Zoned) {
    if (!value.tzid || !options.root || !hasTimezone(options.root, value.tzid)) {
      return fail(IcalErrorCode.UnknownTzid, `no VTIMEZONE defines ${JSON.stringify(value.tzid)}`)
    }
  }

  const keep = (existing?.params ?? []).filter((param) =>
    param.name !== "VALUE" && param.name !== "TZID"
  )
  const params: IcalParameter[] = isDate
    ? [{ name: "VALUE", values: ["DATE"] }, ...keep]
    : value.kind === IcalDateKind.Zoned
    ? [{ name: "TZID", values: [value.tzid!] }, ...keep]
    : keep
  const digits = value.date.replaceAll("-", "") +
    (isDate
      ? ""
      : `T${value.time!.replaceAll(":", "")}${value.kind === IcalDateKind.Utc ? "Z" : ""}`)
  return ok(setProperty(component, upper, digits, params))
}

/** Options for {@link resolveInstant}. */
export interface IcalResolveOptions {
  /** IANA zone used for floating times and for dates (read as midnight). */
  zone?: string
}

/**
 * The instant a date value denotes, or `undefined` when it has none.
 *
 * UTC values resolve directly. A zoned value resolves only when its TZID is an IANA zone this
 * runtime knows; a vendor TZID such as `W. Europe Standard Time` is unresolved, never guessed.
 * Floating times and dates resolve only with `options.zone`. Wall clocks skipped or repeated by
 * a clock change resolve as `time/tz`'s `zonedDateTime` does.
 */
export function resolveInstant(
  value: IcalDateValue,
  options: IcalResolveOptions = {},
): Date | undefined {
  const [hhmm, seconds] = value.time
    ? [value.time.slice(0, 5), Number(value.time.slice(6, 8))]
    : ["00:00", 0]
  if (value.kind === IcalDateKind.Utc) {
    const instant = new Date(`${value.date}T${value.time}Z`)
    return Number.isNaN(instant.getTime()) ? undefined : instant
  }
  const zone = value.kind === IcalDateKind.Zoned ? value.tzid : options.zone
  if (!zone || !isValidTimeZone(zone)) return undefined
  try {
    return new Date(zonedDateTime(value.date, hhmm, zone).getTime() + seconds * 1000)
  } catch {
    return undefined
  }
}
