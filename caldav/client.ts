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
 * **Credential rule.** Credentials are sent only to the origin the caller
 * configured in `baseUrl`, never to an origin a *server* named — enforced in
 * exactly one place, {@link CalDavClient.requestHeaders}, which every request
 * goes through and which is handed the **destination URL** as an argument. The
 * rule cannot be enforced at a call site, and this round proved it twice: a guard
 * on the one call that built a URL out of a `calendar-home-set` does not see a URL
 * a *different* response named — a `<D:href>` in the calendars PROPFIND, a `URL:`
 * property inside `calendar-data`, a `REPORT` target — because those URLs are
 * chosen later, by a layer that only asks for "the headers for an XML request".
 * The header builder therefore takes the URL now, compares `scheme://host:port`
 * with `baseUrl`'s ({@link sameOrigin}, which fails closed), and **omits**
 * `Authorization` when they differ. A request to another origin is still made
 * when the *caller* asked for it (their URL, their trust), but never with the
 * credential.
 *
 * On top of the gate, a URL the *server* named is refused outright rather than
 * followed unauthenticated — the client has no reason to talk to that origin at
 * all, and a de-authenticated request an attacker still answers is not a safe
 * outcome. Each place a server-named URL can enter a value refuses it there:
 *
 *  - `calendar-home-set` → a warning, and the `/username/` convention is used
 *    instead; the same fallback a missing or unreadable home set gets, so nothing
 *    new has to be handled by a caller;
 *  - a calendar collection `<D:href>` in the calendars PROPFIND → a warning, and
 *    the collection is skipped, so it never reaches a `REPORT` and never appears
 *    in `CalendarListing.calendars`;
 *  - a `URL:` property inside `calendar-data` → ignored in `ical.ts`'s
 *    `resourceUrl`, which keeps the derived URL, so `Todo.url` and `Event.url` are
 *    always on the configured origin and a caller may rely on that.
 *
 * A redirect is the one hop this gate cannot see, because it happens inside the
 * transport; `fetch` deletes `Authorization` from a request it redirects to
 * another origin (Fetch §4.4, "HTTP-redirect fetch"), which is the behaviour the
 * default transport relies on. A caller-supplied transport that follows redirects
 * itself must do the same.
 *
 * That rule bounds which *server-named* URL the client will use. It is not the
 * SSRF guard: it does not vet the `baseUrl` the caller chose, nor the resource
 * URLs a caller passes to `putIcal`, `getIcalResource` or `queryTodos`, because
 * those are the caller's own input and the caller owns their trust — a foreign
 * one now travels *without* the credential. A consumer that accepts a server URL
 * from an untrusted user should vet it with `validatePublicUrl` from
 * `@ts-libs/net/url-policy` (or drive the whole client through `safeFetch`)
 * before construction.
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
import { originOf, sameOrigin } from "./origin.ts"
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
   *
   * It carries no destination, so it cannot enforce the origin rule — a caller
   * that uses it is responsible for the URL it sends it to. The client's own
   * requests never call it directly: they go through {@link requestHeaders}.
   */
  authorizationHeader(): string | undefined {
    if (this.username === "") return undefined
    return `Basic ${btoa(`${this.username}:${this.password}`)}`
  }

  /**
   * Headers for one request: `extra`, plus the credential when — and only when —
   * `url` is on the origin the caller configured.
   *
   * **The single point at which a credential is attached to a request.** Every
   * credentialed request in this package goes through here, and the destination is
   * an argument rather than something a call site already knows, which is what
   * makes the rule hold for URLs that no call site chose: a `<D:href>` from a
   * response body, a `REPORT` target, a `URL:` property inside `calendar-data`, a
   * resource URL a caller passes to `putIcal`/`getIcalResource`/`deleteResource`.
   * A call-site check cannot see those, because at the call site the URL is
   * whatever the layer below decided.
   *
   * Fails closed in both directions: {@link sameOrigin} is false when either side
   * is not an `http(s)` URL, so a client whose `baseUrl` has no comparable origin
   * attaches no credential to anything, and neither does one whose destination is
   * unparseable.
   *
   * @param url Absolute request URL.
   * @param extra Headers this request needs regardless of origin.
   * @returns A fresh header object; no credential when the origins differ.
   */
  private requestHeaders(url: string, extra: Record<string, string> = {}): Record<string, string> {
    if (!sameOrigin(url, this.baseUrl)) return { ...extra }
    const authorization = this.authorizationHeader()
    if (authorization === undefined) return { ...extra }
    return { Authorization: authorization, ...extra }
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
        headers: this.requestHeaders(options.url, xmlHeaders(options.depth)),
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

  /**
   * Headers for an iCalendar request, including `If-Match` when an ETag is known.
   *
   * Takes the destination because the credential must be gated on it; see
   * {@link requestHeaders}.
   */
  private icalHeaders(url: string, etag?: string): Record<string, string> {
    const extra: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" }
    if (etag !== undefined && etag !== "") extra["If-Match"] = etag
    return this.requestHeaders(url, extra)
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
          const resolved = resolveUrl(href, root)
          const originWarning = crossOriginHomeSetWarning(resolved, root)
          if (originWarning === undefined) {
            return ok({ url: resolved, warnings })
          }
          warnings.push(originWarning)
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
   * A collection the response names on another origin is **skipped with a
   * warning**, never returned: it is a server-named URL, so the client has no
   * reason to talk to that origin, and returning it would hand a caller a
   * `Calendar.url` whose `REPORT` — the very next request `QueryEngine` makes —
   * would otherwise have carried the credential. Skipping here is what keeps the
   * guarantee in the module doc: nothing this package returns points off the
   * configured origin.
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
      let fallbackUrl: string | undefined
      try {
        fallbackUrl = this.resolve(`${encodeURIComponent(this.username)}/`)
      } catch (cause) {
        warnings.push(`${String(cause)}; not retrying the calendar listing`)
      }
      if (fallbackUrl !== undefined && fallbackUrl !== discovery.output.url) {
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
    const calendars: Calendar[] = []
    for (const calendar of parsed.output.calendars) {
      const originWarning = crossOriginCalendarWarning(calendar.url, this.baseUrl)
      if (originWarning === undefined) calendars.push(calendar)
      else warnings.push(originWarning)
    }
    return ok(
      { calendars, warnings: [...warnings, ...parsed.output.warnings] },
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
    const response = await this.simpleRequest("GET", url, {
      headers: this.requestHeaders(url),
    })
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
      headers: this.icalHeaders(url, etag),
      body: icalBody,
    })
    if (!response.success) return reshapeFailure(response)
    return ok({ url, etag: response.output.headers.get("ETag") ?? "" })
  }

  /** `DELETE` a resource, conditionally when an ETag is known. */
  async deleteResource(url: string, etag?: string): Promise<CalDavResult<null>> {
    const extra: Record<string, string> = {}
    if (etag !== undefined && etag !== "") extra["If-Match"] = etag
    const response = await this.simpleRequest("DELETE", url, {
      method: "DELETE",
      headers: this.requestHeaders(url, extra),
    })
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

/** Request headers for a CalDAV XML call: content type, plus `Depth` when given. */
function xmlHeaders(depth?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/xml; charset=utf-8" }
  if (depth !== undefined) headers["Depth"] = depth
  return headers
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

/**
 * The credential rule for a URL a **server** named: it is used only on the origin
 * the **caller** configured.
 *
 * A `calendar-home-set` is a server-supplied `href`, and a client that follows it
 * to another origin sends its `Authorization` header there — handing a Basic
 * credential to whoever can influence one byte of a discovery response. The rule
 * therefore cannot be "follow it and drop the header": the client has no reason
 * to talk to that origin at all, and a silently de-authenticated request against
 * an attacker host is still a request an attacker controls the answer to.
 *
 * The origin includes the port, so `https://host:8443/` and `https://host/` do
 * not match, and it excludes any path, so a home set on the same origin but a
 * different path is accepted, which is the normal shape.
 *
 * `scheme://host:port` cannot be faked with a lookalike the `URL` parser folds
 * differently: `new URL` lowercases the host, punycodes an IDN, resolves `..`
 * and drops a default port before this comparison ever runs. It does not fold a
 * trailing-dot host: `https://caldav.example.com./` is refused, which is the safe
 * direction.
 *
 * Fails closed. When either URL has no origin to compare — the constructor
 * accepts any absolute URL, so a non-`http(s)` `baseUrl` is possible — the
 * server-named URL is refused rather than used, because "cannot tell" must never
 * read as "same origin". That is also the reason this is not a call-site check
 * in `discoverCalendarHomeSet`: the credential itself is gated on the request URL
 * in {@link CalDavClient.requestHeaders}, and this function is the *policy* on
 * top of it.
 *
 * @param namedUrl The resolved URL the server named.
 * @param configuredUrl The URL the caller configured the client with.
 * @returns the warning to record before falling back, or `undefined` when the
 * origins match and the URL is safe to use.
 */
export function crossOriginHomeSetWarning(
  namedUrl: string,
  configuredUrl: string,
): string | undefined {
  if (sameOrigin(namedUrl, configuredUrl)) return undefined
  return `calendar-home-set ${namedUrl} is not on the configured origin ${
    originOf(configuredUrl) ?? configuredUrl
  }; using the /username/ convention instead, because credentials are sent only to the origin the caller configured`
}

/**
 * The same rule for a calendar collection a PROPFIND response named.
 *
 * Separate from {@link crossOriginHomeSetWarning} only because the consequence
 * differs: a cross-origin home set falls back to `/username/`, while a
 * cross-origin *collection* has no fallback — it is skipped, and the caller sees
 * the warning. Two things are bought by skipping rather than following without
 * credentials: the collection never reaches the `REPORT` that `QueryEngine` would
 * otherwise issue against it, and `CalendarListing.calendars` never carries a URL
 * off the configured origin for a caller to act on.
 *
 * @param url The resolved collection URL the server named.
 * @param configuredUrl The URL the caller configured the client with.
 * @returns the warning to record before skipping, or `undefined` when the origins
 * match and the collection is safe to use.
 */
export function crossOriginCalendarWarning(
  url: string,
  configuredUrl: string,
): string | undefined {
  if (sameOrigin(url, configuredUrl)) return undefined
  return `calendar ${url} is not on the configured origin ${
    originOf(configuredUrl) ?? configuredUrl
  }; skipping it, because credentials are sent only to the origin the caller configured`
}
