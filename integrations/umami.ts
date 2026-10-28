/**
 * A small client for a self-hosted Umami (v3): short links, a reachability check, and reads of a
 * website's numbers (totals, breakdowns, series and event properties).
 *
 * Umami's Links (`POST /api/links`) count every visit to `<umami>/q/<slug>` and then redirect to
 * the link's `url`. A product makes one link per place it shares an address in (a group, a social
 * network, a friend), so Umami can tell the places apart (spy4x/seed#483).
 *
 * Behaviour:
 *
 *  - Every function never throws and returns `{ success, output, error }`.
 *  - Every request is bounded by `AbortSignal.timeout`.
 *  - {@link createUmamiLink} with an `id` is idempotent: when the create fails over HTTP (Umami
 *    refuses an id it already has), it reads the link by that id, and a link with the same slug
 *    and url counts as created. A retry after a lost answer, or two presses at once, make one link.
 *  - No error or output contains the token or a request header: transport failures are reported
 *    by class name only (`describeTransportError`), and API failures by the status and Umami's
 *    message, with control characters removed, the token replaced by `<REDACTED:TOKEN>` and the
 *    length capped. Answers are read under a 64 KiB cap.
 *
 * Shapes checked against Umami's source, `src/app/api/links/route.ts`,
 * `src/app/(collect)/q/[slug]/route.ts` and `src/app/api/websites/[websiteId]/{stats,metrics,
 * pageviews,event-data/values}/route.ts` (v3.4).
 * @module
 */

import { readBoundedJson } from "@spy4x/net/bounded-body"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isRequestTimeout,
  releaseResponseBody,
} from "./retry.ts"

/** Umami's limits for a link: a name of 100 characters, a url of 500, a slug of 8 to 100. */
export const UMAMI_LINK_NAME_MAX = 100
export const UMAMI_LINK_URL_MAX = 500
/** A slug this client sends: 8 to 100 letters, digits, `-` and `_`, so it is safe in a path. */
export const UMAMI_SLUG_PATTERN = /^[A-Za-z0-9_-]{8,100}$/

/** An Umami answer is a few hundred bytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where an Umami instance is, and how to reach it. */
export interface UmamiConnection {
  /** The instance's address, such as `https://stats.example.com`, with its base path if any. */
  baseUrl: string
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, `DEFAULT_REQUEST_TIMEOUT_MS` (10 s) by default. */
  requestTimeoutMs?: number
}

/** A link as Umami stores it. */
export interface UmamiLink {
  id: string
  name: string
  url: string
  slug: string
}

/** Options for {@link createUmamiLink}. */
export interface UmamiLinkCreateOptions extends UmamiConnection {
  /** A Bearer token of an Umami user who may create links. Never logged. */
  token: string
  /** The link's id, a UUID. Give one to make the create idempotent; Umami makes one otherwise. */
  id?: string
  /** What Umami's Links list shows, at most {@link UMAMI_LINK_NAME_MAX} characters. */
  name: string
  /** Where a visit goes after Umami counts it: an `http`/`https` URL, at most 500 characters. */
  url: string
  /** The link's address part, matching {@link UMAMI_SLUG_PATTERN}. Unique in the instance. */
  slug: string
  /** The Umami team that owns the link; the token's user owns it otherwise. */
  teamId?: string
}

/** Outcome of {@link createUmamiLink}: the link on success, why not on failure. */
export type UmamiLinkResult =
  | { success: true; output: UmamiLink; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link checkUmami}: `output` says what was seen on success, `error` on failure. */
export interface UmamiCheckResult {
  success: boolean
  output: string
  error: string
}

const linkFailure = (error: string): UmamiLinkResult => ({ success: false, output: null, error })

/** The base address without a trailing slash, or `undefined` when it is no `http`/`https` URL. */
const apiBase = (baseUrl: unknown): string | undefined => {
  if (typeof baseUrl !== "string") return undefined
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
      return undefined
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  } catch {
    return undefined
  }
}

const isWebUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * The public address of a link: `<baseUrl>/q/<slug>`, which counts the visit and redirects. An
 * instance that sets `LINKS_URL` serves its links on that host as well; this address works either
 * way. Throws on a `baseUrl` that is no `http`/`https` URL or a slug outside
 * {@link UMAMI_SLUG_PATTERN}, both programming errors.
 */
export const umamiLinkUrl = (baseUrl: string, slug: string): string => {
  const base = apiBase(baseUrl)
  if (base === undefined) throw new TypeError("baseUrl must be an http or https URL")
  if (!UMAMI_SLUG_PATTERN.test(slug)) throw new TypeError("slug must match UMAMI_SLUG_PATTERN")
  return `${base}/q/${slug}`
}

/**
 * Reads a JSON answer under a byte cap. A body that is too large, stalls or is not JSON reads as
 * `undefined`, so the caller reports the status alone.
 */
const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: 5_000 })
  } catch {
    return undefined
  }
}

/** `text` with no control characters and no token, capped. Redacts before cutting. */
const cleanMessage = (text: string, token: string): string => {
  let out = text.replace(/\p{Cc}+/gu, " ")
  for (const secret of new Set([token, token.trim()])) {
    if (secret !== "") out = out.split(secret).join("<REDACTED:TOKEN>")
  }
  out = out.trim()
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS)}...` : out
}

/** `HTTP <status>` and Umami's `error.message` (or a plain string `error`), cleaned. */
const describeApiFailure = (body: unknown, status: number, token: string): string => {
  const error = (body as { error?: unknown } | undefined)?.error
  const message = typeof error === "string"
    ? error
    : (error as { message?: unknown } | undefined)?.message
  const detail = typeof message === "string" ? cleanMessage(message, token) : ""
  return `HTTP ${status}${detail === "" ? "" : `: ${detail}`}`
}

const describeThrown = (cause: unknown, requestTimeoutMs: number): string =>
  isRequestTimeout(cause)
    ? `request timed out after ${requestTimeoutMs} ms`
    : describeTransportError(cause)

/** The link in an Umami answer, or `undefined` when the answer is not one. */
const parseLink = (body: unknown): UmamiLink | undefined => {
  const { id, name, url, slug } = (body ?? {}) as Record<string, unknown>
  return typeof id === "string" && typeof name === "string" && typeof url === "string" &&
      typeof slug === "string"
    ? { id, name, url, slug }
    : undefined
}

const checkConnection = (
  options: UmamiConnection,
): { base: string; doFetch: typeof fetch; requestTimeoutMs: number } | string => {
  const base = apiBase(options.baseUrl)
  if (base === undefined) return "invalid options: baseUrl must be an http or https URL"
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return "invalid options: requestTimeoutMs must be a positive number"
  }
  return { base, doFetch: options.fetch ?? globalThis.fetch, requestTimeoutMs }
}

/**
 * Creates an Umami link and returns it. Never throws.
 *
 * With an `id`, a failed create that left a link with that id, slug and url behind (a retry after
 * a lost answer, a second request at once) is a success: Umami refuses the second create, and the
 * link is read back by its id.
 *
 * @example
 * ```ts
 * const result = await createUmamiLink({
 *   baseUrl: "https://stats.example.com",
 *   token,
 *   id: linkId,
 *   name: "Linen shirt · Zalo group A",
 *   url: "https://shop.example/shirts/linen?utm_source=zalo-a",
 *   slug: "k3Jx9_Pq2a",
 * })
 * if (!result.success) console.warn(result.error)
 * ```
 */
export const createUmamiLink = async (
  options: UmamiLinkCreateOptions,
): Promise<UmamiLinkResult> => {
  if (typeof options !== "object" || options === null) {
    return linkFailure("invalid options: expected an options object")
  }
  const connection = checkConnection(options)
  if (typeof connection === "string") return linkFailure(connection)
  const { base, doFetch, requestTimeoutMs } = connection
  const { token, id, name, url, slug, teamId } = options

  if (typeof token !== "string" || token.trim() === "") {
    return linkFailure("invalid options: token is empty")
  }
  if (id !== undefined && (typeof id !== "string" || !UUID_PATTERN.test(id))) {
    return linkFailure("invalid options: id must be a UUID")
  }
  if (typeof name !== "string" || name.trim() === "" || name.length > UMAMI_LINK_NAME_MAX) {
    return linkFailure(`invalid options: name must be 1 to ${UMAMI_LINK_NAME_MAX} characters`)
  }
  if (typeof url !== "string" || url.length > UMAMI_LINK_URL_MAX || !isWebUrl(url)) {
    return linkFailure(
      `invalid options: url must be an http or https URL of at most ${UMAMI_LINK_URL_MAX} characters`,
    )
  }
  if (typeof slug !== "string" || !UMAMI_SLUG_PATTERN.test(slug)) {
    return linkFailure("invalid options: slug must be 8 to 100 letters, digits, - and _")
  }
  if (teamId !== undefined && (typeof teamId !== "string" || teamId.trim() === "")) {
    return linkFailure("invalid options: teamId is empty")
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  try {
    const response = await doFetch(`${base}/api/links`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(id === undefined ? {} : { id }),
        name,
        url,
        slug,
        ...(teamId === undefined ? {} : { teamId }),
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    const body = await readJson(response)
    if (response.ok) {
      const link = parseLink(body)
      return link === undefined
        ? linkFailure(`create failed (HTTP ${response.status}: the answer is not a link)`)
        : { success: true, output: link, error: "" }
    }
    const why = describeApiFailure(body, response.status, token)
    if (id === undefined) return linkFailure(`create failed (${why})`)

    // Umami refuses an id it already has. Read it: the same link means an earlier create landed.
    const existing = await doFetch(`${base}/api/links/${id}`, {
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!existing.ok) {
      await releaseResponseBody(existing)
      return linkFailure(`create failed (${why})`)
    }
    const link = parseLink(await readJson(existing))
    if (link !== undefined && link.id === id && link.slug === slug && link.url === url) {
      return { success: true, output: link, error: "" }
    }
    return linkFailure(`create failed (${why}); link ${id} exists with another slug or url`)
  } catch (cause) {
    return linkFailure(`request failed (${describeThrown(cause, requestTimeoutMs)})`)
  }
}

/**
 * Asks Umami's `GET /api/heartbeat` whether the instance answers. Needs no token; never throws.
 * A product calls it before sending a visitor through a link, and sends them straight on when it
 * fails.
 */
export const checkUmami = async (options: UmamiConnection): Promise<UmamiCheckResult> => {
  if (typeof options !== "object" || options === null) {
    return { success: false, output: "", error: "invalid options: expected an options object" }
  }
  const connection = checkConnection(options)
  if (typeof connection === "string") return { success: false, output: "", error: connection }
  const { base, doFetch, requestTimeoutMs } = connection
  try {
    const response = await doFetch(`${base}/api/heartbeat`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    const body = await readJson(response)
    if (response.ok && (body as { ok?: unknown } | undefined)?.ok === true) {
      return { success: true, output: "Umami answers", error: "" }
    }
    return { success: false, output: "", error: `heartbeat failed (HTTP ${response.status})` }
  } catch (cause) {
    return {
      success: false,
      output: "",
      error: `request failed (${describeThrown(cause, requestTimeoutMs)})`,
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a website's numbers
// ---------------------------------------------------------------------------------------------

/** A report answer is a few hundred rows at most; anything past this is not one. */
const MAX_REPORT_BYTES = 512 * 1024

/** The filters Umami's website reports take, each matching one value exactly. */
export type UmamiFilterName =
  | "path"
  | "referrer"
  | "title"
  | "query"
  | "hostname"
  | "event"
  | "tag"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "utmContent"
  | "utmTerm"

/** What every read of a website's numbers needs. */
export interface UmamiWebsiteRead extends UmamiConnection {
  /** A Bearer token of an Umami user who may view the website. Never logged. */
  token: string
  /** The website's id, from its settings in Umami. */
  websiteId: string
  /** The period's start, in milliseconds since the epoch. */
  startAt: number
  /** The period's end, in milliseconds since the epoch. */
  endAt: number
  /** Narrows every count to events that match, such as `{ utmSource: "zalo-a" }`. */
  filters?: Partial<Record<UmamiFilterName, string>>
}

/**
 * Outcome of a read. A failure carries the HTTP `status` Umami answered, or `null` when it did not
 * answer or the options were wrong, so a caller can tell a refused token (`401`) from an outage.
 */
export type UmamiReadResult<T> =
  | { success: true; output: T; error: "" }
  | { success: false; output: null; error: string; status: number | null }

/** A website's totals over a period: Umami's `/stats`. */
export interface UmamiTotals {
  pageviews: number
  /** People, each counted once. */
  visitors: number
  /** Sessions: one person's pages until 30 minutes pass without one. */
  visits: number
  bounces: number
  /** Seconds spent, summed over the visits. */
  totaltime: number
}

/** {@link UmamiTotals} of the period and of the period of the same length just before it. */
export interface UmamiStats extends UmamiTotals {
  comparison: UmamiTotals
}

/** One row of a breakdown: a value (`x`, such as a path or an event name) and its count (`y`). */
export interface UmamiMetric {
  x: string
  y: number
}

/** What a breakdown counts by: page views and visits by these, events by `event` (Umami's names). */
export type UmamiMetricType =
  | "path"
  | "entry"
  | "exit"
  | "referrer"
  | "title"
  | "query"
  | "hostname"
  | "event"
  | "tag"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "utmContent"
  | "utmTerm"
  | "browser"
  | "os"
  | "device"
  | "language"
  | "country"

/** One point of a series: the start of its unit as Umami prints it (`x`), and a count (`y`). */
export interface UmamiPoint {
  x: string
  y: number
}

/** Page views and visitors per unit of time. */
export interface UmamiSeries {
  pageviews: UmamiPoint[]
  /** People per unit, each counted once in it. */
  sessions: UmamiPoint[]
}

/** {@link UmamiSeries}, with the previous period's when `compare` was asked for. */
export interface UmamiPageviews extends UmamiSeries {
  compare: UmamiSeries | null
}

/** How many events carried one value of a property. */
export interface UmamiPropertyValue {
  value: string
  total: number
}

/** Why {@link checkUmamiWebsite} failed. */
export type UmamiWebsiteProblem = "token" | "website" | "unreachable"

/** Outcome of {@link checkUmamiWebsite}. */
export type UmamiWebsiteCheck =
  | { success: true; output: { id: string; name: string }; error: "" }
  | { success: false; output: null; error: string; problem: UmamiWebsiteProblem }

const readFailure = (error: string, status: number | null = null) => ({
  success: false as const,
  output: null,
  error,
  status,
})

/** A count as Umami prints it: a number, or a whole number in a string. `undefined` otherwise. */
const toCount = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return undefined
}

const parseTotals = (body: unknown): UmamiTotals | undefined => {
  const row = (body ?? {}) as Record<string, unknown>
  const totals = {
    pageviews: toCount(row.pageviews),
    visitors: toCount(row.visitors),
    visits: toCount(row.visits),
    bounces: toCount(row.bounces),
    totaltime: toCount(row.totaltime),
  }
  return Object.values(totals).every((value) => value !== undefined)
    ? totals as UmamiTotals
    : undefined
}

/** Rows of `{ [label]: string, [count]: number }`, or `undefined` when the answer is not a list. */
const parseRows = <L extends string, C extends string>(
  body: unknown,
  label: L,
  count: C,
): Array<Record<L, string> & Record<C, number>> | undefined => {
  if (!Array.isArray(body)) return undefined
  const rows: Array<Record<L, string> & Record<C, number>> = []
  for (const item of body) {
    const row = (item ?? {}) as Record<string, unknown>
    const value = toCount(row[count])
    const name = row[label] === null ? "" : row[label]
    if (typeof name !== "string" || value === undefined) return undefined
    rows.push({ [label]: name, [count]: value } as Record<L, string> & Record<C, number>)
  }
  return rows
}

const parseSeries = (body: unknown): UmamiSeries | undefined => {
  const { pageviews, sessions } = (body ?? {}) as Record<string, unknown>
  const views = parseRows(pageviews, "x", "y")
  const people = parseRows(sessions, "x", "y")
  return views && people ? { pageviews: views, sessions: people } : undefined
}

/**
 * GETs `<base>/api/<path>` with the token and `query`, and parses the JSON answer with `parse`.
 * Never throws; a failure names the status and Umami's cleaned message, never the token.
 */
const getJson = async <T>(
  options: UmamiConnection & { token: string },
  path: string,
  query: Record<string, string | number | undefined>,
  parse: (body: unknown) => T | undefined,
): Promise<UmamiReadResult<T>> => {
  if (typeof options !== "object" || options === null) {
    return readFailure("invalid options: expected an options object")
  }
  const connection = checkConnection(options)
  if (typeof connection === "string") return readFailure(connection)
  const { base, doFetch, requestTimeoutMs } = connection
  const { token } = options
  if (typeof token !== "string" || token.trim() === "") {
    return readFailure("invalid options: token is empty")
  }
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value))
  }
  const search = params.size === 0 ? "" : `?${params}`
  try {
    const response = await doFetch(`${base}/api/${path}${search}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    let body: unknown
    try {
      body = await readBoundedJson(response, { maxBytes: MAX_REPORT_BYTES, timeoutMs: 5_000 })
    } catch {
      body = undefined
    }
    if (!response.ok) {
      return readFailure(
        `read failed (${describeApiFailure(body, response.status, token)})`,
        response.status,
      )
    }
    const output = parse(body)
    return output === undefined
      ? readFailure(`read failed (HTTP ${response.status}: the answer is not the expected shape)`)
      : { success: true, output, error: "" }
  } catch (cause) {
    return readFailure(`request failed (${describeThrown(cause, requestTimeoutMs)})`)
  }
}

/** Checks the period and the website id, then reads `/api/websites/<id>/<report>`. */
const readWebsite = <T>(
  options: UmamiWebsiteRead,
  report: string,
  query: Record<string, string | number | undefined>,
  parse: (body: unknown) => T | undefined,
): Promise<UmamiReadResult<T>> => {
  if (typeof options !== "object" || options === null) {
    return Promise.resolve(readFailure("invalid options: expected an options object"))
  }
  const { websiteId, startAt, endAt, filters = {} } = options
  if (typeof websiteId !== "string" || !UUID_PATTERN.test(websiteId)) {
    return Promise.resolve(readFailure("invalid options: websiteId must be a UUID"))
  }
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt > endAt) {
    return Promise.resolve(
      readFailure("invalid options: startAt and endAt must be times, startAt first"),
    )
  }
  return getJson(
    options,
    `websites/${websiteId}/${report}`,
    { startAt: Math.trunc(startAt), endAt: Math.trunc(endAt), ...query, ...filters },
    parse,
  )
}

/**
 * Reads a website's totals over a period, and the same totals over the period of the same length
 * just before it (Umami's `GET /api/websites/<id>/stats`). Never throws.
 *
 * @example
 * ```ts
 * const now = Date.now()
 * const result = await readUmamiStats({
 *   baseUrl: "https://stats.example.com",
 *   token,
 *   websiteId,
 *   startAt: now - 30 * 86_400_000,
 *   endAt: now,
 * })
 * if (result.success) console.log(result.output.visits, result.output.comparison.visits)
 * ```
 */
export const readUmamiStats = (options: UmamiWebsiteRead): Promise<UmamiReadResult<UmamiStats>> =>
  readWebsite(options, "stats", {}, (body) => {
    const totals = parseTotals(body)
    const comparison = parseTotals((body as { comparison?: unknown } | undefined)?.comparison)
    return totals && comparison ? { ...totals, comparison } : undefined
  })

/**
 * Reads a breakdown of a website's period by `type`, largest first (Umami's
 * `GET /api/websites/<id>/metrics`). For `event`, `y` counts the custom events of each name; for
 * the others, the visitors who viewed a page with each value. At most `limit` rows, 500 by default.
 * Never throws.
 */
export const readUmamiMetrics = (
  options: UmamiWebsiteRead & { type: UmamiMetricType; limit?: number },
): Promise<UmamiReadResult<UmamiMetric[]>> =>
  readWebsite(
    options,
    "metrics",
    { type: options?.type, limit: options?.limit },
    (body) => parseRows(body, "x", "y"),
  )

/**
 * Reads page views and visitors per `unit` of a period, in `timezone` (Umami's
 * `GET /api/websites/<id>/pageviews`). With `compare`, also the period of the same length just
 * before it. Umami leaves out a unit with nothing in it. Never throws.
 */
export const readUmamiPageviews = (
  options: UmamiWebsiteRead & {
    unit: "hour" | "day" | "month"
    /** An IANA time zone, such as `"Asia/Ho_Chi_Minh"`. */
    timezone: string
    compare?: boolean
  },
): Promise<UmamiReadResult<UmamiPageviews>> =>
  readWebsite(
    options,
    "pageviews",
    {
      unit: options?.unit,
      timezone: options?.timezone,
      compare: options?.compare ? "prev" : undefined,
    },
    (body) => {
      const series = parseSeries(body)
      if (!series) return undefined
      const compare = (body as { compare?: unknown }).compare
      if (compare === undefined) return { ...series, compare: null }
      const previous = parseSeries(compare)
      return previous ? { ...series, compare: previous } : undefined
    },
  )

/**
 * Reads how many custom events carried each value of one property, most first, such as the item
 * of an `order-telegram` event (Umami's `GET /api/websites/<id>/event-data/values`). At most 100
 * values. Never throws.
 */
export const readUmamiEventValues = (
  options: UmamiWebsiteRead & { eventName: string; propertyName: string },
): Promise<UmamiReadResult<UmamiPropertyValue[]>> =>
  readWebsite(
    options,
    "event-data/values",
    { eventName: options?.eventName, propertyName: options?.propertyName },
    (body) => parseRows(body, "value", "total"),
  )

/**
 * Checks that the token is accepted and can view the website, and says which of the two failed:
 * `token` when Umami refuses the token, `website` when the token works but no website with that id
 * is visible to it, `unreachable` for anything else. Never throws.
 */
export const checkUmamiWebsite = async (
  options: UmamiConnection & { token: string; websiteId: string },
): Promise<UmamiWebsiteCheck> => {
  const fail = (error: string, problem: UmamiWebsiteProblem): UmamiWebsiteCheck => ({
    success: false,
    output: null,
    error,
    problem,
  })
  if (typeof options !== "object" || options === null) {
    return fail("invalid options: expected an options object", "unreachable")
  }
  if (typeof options.websiteId !== "string" || !UUID_PATTERN.test(options.websiteId)) {
    return fail("invalid options: websiteId must be a UUID", "website")
  }
  const website = await getJson(
    options,
    `websites/${options.websiteId}`,
    {},
    (body) => {
      const { id, name } = (body ?? {}) as Record<string, unknown>
      return typeof id === "string" && typeof name === "string" ? { id, name } : null
    },
  )
  if (website.success && website.output !== null) {
    return { success: true, output: website.output, error: "" }
  }
  // An admin's token answers `null` for an id that does not exist.
  if (website.success) return fail("no website with this id", "website")
  if (website.status === 404) return fail(website.error, "website")
  if (website.status !== 401 && website.status !== 403) return fail(website.error, "unreachable")
  const me = await getJson(options, "me", {}, (body) => body ?? null)
  if (me.success) return fail("the token cannot view this website", "website")
  return fail(me.error, me.status === 401 ? "token" : "unreachable")
}
