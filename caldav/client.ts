/**
 * Fetch-based CalDAV client.
 *
 * Ported from `caldav-mcp/caldav/client.ts` (issue #13). Deviations from the
 * source, all deliberate:
 *
 *  - the transport is **injected**, not the module-scope global `fetch`, so a
 *    test can drive every branch with no network and no `--allow-net`. The
 *    source called `fetch` directly, which is why it arrived untested.
 *  - credentials come from an options object, never from `env.ts` at module
 *    scope, so the client is constructible anywhere — including a test that
 *    must not read the host's environment.
 *  - **every** operation returns a `CalDavResult` envelope. The source threw
 *    from some operations and returned `""` from others, so a transport failure
 *    and an empty answer were the same value.
 *  - the duplicated `extractTagFlex`/`extractTagSimple` and
 *    `resolveUrl`/`resolveUrlFlex` pairs collapsed into `xml.ts`'s
 *    `extractElementText` and `resolveUrl`; the old names are gone, not aliased.
 *  - the Radicale fallback is reported: it is a warning on a success, or the
 *    underlying failure inside the error, never a silent substitution.
 *
 * The `{username}/` fallback exists because a CalDAV server may not advertise
 * `calendar-home-set` on its root at all — Radicale answers the PROPFIND with
 * the property's *absence* (a `404` `propstat`, still an HTTP 207), so the
 * correct trigger is "no `calendar-home-set` in the body", and the fallback is
 * the documented `/username/` convention. A server that returns a non-2xx status
 * for the discovery request is a different case and is also retried, because a
 * proxy in front of a correctly configured server produces it.
 */

import { parseIcal } from "./ical.ts"
import {
  CalDavErrorCode,
  type CalDavFailure,
  type CalDavResult,
  type Calendar,
  ComponentType,
  fail,
  ok,
  partial,
  reshapeFailure,
} from "./types.ts"
import {
  type EventReportFilters,
  extractElementText,
  mkcalendar,
  parseCalendarPropfind,
  propfindCalendarHomeSet,
  propfindCalendars,
  proppatchCalendar,
  type ProppatchOptions,
  readReportResources,
  reportEvents,
  reportTodos,
  resolveUrl,
  type TodoReportFilters,
} from "./xml.ts"

/** Anything `fetch`-shaped. Injected so this package never opens a socket in a test. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Everything the client needs that it must not read from the environment. */
export interface CalDavClientOptions {
  /** Server root, e.g. `https://caldav.example.com/`. Trailing slashes are normalised. */
  baseUrl: string
  /** Basic-auth username. */
  username: string
  /** Basic-auth password. */
  password: string
  /** Transport. Defaults to the global `fetch`; tests pass a stub. */
  fetch?: FetchLike
  /** `PRODID` written by this client's builders; defaults to the builder's own. */
  prodid?: string
  /**
   * Clock used for builder timestamps. Injected so a test gets byte-identical
   * documents; defaults to `new Date()`.
   */
  now?: Date | (() => Date)
}

/** One raw multi-status body plus what the request had to do to obtain it. */
export interface CalendarListing {
  /** Calendars found, in server order. */
  calendars: Calendar[]
  /** Warnings from the PROPFIND parse. */
  warnings: string[]
}

/** A single resource fetched with `GET`. */
export interface IcalResource {
  /** The iCalendar text, XML entities already decoded. */
  data: string
  /** `ETag` response header, empty when the server sent none. */
  etag: string
}

/** Outcome of one `PUT`. */
export interface PutResult {
  /** Absolute URL the resource was written to. */
  url: string
  /** New `ETag` from the response, empty when the server sent none. */
  etag: string
}

/** Outcome of `MKCALENDAR`. */
export interface MakeCalendarResult {
  /** URL of the created collection. */
  url: string
}

/**
 * Turn a non-2xx response into a structured failure.
 *
 * `401` and `403` collapse into one code because WebDAV servers answer a bad
 * Basic credential with either, and a caller can do nothing different about the
 * two; `412` gets its own code because it is the one status a caller *can* act
 * on, by refetching the resource and retrying with the fresh ETag.
 */
export function httpError(
  operation: string,
  url: string,
  response: Response,
): CalDavFailure<never> {
  const message = `${operation} failed: ${response.status} ${response.statusText}`.trim()
  if (response.status === 401 || response.status === 403) {
    return fail(CalDavErrorCode.UNAUTHORIZED, message, { status: response.status, url })
  }
  if (response.status === 404 || response.status === 410) {
    return fail(CalDavErrorCode.NOT_FOUND, message, { status: response.status, url })
  }
  if (response.status === 412) {
    return fail(CalDavErrorCode.PRECONDITION_FAILED, message, { status: response.status, url })
  }
  return fail(CalDavErrorCode.HTTP_STATUS, message, { status: response.status, url })
}

/** Turn a rejected `fetch` into a structured failure, never leaking the cause's stack. */
export function transportError(
  operation: string,
  url: string,
  cause: unknown,
): CalDavFailure<never> {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return fail(CalDavErrorCode.TRANSPORT, `${operation} failed: ${detail}`, { url })
}

/** Request headers for a CalDAV XML call. */
interface XmlRequestOptions {
  /** HTTP method, e.g. `PROPFIND`. */
  method: string
  /** Absolute request URL. */
  url: string
  /** XML body. */
  body: string
  /** `Depth` header value. */
  depth?: string
}

/** A CalDAV client over an injected transport. */
export class CalDavClient {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private readonly transport: FetchLike
  private readonly prodid: string | undefined
  private readonly clock: () => Date

  constructor(options: CalDavClientOptions) {
    if (options.baseUrl.trim() === "") throw new TypeError("options.baseUrl is required")
    // Validated here rather than at first use: a bad base URL would otherwise
    // surface as a transport error on every call, indistinguishable from a
    // server that is down.
    this.baseUrl = new URL(options.baseUrl).toString().replace(/\/+$/, "")
    this.username = options.username
    this.password = options.password
    this.transport = options.fetch ?? ((input, init) => fetch(input, init))
    this.prodid = options.prodid
    const now = options.now
    this.clock = typeof now === "function" ? now : () => now ?? new Date()
  }

  /** Server root this client was built for, without a trailing slash. */
  get rootUrl(): string {
    return this.baseUrl
  }

  /** Username the client authenticates as. */
  get user(): string {
    return this.username
  }

  /**
   * The `Authorization` header value, or `undefined` when no username is set.
   *
   * Public so a caller that needs to make its own request (a `GET` on a resource
   * URL, say) can reuse the credential without reaching into a private field.
   * The source's `QueryEngine` read `this.client["username"]` and
   * `this.client["password"]` through bracket syntax, which is exactly the
   * encapsulation hole this replaces.
   */
  authorizationHeader(): string | undefined {
    if (this.username === "") return undefined
    return `Basic ${btoa(`${this.username}:${this.password}`)}`
  }

  /** Auth plus the XML content type, as a fresh object per call. */
  private xmlHeaders(depth?: string): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/xml; charset=utf-8" }
    const authorization = this.authorizationHeader()
    if (authorization !== undefined) headers["Authorization"] = authorization
    if (depth !== undefined) headers["Depth"] = depth
    return headers
  }

  /** Absolute URL for a server-relative path, resolved against the root. */
  resolve(path: string): string {
    return resolveUrl(path, `${this.baseUrl}/`)
  }

  /** Perform one XML request and return the body, or a structured failure. */
  private async xmlRequest(
    operation: string,
    options: XmlRequestOptions,
  ): Promise<CalDavResult<string>> {
    let response: Response
    try {
      response = await this.transport(options.url, {
        method: options.method,
        headers: this.xmlHeaders(options.depth),
        body: options.body,
      })
    } catch (cause) {
      return transportError(operation, options.url, cause)
    }
    if (!response.ok) return httpError(operation, options.url, response)
    try {
      return ok(await response.text())
    } catch (cause) {
      return transportError(operation, options.url, cause)
    }
  }

  /** Perform one body-less request; `body` is read only when the caller wants it. */
  private async simpleRequest(
    operation: string,
    url: string,
    init: RequestInit,
  ): Promise<CalDavResult<Response>> {
    try {
      const response = await this.transport(url, init)
      if (!response.ok) return httpError(operation, url, response)
      return ok(response)
    } catch (cause) {
      return transportError(operation, url, cause)
    }
  }

  /** Headers for an iCalendar request, including `If-Match` when an ETag is known. */
  private icalHeaders(etag?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "text/calendar; charset=utf-8",
    }
    const authorization = this.authorizationHeader()
    if (authorization !== undefined) headers["Authorization"] = authorization
    if (etag !== undefined && etag !== "") headers["If-Match"] = etag
    return headers
  }

  /**
   * Discover the `calendar-home-set`, falling back to `/username/`.
   *
   * The fallback fires when the PROPFIND fails, when the transport rejects, or
   * when the body carries no `calendar-home-set`. The returned warnings say
   * which, so a caller never has to guess whether discovery actually worked —
   * the failure the source swallowed to produce its silent fallback is in the
   * warning text.
   */
  async discoverCalendarHomeSet(): Promise<CalDavResult<{ url: string; warnings: string[] }>> {
    const root = `${this.baseUrl}/`
    const body = propfindCalendarHomeSet()
    const warnings: string[] = []
    const attempt = await this.xmlRequest("PROPFIND calendar-home-set", {
      method: "PROPFIND",
      url: root,
      body,
      depth: "0",
    })

    if (!attempt.success) {
      warnings.push(
        `${attempt.error.message} for ${root}; using the /username/ convention instead`,
      )
    } else {
      const href = extractNestedHref(attempt.output)
      if (href !== undefined && href !== "") {
        try {
          return ok({ url: resolveUrl(href, root), warnings })
        } catch (cause) {
          warnings.push(`${String(cause)}; using the /username/ convention instead`)
        }
      } else {
        warnings.push(
          `${root} returned no calendar-home-set; using the /username/ convention instead`,
        )
      }
    }

    if (this.username === "") {
      return fail(
        CalDavErrorCode.INVALID_ARGUMENT,
        "no calendar-home-set and no username to build the /username/ fallback from",
        { url: root },
      )
    }
    return ok({ url: this.resolve(`${encodeURIComponent(this.username)}/`), warnings })
  }

  /**
   * List the calendar collections under the discovered home set.
   *
   * On a non-2xx PROPFIND against the home set, the request is retried once
   * against `/{username}/`, which is the shape a server that answered the
   * home-set PROPFIND from a proxy or a rewritten path needs.
   *
   * @returns a failure when the home set cannot be discovered or both attempts
   * fail; a success with an empty list when the server legitimately holds no
   * calendars.
   */
  async listCalendars(): Promise<CalDavResult<CalendarListing>> {
    const discovery = await this.discoverCalendarHomeSet()
    if (!discovery.success) return reshapeFailure(discovery)

    const body = propfindCalendars()
    const warnings = [...discovery.output.warnings]
    const first = await this.xmlRequest("PROPFIND calendars", {
      method: "PROPFIND",
      url: discovery.output.url,
      body,
      depth: "1",
    })

    let payload: CalDavResult<string> = first
    if (!first.success) {
      const fallbackUrl = this.resolve(`${encodeURIComponent(this.username)}/`)
      if (fallbackUrl !== discovery.output.url) {
        warnings.push(`${first.error.message}; retrying against ${fallbackUrl}`)
        payload = await this.xmlRequest("PROPFIND calendars", {
          method: "PROPFIND",
          url: fallbackUrl,
          body,
          depth: "1",
        })
      }
    }
    if (!payload.success) {
      return partial(payload.error, { calendars: [], warnings })
    }

    const parsed = parseCalendarPropfind(payload.output, `${this.baseUrl}/`)
    if (!parsed.success) {
      return partial(parsed.error, { calendars: [], warnings })
    }
    return ok(
      { calendars: parsed.output.calendars, warnings: [...warnings, ...parsed.output.warnings] },
      warnings,
    )
  }

  /** REPORT a `calendar-query` for `VTODO`; returns the raw multi-status body. */
  queryTodos(
    calendarUrl: string,
    filters: TodoReportFilters = {},
  ): Promise<CalDavResult<string>> {
    return this.xmlRequest("REPORT VTODO", {
      method: "REPORT",
      url: calendarUrl,
      body: reportTodos(filters),
      depth: "1",
    })
  }

  /** REPORT a `calendar-query` for `VEVENT`; returns the raw multi-status body. */
  queryEvents(
    calendarUrl: string,
    filters: EventReportFilters = {},
  ): Promise<CalDavResult<string>> {
    return this.xmlRequest("REPORT VEVENT", {
      method: "REPORT",
      url: calendarUrl,
      body: reportEvents(filters),
      depth: "1",
    })
  }

  /** Resources carried by a `calendar-query` response, with ETags and data. */
  readReport(xml: string): ReturnType<typeof readReportResources> {
    return readReportResources(xml)
  }

  /**
   * `GET` one iCalendar resource.
   *
   * CALDAV:GET is not specified by RFC 4791, but every server that speaks DAV
   * serves it, and it is the only way to read a resource whose collection is not
   * known — which is the case for a `get_todo` by URL.
   */
  async getIcalResource(url: string): Promise<CalDavResult<IcalResource>> {
    const headers: Record<string, string> = {}
    const authorization = this.authorizationHeader()
    if (authorization !== undefined) headers["Authorization"] = authorization
    const response = await this.simpleRequest("GET", url, { headers })
    if (!response.success) return reshapeFailure(response)
    try {
      return ok({
        data: await response.output.text(),
        etag: response.output.headers.get("ETag") ?? "",
      })
    } catch (cause) {
      return transportError("GET", url, cause)
    }
  }

  /**
   * `PUT` an iCalendar resource.
   *
   * @param etag when supplied it becomes `If-Match`, which is what makes the
   * write conditional: a stale ETag yields a `PRECONDITION_FAILED` failure
   * instead of silently overwriting a change made on another device. Omitting it
   * for an existing resource is an unconditional overwrite.
   * @returns the resource URL and the **new** ETag from the response, which the
   * caller must carry into the next write.
   */
  async putIcal(
    url: string,
    icalBody: string,
    etag?: string,
  ): Promise<CalDavResult<PutResult>> {
    const response = await this.simpleRequest("PUT", url, {
      method: "PUT",
      headers: this.icalHeaders(etag),
      body: icalBody,
    })
    if (!response.success) return reshapeFailure(response)
    return ok({ url, etag: response.output.headers.get("ETag") ?? "" })
  }

  /** `DELETE` a resource, conditionally when an ETag is known. */
  async deleteResource(url: string, etag?: string): Promise<CalDavResult<null>> {
    const headers: Record<string, string> = {}
    const authorization = this.authorizationHeader()
    if (authorization !== undefined) headers["Authorization"] = authorization
    if (etag !== undefined && etag !== "") headers["If-Match"] = etag
    const response = await this.simpleRequest("DELETE", url, { method: "DELETE", headers })
    if (!response.success) return reshapeFailure(response)
    return ok(null)
  }

  /**
   * `MKCALENDAR` a collection under `parentUrl`.
   *
   * The collection name is the URL-encoded `displayName`; RFC 4791 §5.3.1 lets a
   * server reject that with a `403`, which the caller sees as a failure rather
   * than a collection that was not created.
   */
  async makeCalendar(
    parentUrl: string,
    options: Parameters<typeof mkcalendar>[0],
  ): Promise<CalDavResult<MakeCalendarResult>> {
    const body = mkcalendar(options)
    const url = `${parentUrl.endsWith("/") ? parentUrl : `${parentUrl}/`}${
      encodeURIComponent(options.displayName)
    }/`
    const response = await this.xmlRequest("MKCALENDAR", {
      method: "MKCALENDAR",
      url,
      body,
    })
    if (!response.success) return reshapeFailure(response)
    return ok({ url })
  }

  /** `PROPPATCH` a collection's properties, from a {@link ProppatchOptions} object. */
  async updateCalendar(
    url: string,
    options: ProppatchOptions,
  ): Promise<CalDavResult<null>> {
    const body = proppatchCalendar(options)
    const response = await this.xmlRequest("PROPPATCH", { method: "PROPPATCH", url, body })
    if (!response.success) return reshapeFailure(response)
    return ok(null)
  }

  /** `PROPPATCH` a collection with a caller-supplied body, for an extension property. */
  async proppatch(url: string, xmlBody: string): Promise<CalDavResult<null>> {
    const response = await this.xmlRequest("PROPPATCH", {
      method: "PROPPATCH",
      url,
      body: xmlBody,
    })
    if (!response.success) return reshapeFailure(response)
    return ok(null)
  }

  /**
   * `UID` of an iCalendar document, read back through the package's own parser.
   *
   * The source ran `/^UID:(.*)$/m` over the generated text, which matches an
   * injected `X-UID:` line as readily as the real one. Parsing is the only way to
   * get the `UID` of the component the document actually contains.
   */
  static icalUid(icalBody: string): string | undefined {
    const parsed = parseIcal(icalBody)
    if (!parsed.success) return undefined
    for (const component of parsed.output.components) {
      const uid = component.data["UID"]
      if (uid !== undefined && uid !== "") return uid
    }
    return undefined
  }

  /** Component kinds a PROPFIND response advertised for `url`, if any. */
  static componentsOf(calendars: readonly Calendar[], url: string): ComponentType[] {
    return calendars.find((calendar) => calendar.url === url)?.components ?? []
  }
}

/**
 * Read the `href` nested inside a `calendar-home-set` element.
 *
 * The property's value is an `href` child, not text, so
 * `extractElementText(xml, "calendar-home-set")` returns the inner XML rather
 * than the URL. Kept separate from {@link extractElementText} because scoping
 * the search to the property's own block is what stops a `href` belonging to a
 * sibling `response` from being used as the home set.
 */
export function extractNestedHref(xml: string): string | undefined {
  const block =
    /<(?:[A-Za-z_][\w.-]*:)?calendar-home-set(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?calendar-home-set\s*>/is
      .exec(xml)
  if (!block) return undefined
  return extractElementText(block[1]!, "href")
}
