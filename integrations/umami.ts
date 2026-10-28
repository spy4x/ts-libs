/**
 * A small client for a self-hosted Umami (v3): short links and a reachability check.
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
 * Shapes checked against Umami's source, `src/app/api/links/route.ts` and
 * `src/app/(collect)/q/[slug]/route.ts` (v3.4).
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
