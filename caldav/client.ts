/**
 * A CalDAV client: find the user's calendars, list and fetch their tasks and events, and create,
 * update and delete them without overwriting a change made elsewhere.
 *
 * Every method returns `{ success, output, error }` and never throws for a server or network
 * failure; the error carries a {@link CalDavErrorCode}. Safety rules the client holds:
 *
 * - **Credentials stay on the server.** `Authorization` is attached only to a request whose origin
 *   equals the configured server's, and an `http:` server is refused unless `allowHttp` is set, so
 *   the password never travels unencrypted by accident. A URL argument or a server href on another origin is refused
 *   before any request, and a redirect to another origin is reported, never followed.
 * - **No blind writes.** A new object is sent with `If-None-Match: *`; an update or delete needs
 *   the etag it was read with, sent exactly as received, and is refused without one.
 * - **Bounded.** One `timeoutMs` covers a whole call, redirects and body reads included, and no
 *   response body is read past `maxResponseBytes`.
 *
 * Runs on the server and in a browser: pass the platform `fetch` or a wrapper as `fetch`. A browser
 * hides redirect targets from script, so a redirect there fails with `CalDavErrorCode.Server`.
 *
 * @module
 */

import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  calendarMultigetBody,
  calendarQueryBody,
  CALENDARSERVER_NS,
  childElements,
  DAV_NS,
  type DavResponse,
  DEFAULT_MAX_XML_BYTES,
  getProp,
  getPropText,
  mkcalendarBody,
  parseMultistatus,
  parseXml,
  propfindBody,
  proppatchBody,
  textContent,
  type XmlElement,
  type XmlName,
} from "./xml.ts"
import { isSafeEntityId } from "./_entity-id.ts"
import { childUrl, isSameOrigin, resolveHref, sameResource } from "./url.ts"
import {
  BodyReadTimeoutError,
  PayloadTooLargeError,
  readBoundedText,
} from "@spy4x/net/bounded-body"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import { encodeBase64 } from "@std/encoding"

/** Why a call failed. A code is stable; the message is for logs. */
export enum CalDavErrorCode {
  /**
   * The object changed on the server since it was read: an `If-Match` precondition failed (412)
   * on an update or delete. Fetch the object again, re-apply the edit and retry.
   */
  Conflict = 1,
  /** The address names nothing (404 or 410), or the server lacks a resource discovery needs. */
  NotFound,
  /** The server refused the credentials (401). */
  Unauthorized,
  /** The credentials are valid but the server forbids this (403). */
  Forbidden,
  /** The server redirected to another origin; `error.target` names it and nothing was sent. */
  CrossOriginRedirect,
  /** A URL argument, or an href the server sent, is not on the server's origin. Nothing was sent. */
  OutsideServer,
  /** A new object's address is already taken: the `If-None-Match: *` precondition failed. */
  AlreadyExists,
  /**
   * The server refused the write because another object of the calendar has the same UID, or
   * because the write changes the object's UID (RFC 4791 `no-uid-conflict`). Retrying will not help.
   */
  UidConflict,
  /** The call was refused before any request: a missing etag, an empty body, a bad header value. */
  InvalidArgument,
  /** The response is larger than `maxResponseBytes`, or the server refused a request as too large. */
  TooLarge,
  /** The response is not the WebDAV or CalDAV shape the call expects. */
  Malformed,
  /** The request did not reach the server, or the connection broke. */
  Network,
  /** The call took longer than `timeoutMs`. */
  Timeout,
  /** More same-origin redirects than `maxRedirects`. */
  TooManyRedirects,
  /** Any other unexpected status, such as a 5xx; `error.status` has it. */
  Server,
}

/** A failed call: the code to branch on, a message for logs and, when there was one, the status. */
export interface CalDavError {
  code: CalDavErrorCode
  message: string
  /** The HTTP status that caused the failure, when a response caused it. */
  status?: number
  /** The redirect target of a {@link CalDavErrorCode.CrossOriginRedirect}, never requested. */
  target?: string
  /** The condition a `DAV:error` body named, such as `valid-calendar-data`. */
  condition?: string
}

/** The outcome of a call: the value, or why it failed. */
export type CalDavResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: CalDavError }

/** Options of {@link createCalDavClient}. */
export interface CalDavClientOptions {
  /**
   * Where the server is: the bare host (`https://dav.example.com`) or a CalDAV address on it
   * (`https://dav.example.com/dav/cal/`). Its origin is the only one that receives credentials.
   * An `http:` address is refused unless {@link CalDavClientOptions.allowHttp} is `true`.
   */
  serverUrl: string | URL
  /**
   * When `true`, an `http:` `serverUrl` is accepted and the password travels unencrypted. Set it
   * only when nobody else can read the path to the server, such as a container network or
   * `localhost`. Default: `false`.
   */
  allowHttp?: boolean
  /** HTTP Basic credentials. The username may not contain `:` (RFC 7617). */
  auth: { username: string; password: string }
  /** The `fetch` to use. Default: the global `fetch`. */
  fetch?: typeof fetch
  /** Largest response body read, in bytes. Default: 10 MiB. */
  maxResponseBytes?: number
  /** Time budget of one whole call, redirects and body reads included, in ms. Default: 30 000. */
  timeoutMs?: number
  /** Same-origin redirects followed per request. Default: 5. */
  maxRedirects?: number
}

/** Where the user's calendars live, found by {@link CalDavClient.discover}. */
export interface CalDavDiscovery {
  /** The user's principal URL. */
  principalUrl: string
  /** Each calendar home of the user: pass one to `listCalendars` or `makeCalendar`. */
  homeUrls: string[]
}

/** A calendar collection. */
export interface CalDavCalendar {
  /** Absolute URL, with the server's percent-encoding kept. */
  url: string
  /** The display name, or the decoded last path segment when the server sends none. */
  displayName: string
  /**
   * Component names the calendar accepts, such as `["VTODO"]`. Empty when the server does not say,
   * which per RFC 4791 means it accepts any.
   */
  components: string[]
  /** Apple's `calendar-color`, such as `#3366FFFF`, when set. */
  color?: string
  /** The CalendarServer `getctag`: unchanged ctag, unchanged calendar. */
  ctag?: string
  /** The WebDAV `sync-token` (RFC 6578): unchanged token, unchanged calendar. */
  syncToken?: string
}

/** One calendar object resource: an iCalendar document and the etag it was read with. */
export interface CalDavObject {
  /** Absolute URL, with the server's percent-encoding kept. Never derived from the UID. */
  url: string
  /**
   * The etag exactly as the server sent it (quotes and `W/` included). `null` when it sent none, or
   * sent something other than one quoted entity tag (`*`, a list, an unquoted value).
   */
  etag: string | null
  /** The iCalendar text as received. */
  data: string
}

/** The outcome of a write: where the object is and its new etag. */
export interface CalDavWrite {
  url: string
  /** The new etag, or `null` when the server did not send one (RFC 4791 §5.3.4). Read it again. */
  etag: string | null
}

/** Options of {@link CalDavClient.listObjects}. */
export interface ListObjectsOptions {
  /** The component to list, such as `VTODO` or `VEVENT`. */
  component: string
  /** Only objects overlapping this range. */
  timeRange?: { start?: Date; end?: Date }
  /**
   * For `VTODO` only: also list completed tasks, those with a `COMPLETED` property. Default:
   * `false`, so only open tasks are listed; a task store keeps completed tasks forever.
   */
  includeCompleted?: boolean
}

/** The outcome of {@link CalDavClient.getObjects}. */
export interface CalDavMultiget {
  objects: CalDavObject[]
  /** Requested URLs the server reported as missing. */
  missing: string[]
}

/** Properties of a new calendar. */
export interface NewCalendar {
  displayName: string
  /** Component names it accepts, such as `["VTODO"]`. */
  components: string[]
  /** A CSS colour such as `#3366ff`. */
  color?: string
}

/** Options of {@link CalDavClient.createObject}. */
export interface CreateObjectOptions {
  /**
   * The object's file name, such as `<uuid>.ics`: letters, digits, `.`, `_`, `~` and `-` only,
   * else the call fails with `InvalidArgument`. Never the display name. Default: a fresh UUID.
   */
  name?: string
}

/** A CalDAV client bound to one server and one user. See {@link createCalDavClient}. */
export interface CalDavClient {
  /** Find the principal and calendar homes: `.well-known/caldav`, the server URL, then the principal. */
  discover(): Promise<CalDavResult<CalDavDiscovery>>
  /** The calendar collections directly under a calendar home. */
  listCalendars(homeUrl: string | URL): Promise<CalDavResult<CalDavCalendar[]>>
  /**
   * The objects of a calendar matching a `calendar-query`. Fails, instead of leaving the object
   * out, when the server reports one with an error other than 404 or 410.
   */
  listObjects(
    calendarUrl: string | URL,
    options: ListObjectsOptions,
  ): Promise<CalDavResult<CalDavObject[]>>
  /** Several objects of one calendar in one `calendar-multiget`. */
  getObjects(
    calendarUrl: string | URL,
    urls: (string | URL)[],
  ): Promise<CalDavResult<CalDavMultiget>>
  /** One object. */
  getObject(url: string | URL): Promise<CalDavResult<CalDavObject>>
  /**
   * Add an object under a new random name, or under `options.name` when given; fails with
   * `AlreadyExists` rather than overwrite. A caller that may repeat the call (an offline queue)
   * passes a stable name, so a repeat cannot create a second object.
   */
  createObject(
    calendarUrl: string | URL,
    ics: string,
    options?: CreateObjectOptions,
  ): Promise<CalDavResult<CalDavWrite>>
  /** Replace an object if it still has `etag`; a stale etag fails with `Conflict`. */
  updateObject(
    url: string | URL,
    ics: string,
    etag: string,
  ): Promise<CalDavResult<CalDavWrite>>
  /** Delete an object if it still has `etag`; a stale etag fails with `Conflict`. */
  deleteObject(url: string | URL, etag: string): Promise<CalDavResult<null>>
  /** Create a calendar under a calendar home, named by a random UUID. */
  makeCalendar(
    homeUrl: string | URL,
    calendar: NewCalendar,
  ): Promise<CalDavResult<{ url: string }>>
  /** Change a calendar's display name or colour. */
  updateCalendar(
    url: string | URL,
    changes: { displayName?: string; color?: string },
  ): Promise<CalDavResult<null>>
  /** Delete a calendar and everything in it. Refuses anything that is not a calendar collection. */
  deleteCalendar(url: string | URL): Promise<CalDavResult<null>>
  /**
   * What the signed-in user may do with a calendar or an object: the names of the `DAV:`
   * privileges in its `current-user-privilege-set` (RFC 3744), such as `read`, `write`,
   * `write-content`, `bind` and `unbind`. `null` when the server does not give the property. One
   * `PROPFIND` of depth 0. The client {@link createCalDavClient} returns always has it; it is
   * optional so that a hand-written stand-in for the client stays valid.
   */
  getPrivileges?(url: string | URL): Promise<CalDavResult<string[] | null>>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ICS_TYPE = "text/calendar; charset=utf-8"
const XML_TYPE = "application/xml; charset=utf-8"

const PRINCIPAL_PROPS: XmlName[] = [{ namespace: DAV_NS, name: "current-user-principal" }]
const HOME_PROPS: XmlName[] = [{ namespace: CALDAV_NS, name: "calendar-home-set" }]
const PRIVILEGE_PROPS: XmlName[] = [{ namespace: DAV_NS, name: "current-user-privilege-set" }]
const RESOURCE_TYPE_PROPS: XmlName[] = [{ namespace: DAV_NS, name: "resourcetype" }]
const CALENDAR_PROPS: XmlName[] = [
  { namespace: DAV_NS, name: "resourcetype" },
  { namespace: DAV_NS, name: "displayname" },
  { namespace: CALDAV_NS, name: "supported-calendar-component-set" },
  { namespace: APPLE_ICAL_NS, name: "calendar-color" },
  { namespace: CALENDARSERVER_NS, name: "getctag" },
  { namespace: DAV_NS, name: "sync-token" },
]

/** A failure raised inside a call and turned into its result at the call's edge. */
class CallFailure extends Error {
  constructor(readonly error: CalDavError) {
    super(error.message)
  }
}

/** One entity tag, strong or weak, quoted as RFC 9110 §8.8.3 requires: never `*` or a list. */
const ENTITY_TAG = /^(W\/)?"[^",]*"$/

/** The etag a server sent, when it is one valid entity tag; anything else reads as missing. */
function entityTag(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && ENTITY_TAG.test(trimmed) ? trimmed : null
}

/** True when a URL carries a username or password, which `fetch` would send as a second login. */
function hasUserInfo(url: URL): boolean {
  return url.username !== "" || url.password !== ""
}

/** Throw a `TypeError` unless `value` is absent or a positive integer. */
function requirePositiveInteger(value: number | undefined, name: string, allowZero = false) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`)
  }
}

function fail(code: CalDavErrorCode, message: string, extra: Partial<CalDavError> = {}): never {
  throw new CallFailure({ code, message, ...extra })
}

/** One request of a call. */
interface Exchange {
  method: string
  url: URL
  headers?: Record<string, string>
  body?: string
}

/** A response with its body read and the URL it finally came from. */
interface Reply {
  status: number
  url: URL
  headers: Headers
  text: string
}

/** What one call shares between its requests: the deadline. */
interface Call {
  signal: AbortSignal
  deadline: number
}

/** Message of the `TypeError` thrown for an `http:` `serverUrl` without `allowHttp: true`. */
const HTTP_REFUSED_MESSAGE =
  "serverUrl is an http: address, which would send the password unencrypted; " +
  "use https:, or set allowHttp: true to allow it"

/** A client's checked options, with the defaults filled in. */
interface Settings {
  server: URL
  authorization: string
  fetch: NonNullable<CalDavClientOptions["fetch"]>
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
}

/** Check a client's options before anything is sent; throws the `TypeError`s of the factory. */
function settingsOf(options: CalDavClientOptions): Settings {
  let server: URL
  try {
    server = new URL(options.serverUrl)
  } catch {
    throw new TypeError("serverUrl is not a valid URL")
  }
  if (server.protocol !== "http:" && server.protocol !== "https:") {
    throw new TypeError("serverUrl must be an http: or https: URL")
  }
  if (server.protocol === "http:" && options.allowHttp !== true) {
    throw new TypeError(HTTP_REFUSED_MESSAGE)
  }
  if (hasUserInfo(server)) {
    throw new TypeError("serverUrl must not carry credentials; pass them as auth")
  }
  if (options.auth.username.includes(":")) {
    throw new TypeError("a Basic auth username cannot contain ':'")
  }
  requirePositiveInteger(options.maxResponseBytes, "maxResponseBytes")
  requirePositiveInteger(options.timeoutMs, "timeoutMs")
  requirePositiveInteger(options.maxRedirects, "maxRedirects", true)
  return {
    server,
    authorization: `Basic ${encodeBase64(`${options.auth.username}:${options.auth.password}`)}`,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_XML_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
  }
}

/** Resolve a caller's URL argument; refuse one that is invalid or on another origin. */
function own(server: URL, value: string | URL, what: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(CalDavErrorCode.InvalidArgument, `${what} is not a valid URL`)
  }
  if (hasUserInfo(url)) {
    fail(CalDavErrorCode.InvalidArgument, `${what} must not carry credentials`)
  }
  if (!isSameOrigin(url, server)) {
    fail(CalDavErrorCode.OutsideServer, `${what} is not on the server's origin`)
  }
  return url
}

/** Resolve an href the server sent; refuse one that leaves the server's origin. */
function ownHref(server: URL, href: string, base: URL): URL {
  const url = resolveHref(href, base)
  if (url === null) fail(CalDavErrorCode.Malformed, "the server sent an invalid href")
  if (hasUserInfo(url)) {
    fail(CalDavErrorCode.Malformed, "the server sent an href with credentials")
  }
  if (!isSameOrigin(url, server)) {
    fail(CalDavErrorCode.OutsideServer, "the server sent an href on another origin")
  }
  return url
}

/** Reject when the call's deadline passes, so a stalled body read cannot outlive it. */
function beforeDeadline<T>(call: Call, work: Promise<T>): Promise<T> {
  if (call.signal.aborted) return Promise.reject(call.signal.reason)
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(call.signal.reason)
    call.signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([work, aborted]).finally(() =>
    call.signal.removeEventListener("abort", onAbort)
  )
}

/** Send one request, following same-origin redirects by hand, and read the body bounded. */
async function send(settings: Settings, call: Call, exchange: Exchange): Promise<Reply> {
  // Called without a receiver: the browser's own `fetch` throws "Illegal invocation" otherwise.
  const { server, maxBytes, timeoutMs, maxRedirects, fetch: doFetch } = settings
  let { method, url, body } = exchange
  for (let hop = 0;; hop++) {
    if (!isSameOrigin(url, server)) {
      fail(CalDavErrorCode.OutsideServer, "refusing a request outside the server's origin")
    }
    if (hasUserInfo(url)) fail(CalDavErrorCode.InvalidArgument, "refusing a URL with credentials")
    let headers: Headers
    try {
      headers = new Headers(exchange.headers)
    } catch {
      fail(CalDavErrorCode.InvalidArgument, "a header value is not valid")
    }
    // Checked again per hop: a redirect may only ever lead back to this same origin.
    if (isSameOrigin(url, server)) headers.set("Authorization", settings.authorization)
    let response: Response
    try {
      response = await beforeDeadline(
        call,
        doFetch(url.href, {
          method,
          headers,
          body,
          redirect: "manual",
          credentials: "omit",
          signal: call.signal,
        }),
      )
    } catch (cause) {
      if (cause instanceof CallFailure) throw cause
      if (call.signal.aborted) fail(CalDavErrorCode.Timeout, `no answer within ${timeoutMs} ms`)
      fail(CalDavErrorCode.Network, `the request failed: ${messageOf(cause)}`)
    }
    if (response.type === "opaqueredirect") {
      fail(CalDavErrorCode.Server, "the server redirected and the runtime hid the target")
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await discard(response)
      const location = response.headers.get("Location")
      const target = location === null ? null : resolveHref(location, url)
      if (target === null) {
        fail(CalDavErrorCode.Server, "a redirect without a valid Location", {
          status: response.status,
        })
      }
      if (hasUserInfo(target)) {
        fail(CalDavErrorCode.Server, "the server redirected to a URL with credentials", {
          status: response.status,
        })
      }
      if (!isSameOrigin(target, server)) {
        fail(CalDavErrorCode.CrossOriginRedirect, "the server redirected to another origin", {
          status: response.status,
          target: target.href,
        })
      }
      if (hop >= maxRedirects) {
        fail(CalDavErrorCode.TooManyRedirects, `more than ${maxRedirects} redirects`)
      }
      if (response.status === 303) {
        method = "GET"
        body = undefined
      }
      url = target
      continue
    }
    let text: string
    try {
      text = await beforeDeadline(
        call,
        readBoundedText(response, {
          maxBytes,
          timeoutMs: Math.max(1, call.deadline - Date.now()),
        }),
      )
    } catch (cause) {
      if (cause instanceof PayloadTooLargeError) {
        fail(CalDavErrorCode.TooLarge, `the response is over ${maxBytes} bytes`)
      }
      if (cause instanceof BodyReadTimeoutError || call.signal.aborted) {
        fail(CalDavErrorCode.Timeout, `no complete answer within ${timeoutMs} ms`)
      }
      fail(CalDavErrorCode.Network, `reading the response failed: ${messageOf(cause)}`)
    }
    return { status: response.status, url, headers: response.headers, text }
  }
}

/** Run one public call: one deadline for all its requests, failures turned into results. */
async function run<T>(
  timeoutMs: number,
  work: (call: Call) => Promise<T>,
): Promise<CalDavResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException("timed out", "TimeoutError")),
    timeoutMs,
  )
  try {
    const output = await work({ signal: controller.signal, deadline: Date.now() + timeoutMs })
    return { success: true, output, error: null }
  } catch (cause) {
    if (cause instanceof CallFailure) return { success: false, output: null, error: cause.error }
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

/** Send a PROPFIND and read its multistatus answer. */
async function propfind(
  settings: Settings,
  call: Call,
  url: URL,
  depth: "0" | "1",
  props: XmlName[],
) {
  const reply = await send(settings, call, {
    method: "PROPFIND",
    url,
    headers: { Depth: depth, "Content-Type": XML_TYPE },
    body: propfindBody(props),
  })
  return { reply, responses: multistatus(expectStatus(reply, [207]), settings.maxBytes) }
}

/** Send a REPORT of depth 1 and read its multistatus answer. */
async function report(settings: Settings, call: Call, url: URL, body: string) {
  const reply = await send(settings, call, {
    method: "REPORT",
    url,
    headers: { Depth: "1", "Content-Type": XML_TYPE },
    body,
  })
  return { reply, responses: multistatus(expectStatus(reply, [207]), settings.maxBytes) }
}

/**
 * Whether a `calendar-query` answer means "an existing calendar with no matching objects".
 *
 * Stalwart answers an empty calendar with 207 holding one response, the collection itself at
 * 404 ("No resources found"), and answers a calendar that does not exist the same way, so the
 * REPORT cannot tell them apart. A `PROPFIND` of depth 0 can: it gives 404 for an address that
 * names nothing, which fails with `NotFound`, and a `calendar` resource type for a calendar.
 * An answer with any other shape is left to {@link toObjects}.
 *
 * `base` is the address the answer came from. After a redirect it differs from `calendar`, the
 * address asked for, and the entry may name either.
 */
async function isEmptyCalendarAnswer(
  settings: Settings,
  call: Call,
  responses: DavResponse[],
  base: URL,
  calendar: URL,
): Promise<boolean> {
  const [only] = responses
  if (responses.length !== 1 || only.status === undefined || !isGone(only.status)) return false
  if (!isEither(ownHref(settings.server, only.href, base), calendar, base)) return false
  const probe = await propfind(settings, call, base, "0", RESOURCE_TYPE_PROPS)
  for (const response of probe.responses) {
    const url = ownHref(settings.server, response.href, probe.reply.url)
    if (!isEither(url, base, probe.reply.url)) continue
    failIfSelfFailed(response)
    if (isCalendar(response)) return true
  }
  fail(CalDavErrorCode.NotFound, "the address is not a calendar", { status: 404 })
}

/**
 * Turn calendar-data responses into objects; refuse a foreign href or a missing body. An entry
 * for the collection itself, under the address asked for or the one the answer came from
 * (`base`), fails the call when it is an error. `failed` is the status of the first other entry
 * the server reported as an error that does not mean "gone".
 */
function toObjects(server: URL, responses: DavResponse[], base: URL, collection: URL) {
  const objects: CalDavObject[] = []
  const missing: string[] = []
  let failed: number | undefined
  for (const response of responses) {
    const url = ownHref(server, response.href, base)
    if (isEither(url, collection, base)) {
      failIfSelfFailed(response)
      continue
    }
    if (response.status !== undefined && response.status >= 400) {
      if (!isGone(response.status)) failed ??= response.status
      for (const href of response.hrefs) missing.push(ownHref(server, href, base).href)
      continue
    }
    const data = getPropText(response, CALDAV_NS, "calendar-data")
    if (data === undefined) {
      fail(CalDavErrorCode.Malformed, "a calendar object came without calendar-data")
    }
    // Whitespace around the element text is XML formatting, not part of the etag.
    const etag = entityTag(getPropText(response, DAV_NS, "getetag"))
    objects.push({ url: url.href, etag, data })
  }
  return { objects, missing, failed }
}

/** Validate an etag before it is sent: present, and sendable as a header exactly as given. */
function requireEtag(etag: unknown): string {
  if (typeof etag !== "string" || etag.trim() === "") {
    fail(CalDavErrorCode.InvalidArgument, "an etag is required; read the object first")
  }
  // One quoted entity tag, as read: `*` would match any version and a list any of several, so
  // either would turn a guarded write into a blind one.
  if (!ENTITY_TAG.test(etag)) {
    fail(CalDavErrorCode.InvalidArgument, "the etag must be one quoted entity tag, as read")
  }
  try {
    new Headers({ "If-Match": etag })
  } catch {
    fail(CalDavErrorCode.InvalidArgument, "the etag cannot be sent as a header")
  }
  return etag
}

function requireIcs(ics: unknown): string {
  if (typeof ics !== "string" || ics.trim() === "") {
    fail(CalDavErrorCode.InvalidArgument, "the iCalendar text is empty")
  }
  return ics
}

/** Refuse a `createObject` name that is not a plain file name. */
function requireName(name: string): string {
  if (isSafeEntityId(name)) return name
  if (name === "." || name === "..") {
    fail(CalDavErrorCode.InvalidArgument, "name cannot be . or ..")
  }
  fail(CalDavErrorCode.InvalidArgument, "name must be letters, digits, . _ ~ and -")
}

/** Build a request body from a caller's arguments; a refused argument is `InvalidArgument`. */
function bodyFrom(build: () => string): string {
  try {
    return build()
  } catch (cause) {
    fail(CalDavErrorCode.InvalidArgument, messageOf(cause))
  }
}

/** PROPFIND the principal from one starting point; fails when it does not answer as CalDAV. */
async function principalFrom(settings: Settings, call: Call, start: URL): Promise<URL> {
  const { reply, responses } = await propfind(settings, call, start, "0", PRINCIPAL_PROPS)
  for (const response of responses) {
    const prop = getProp(response, DAV_NS, "current-user-principal")
    const href = prop && childElements(prop, DAV_NS, "href")[0]
    if (href) return ownHref(settings.server, textOf(href), reply.url)
  }
  fail(CalDavErrorCode.NotFound, "the server named no current-user-principal")
}

/** Find the principal, from the server URL or `/.well-known/caldav`, and its calendar homes. */
async function discover(settings: Settings, call: Call): Promise<CalDavDiscovery> {
  const { server } = settings
  const wellKnown = new URL("/.well-known/caldav", server)
  const starts = server.pathname === "/" ? [wellKnown, server] : [server, wellKnown]
  let principal: URL | undefined
  let firstError: CalDavError | undefined
  for (const start of starts) {
    try {
      principal = await principalFrom(settings, call, start)
      break
    } catch (cause) {
      if (!(cause instanceof CallFailure)) throw cause
      const code = cause.error.code
      // Wrong credentials or a spent budget fail the same way from every starting point.
      if (code === CalDavErrorCode.Unauthorized || code === CalDavErrorCode.Timeout) {
        throw cause
      }
      if (firstError === undefined || code === CalDavErrorCode.CrossOriginRedirect) {
        firstError = cause.error
      }
    }
  }
  if (principal === undefined) throw new CallFailure(firstError!)
  const { reply, responses } = await propfind(settings, call, principal, "0", HOME_PROPS)
  const homeUrls: string[] = []
  for (const response of responses) {
    const prop = getProp(response, CALDAV_NS, "calendar-home-set")
    if (prop === undefined) continue
    for (const href of childElements(prop, DAV_NS, "href")) {
      homeUrls.push(ownHref(server, textOf(href), reply.url).href)
    }
  }
  if (homeUrls.length === 0) {
    fail(CalDavErrorCode.NotFound, "the principal names no calendar-home-set")
  }
  return { principalUrl: principal.href, homeUrls }
}

/** The calendar a PROPFIND response describes, at `url`. */
function calendarOf(response: DavResponse, url: URL): CalDavCalendar {
  const components = getProp(response, CALDAV_NS, "supported-calendar-component-set")
  const calendar: CalDavCalendar = {
    url: url.href,
    displayName: getPropText(response, DAV_NS, "displayname")?.trim() || lastSegment(url),
    components: components === undefined ? [] : childElements(components, CALDAV_NS, "comp")
      .map((comp) => comp.attributes.find((a) => a.name === "name")?.value ?? "")
      .filter((name) => name !== ""),
  }
  const color = getPropText(response, APPLE_ICAL_NS, "calendar-color")?.trim()
  if (color) calendar.color = color
  const ctag = getPropText(response, CALENDARSERVER_NS, "getctag")?.trim()
  if (ctag) calendar.ctag = ctag
  const syncToken = getPropText(response, DAV_NS, "sync-token")?.trim()
  if (syncToken) calendar.syncToken = syncToken
  return calendar
}

/** The calendars in one calendar home. */
async function listCalendars(settings: Settings, call: Call, home: URL): Promise<CalDavCalendar[]> {
  const { reply, responses } = await propfind(settings, call, home, "1", CALENDAR_PROPS)
  const calendars: CalDavCalendar[] = []
  for (const response of responses) {
    const url = ownHref(settings.server, response.href, reply.url)
    if (isEither(url, home, reply.url)) failIfSelfFailed(response)
    if (isCalendar(response)) calendars.push(calendarOf(response, url))
  }
  return calendars
}

/** The objects of one calendar that match the listing options. */
async function listObjects(
  settings: Settings,
  call: Call,
  calendar: URL,
  listOptions: ListObjectsOptions,
): Promise<CalDavObject[]> {
  const openOnly = listOptions.component.toUpperCase() === "VTODO" &&
    listOptions.includeCompleted !== true
  const body = bodyFrom(() =>
    calendarQueryBody({
      component: listOptions.component,
      timeRange: listOptions.timeRange,
      withoutProperties: openOnly ? ["COMPLETED"] : [],
    })
  )
  const { reply, responses } = await report(settings, call, calendar, body)
  if (await isEmptyCalendarAnswer(settings, call, responses, reply.url, calendar)) return []
  const listed = toObjects(settings.server, responses, reply.url, calendar)
  // A stored copy of an object the server could not read must not look deleted.
  if (listed.failed !== undefined) {
    failForStatus(listed.failed, "the server reported an error for an object of the listing")
  }
  return listed.objects
}

/** Fail when a PROPPATCH multistatus refuses any property. */
function failIfPropertyRefused(responses: DavResponse[]): void {
  for (const response of responses) {
    for (const propstat of response.propstats) {
      if (propstat.status < 200 || propstat.status > 299) {
        failForStatus(propstat.status, "the server refused a calendar property")
      }
    }
  }
}

/** The response that describes `target` itself, among a PROPFIND's answers. */
function selfOf(server: URL, responses: DavResponse[], target: URL): DavResponse | undefined {
  return responses.find((response) => sameResource(ownHref(server, response.href, target), target))
}

/** The names of the `DAV:` privileges in a `current-user-privilege-set`. */
function privilegeNames(set: XmlElement): string[] {
  return childElements(set, DAV_NS, "privilege").flatMap((privilege) =>
    privilege.children.flatMap((child) =>
      typeof child !== "string" && child.namespace === DAV_NS ? [child.name] : []
    )
  )
}

/**
 * Create a client for one CalDAV server and one user.
 *
 * Throws a `TypeError` when `serverUrl` is not an `http:` or `https:` URL, when it is `http:` and
 * `allowHttp` is not `true`, or when the username contains `:`. Nothing is sent before that check.
 * Every other failure is returned, never thrown.
 */
export function createCalDavClient(options: CalDavClientOptions): CalDavClient {
  const settings = settingsOf(options)
  const { server, maxBytes } = settings
  const call = <T>(work: (call: Call) => Promise<T>) => run(settings.timeoutMs, work)
  const put = async (call: Call, target: URL, headers: Record<string, string>, body: string) =>
    await send(settings, call, {
      method: "PUT",
      url: target,
      headers: { "Content-Type": ICS_TYPE, ...headers },
      body,
    })

  return {
    discover: () => call((c) => discover(settings, c)),

    listCalendars: (homeUrl) =>
      call((c) => listCalendars(settings, c, own(server, homeUrl, "homeUrl"))),

    listObjects: (calendarUrl, listOptions) =>
      call((c) => listObjects(settings, c, own(server, calendarUrl, "calendarUrl"), listOptions)),

    getObjects: (calendarUrl, urls) =>
      call(async (c) => {
        const calendar = own(server, calendarUrl, "calendarUrl")
        const targets = urls.map((url) => own(server, url, "an object URL"))
        if (targets.length === 0) return { objects: [], missing: [] }
        const body = calendarMultigetBody(targets.map((url) => `${url.pathname}${url.search}`))
        const { reply, responses } = await report(settings, c, calendar, body)
        const { objects, missing } = toObjects(server, responses, reply.url, calendar)
        return { objects, missing }
      }),

    getObject: (url) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const reply = expectStatus(
          await send(settings, c, {
            method: "GET",
            url: target,
            headers: { Accept: "text/calendar" },
          }),
          [200],
        )
        return { url: reply.url.href, etag: entityTag(reply.headers.get("ETag")), data: reply.text }
      }),

    createObject: (calendarUrl, ics, createOptions) =>
      call(async (c) => {
        const calendar = own(server, calendarUrl, "calendarUrl")
        const body = requireIcs(ics)
        const name = createOptions?.name
        if (name !== undefined) requireName(name)
        // A fresh name, never the UID: Tasks.org and DAVx5 name resources unlike their UIDs.
        const target = childUrl(calendar, name ?? `${uuidV7()}.ics`)
        const reply = await put(c, target, { "If-None-Match": "*" }, body)
        expectStatus(reply, [200, 201, 204], CalDavErrorCode.AlreadyExists)
        return { url: reply.url.href, etag: entityTag(reply.headers.get("ETag")) }
      }),

    updateObject: (url, ics, etag) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const ifMatch = requireEtag(etag)
        const body = requireIcs(ics)
        const reply = await put(c, target, { "If-Match": ifMatch }, body)
        expectStatus(reply, [200, 201, 204], CalDavErrorCode.Conflict)
        return { url: reply.url.href, etag: entityTag(reply.headers.get("ETag")) }
      }),

    deleteObject: (url, etag) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const ifMatch = requireEtag(etag)
        const reply = await send(settings, c, {
          method: "DELETE",
          url: target,
          headers: { "If-Match": ifMatch },
        })
        expectStatus(reply, [200, 204], CalDavErrorCode.Conflict)
        return null
      }),

    makeCalendar: (homeUrl, calendar) =>
      call(async (c) => {
        const home = own(server, homeUrl, "homeUrl")
        const target = childUrl(home, uuidV7())
        target.pathname += "/"
        const body = bodyFrom(() => mkcalendarBody(calendar))
        const reply = await send(settings, c, {
          method: "MKCALENDAR",
          url: target,
          headers: { "Content-Type": XML_TYPE },
          body,
        })
        expectStatus(reply, [200, 201])
        return { url: target.href }
      }),

    updateCalendar: (url, changes) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const body = bodyFrom(() => proppatchBody(changes))
        const reply = await send(settings, c, {
          method: "PROPPATCH",
          url: target,
          headers: { "Content-Type": XML_TYPE },
          body,
        })
        if (reply.status === 200 || reply.status === 204) return null
        failIfPropertyRefused(multistatus(expectStatus(reply, [207]), maxBytes))
        return null
      }),

    deleteCalendar: (url) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const { responses } = await propfind(settings, c, target, "0", [CALENDAR_PROPS[0]])
        const self = selfOf(server, responses, target)
        if (self === undefined || !isCalendar(self)) {
          fail(CalDavErrorCode.InvalidArgument, "refusing to delete what is not a calendar")
        }
        expectStatus(await send(settings, c, { method: "DELETE", url: target }), [200, 204])
        return null
      }),

    getPrivileges: (url) =>
      call(async (c) => {
        const target = own(server, url, "url")
        const { responses } = await propfind(settings, c, target, "0", PRIVILEGE_PROPS)
        const self = selfOf(server, responses, target)
        const set = self && getProp(self, DAV_NS, "current-user-privilege-set")
        return set === undefined ? null : privilegeNames(set)
      }),
  }
}

/** Whether a response's `resourcetype` marks a CalDAV calendar collection. */
function isCalendar(response: DavResponse): boolean {
  const type = getProp(response, DAV_NS, "resourcetype")
  return type !== undefined && childElements(type, CALDAV_NS, "calendar").length > 0
}

function textOf(element: XmlElement): string {
  return textContent(element).trim()
}

function lastSegment(url: URL): string {
  const segments = url.pathname.split("/").filter((segment) => segment !== "")
  const last = segments.at(-1) ?? ""
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function multistatus(reply: Reply, maxBytes: number): DavResponse[] {
  const parsed = parseMultistatus(reply.text, { maxBytes })
  if (!parsed.success) {
    fail(
      CalDavErrorCode.Malformed,
      `the server sent an unreadable multistatus: ${parsed.error.message}`,
    )
  }
  return parsed.output
}

/**
 * Return the reply when its status is expected; otherwise fail with the code its status and any
 * `DAV:error` body mean. `on412` is the code of a failed `If-Match` or `If-None-Match` precondition;
 * a 412 that names `no-uid-conflict` is a {@link CalDavErrorCode.UidConflict} instead, because
 * Stalwart answers a UID clash with the same status as a stale etag.
 */
function expectStatus(reply: Reply, expected: number[], on412?: CalDavErrorCode): Reply {
  if (expected.includes(reply.status)) return reply
  const status = reply.status
  const condition = davCondition(reply.text)
  const extra: Partial<CalDavError> = condition === undefined
    ? { status }
    : { status, condition: condition.name }
  if (condition?.namespace === CALDAV_NS && condition.name === "no-uid-conflict") {
    fail(CalDavErrorCode.UidConflict, "another object has this UID, or the UID changed", extra)
  }
  if (status === 412 && on412 === CalDavErrorCode.Conflict) {
    fail(on412, "the object changed since it was read", extra)
  }
  if (status === 412 && on412 === CalDavErrorCode.AlreadyExists) {
    fail(on412, "an object already has this address", extra)
  }
  failForStatus(status, `unexpected status ${status}`, extra)
}

/** The first condition element of a `DAV:error` body (RFC 4918 §16), if the body is one. */
function davCondition(text: string): XmlName | undefined {
  if (!text.trimStart().startsWith("<")) return undefined
  const parsed = parseXml(text)
  if (!parsed.success) return undefined
  const root = parsed.output
  if (root.namespace !== DAV_NS || root.name !== "error") return undefined
  const first = root.children.find((child): child is XmlElement => typeof child !== "string")
  return first === undefined ? undefined : { namespace: first.namespace, name: first.name }
}

/**
 * Fail when a multistatus reports an error for the collection that was asked about: a server may
 * answer 207 with only that entry at 404, which must not read as an empty collection.
 */
function failIfSelfFailed(response: DavResponse): void {
  if (response.status !== undefined && response.status >= 400) {
    failForStatus(response.status, "the collection itself answered with an error")
  }
}

/** Whether `url` is the resource asked for or the one a redirect led to. */
function isEither(url: URL, asked: URL, answered: URL): boolean {
  return sameResource(url, asked) || sameResource(url, answered)
}

function isGone(status: number): boolean {
  return status === 404 || status === 410
}

function failForStatus(status: number, message: string, extra: Partial<CalDavError> = {}): never {
  const details = { status, ...extra }
  switch (status) {
    case 401:
      fail(CalDavErrorCode.Unauthorized, "the server refused the credentials", details)
      break
    case 403:
      fail(CalDavErrorCode.Forbidden, "the server forbids this", details)
      break
    case 404:
    case 410:
      fail(CalDavErrorCode.NotFound, "nothing at this address", details)
      break
    case 413:
      fail(CalDavErrorCode.TooLarge, "the server refused the request as too large", details)
  }
  fail(CalDavErrorCode.Server, message, details)
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Best effort: the body of a redirect is never read.
  }
}
