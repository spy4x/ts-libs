/**
 * Dev.to (Forem API v1): cross-post an article, find one by its canonical address and read how it
 * did.
 *
 * A blog that cross-posts sets `canonical_url` to its own page, so search engines rank the
 * original. Posting is not idempotent, so the pair is meant to be used together: look the
 * canonical address up first, post only when it is missing, then record the answer.
 *
 *  - Requests go to `https://dev.to/api` with the `api-key` header and
 *    `Accept: application/vnd.forem.api-v1+json`, as https://developers.forem.com/api/v1 describes.
 *  - The key never appears in `error` or `output`: transport errors carry only the error class,
 *    and Forem's own error text is cleaned and has the key replaced by `<REDACTED:API_KEY>`.
 *  - A redirect is a failure and is never followed, so the key cannot travel to another host.
 *  - Answers are read under a byte cap and checked with arktype before anything is returned.
 *  - `429` is retried, honouring `Retry-After`. A lookup also retries `5xx`, timeouts and
 *    transport failures; posting does not, because the article may already exist.
 *  - The functions never throw.
 *
 * Cross-posts an article to Dev.to (Forem API v1) with `canonical_url` pointing at the original, so
 * the copy helps the original's search ranking. All three return `{ success, output, error }` and never
 * throw.
 *
 * - **`createDevtoArticle({ apiKey, article, fetch?, requestTimeoutMs?, sleep? })`** posts
 *   `{ article: { title, body_markdown, published, canonical_url, description?, tags?, main_image? } }`
 *   to `https://dev.to/api/articles` and answers `output: { id, url }`. At most 4 tags, sent as one
 *   comma-separated string; `canonical_url` and `main_image` must be `http`/`https`.
 * - **`findDevtoArticleByCanonical({ apiKey, canonicalUrl, fetch?, requestTimeoutMs?, sleep? })`**
 *   reads `/api/articles/me/all` 1,000 articles per page until an empty page, and answers the
 *   article whose `canonical_url` matches after URL parsing, or `output: null`. A malformed page, or
 *   more than 100 pages, is a failure, never "not found".
 * - **`readDevtoArticleResults({ apiKey, id, … })`** reads the same listing until the article with
 *   that id, and answers its {@link ShareResults}: `views` is `page_views_count` (reported to the
 *   owner only; `null` when absent), `reactions` is `public_reactions_count`, `comments` is
 *   `comments_count`, `score` is `null`. `output` is `null` when no article of the key has the id.
 * - **Look up before posting.** Posting is not idempotent. Only `429` is retried on a post; after a
 *   `5xx`, a timeout or a dropped connection the error says the article may exist. The lookup also
 *   retries those. `Retry-After` is waited exactly, up to 30 s; three attempts at most.
 * - **The key stays secret.** It is sent only in the `api-key` header, a redirect is refused rather
 *   than followed, transport errors carry only the error class, and Forem's error text is cleaned,
 *   capped at 200 characters and has the key replaced by `<REDACTED:API_KEY>`.
 * - **Answers are checked.** Bodies are read under a cap (64 KiB for errors, 32 MiB for a page) and
 *   validated with arktype; an article `url` that is not `https` is refused.
 *
 * @module
 */

import { type } from "arktype"
import { readBoundedJson } from "@spy4x/net/bounded-body"
import { createPostTransport, type PostTransport } from "./_post.ts"
import {
  describeTransportError,
  isRequestTimeout,
  parseRetryAfterMs,
  releaseResponseBody,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"
import type { ShareResults } from "./share-results.ts"

const API = "https://dev.to/api"

/** The most tags Dev.to accepts on one article. */
export const DEVTO_MAX_TAGS = 4

/** Articles asked for per page of the lookup: the API's documented maximum. */
export const DEVTO_PAGE_SIZE = 1000

/** Pages the lookup reads at most before it gives up, so a looping answer cannot run forever. */
export const DEVTO_MAX_PAGES = 100

/** A page lists whole articles, Markdown included; a smaller answer would cut a large blog. */
const MAX_PAGE_BYTES = 32 * 1024 * 1024
const MAX_SMALL_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 200
const DEFAULT_TIMEOUT_MS = 30_000

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  totalBudgetMs: 90_000,
  jitterRatio: 0.2,
}

/** The article to post. Field names are Forem's. */
export interface DevtoArticleInput {
  title: string
  body_markdown: string
  /** The original's address, which search engines are told to rank. `http` or `https`. */
  canonical_url: string
  description?: string
  /** At most {@link DEVTO_MAX_TAGS}; sent as the comma-separated string Forem documents. */
  tags?: readonly string[]
  /** Cover image address, `http` or `https`. */
  main_image?: string
  /** `false` saves a draft. */
  published: boolean
}

/** A Dev.to article: its numeric id and public address. */
export interface DevtoArticleRef {
  id: number
  url: string
}

/** Settings both calls share. */
export interface DevtoClientOptions {
  /** Dev.to API key, from Settings → Extensions. Never logged. */
  apiKey: string
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Limit for each request, body included; 30 s by default. */
  requestTimeoutMs?: number
  /** Waits between attempts; injected by tests so nothing sleeps. */
  sleep?: Sleeper
}

/** Options for {@link createDevtoArticle}. */
export interface CreateDevtoArticleOptions extends DevtoClientOptions {
  article: DevtoArticleInput
}

/** Options for {@link findDevtoArticleByCanonical}. */
export interface FindDevtoArticleByCanonicalOptions extends DevtoClientOptions {
  /** The address to look for in each article's `canonical_url`. */
  canonicalUrl: string
}

/** Options for {@link readDevtoArticleResults}. */
export interface ReadDevtoArticleResultsOptions extends DevtoClientOptions {
  /** The article's numeric id, as {@link createDevtoArticle} answers it. */
  id: number
}

/**
 * Outcome of {@link readDevtoArticleResults}: the article's {@link ShareResults} (`score` is
 * always `null`), or `null` when none of the key's articles has that id.
 */
export type DevtoResultsResult =
  | { success: true; output: ShareResults | null; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link createDevtoArticle}: the new article on success, `error` on failure. */
export type DevtoCreateResult =
  | { success: true; output: DevtoArticleRef; error: "" }
  | { success: false; output: null; error: string }

/**
 * Outcome of {@link findDevtoArticleByCanonical}: the article, or `null` when none of the key's
 * articles has that canonical address. A failure never means "not found".
 */
export type DevtoFindResult =
  | { success: true; output: DevtoArticleRef | null; error: "" }
  | { success: false; output: null; error: string }

const failure = (error: string) => ({ success: false as const, output: null, error })

/** Printable ASCII without spaces, so `Headers` cannot throw on it. */
const KEY_SHAPE = /^[\x21-\x7E]+$/

const ArticleInput = type({
  title: "string > 0",
  body_markdown: "string > 0",
  canonical_url: "string",
  "description?": "string",
  "tags?": type("string > 0").array().atMostLength(DEVTO_MAX_TAGS),
  "main_image?": "string",
  published: "boolean",
})

const ArticleRef = type({ id: "number.integer > 0", url: "string" })

/** The counts a `/articles/me/all` entry carries; `page_views_count` is the owner's alone. */
const Stats = type({
  "page_views_count?": "number.integer >= 0 | null",
  "public_reactions_count?": "number.integer >= 0",
  "comments_count?": "number.integer >= 0",
})

const Page = type({
  id: "number.integer > 0",
  url: "string",
  "canonical_url?": "string | null",
}).array()

/** `input` parsed as an `http`/`https` URL, or `undefined`. */
const webUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string") return undefined
  try {
    const url = new URL(input)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/** Only an `https` address leaves this module as an article's `url`. */
const toRef = (entry: { id: number; url: string }): DevtoArticleRef | undefined =>
  webUrl(entry.url)?.protocol === "https:" ? { id: entry.id, url: entry.url } : undefined

/** What one request produced. */
type Outcome =
  | { ok: true; body: unknown }
  | {
    ok: false
    message: string
    retryable: boolean
    /** True when the server may have acted anyway: a `5xx`, a lost answer, a timeout. */
    uncertain: boolean
    retryAfterMs?: number
  }

interface RequestSpec {
  method: "GET" | "POST"
  url: string
  body?: string
  maxBytes: number
  /** Whether a `5xx`, a timeout or a transport failure may be sent again. */
  idempotent: boolean
}

/** Removes control characters and the key from Forem's error text, then caps it. */
const cleanMessage = (text: string, apiKey: string): string => {
  const clean = text.replace(/\p{Cc}+/gu, " ").split(apiKey).join("<REDACTED:API_KEY>").trim()
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}...` : clean
}

/** Forem answers `{ error, status }` on failure; anything else reads as no detail. */
const describeHttpFailure = async (response: Response, apiKey: string): Promise<string> => {
  let detail = ""
  try {
    const body = await readBoundedJson(response, { maxBytes: MAX_SMALL_BYTES, timeoutMs: 5_000 })
    const error = (body as { error?: unknown } | null)?.error
    if (typeof error === "string") detail = cleanMessage(error, apiKey)
  } catch {
    // `readBoundedJson` cancels the body on every failure it throws for.
  }
  return `dev.to answered HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`
}

/** A 3xx to a `redirect: "manual"` request; a browser reports it as `opaqueredirect`. */
const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)

/** Sends one request; never throws. */
const sendOnce = async (
  transport: PostTransport,
  apiKey: string,
  spec: RequestSpec,
  remainingBudgetMs: number,
): Promise<Outcome> => {
  const timeoutMs = Math.max(Math.min(transport.requestTimeoutMs, remainingBudgetMs), 0)
  const headers = new Headers({ "api-key": apiKey, Accept: "application/vnd.forem.api-v1+json" })
  if (spec.body !== undefined) headers.set("Content-Type", "application/json")
  try {
    const response = await transport.fetcher(spec.url, {
      method: spec.method,
      headers,
      body: spec.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (isRedirect(response)) {
      await releaseResponseBody(response).catch(() => undefined)
      return {
        ok: false,
        message: `dev.to answered with a redirect (${response.status})`,
        retryable: false,
        uncertain: false,
      }
    }
    if (!response.ok) {
      const status = response.status
      const retryAfter = response.headers.get("Retry-After")
      const message = await describeHttpFailure(response, apiKey)
      return {
        ok: false,
        message,
        retryable: status === 429 || (spec.idempotent && status >= 500),
        uncertain: status >= 500,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      }
    }
    try {
      const body = await readBoundedJson(response, { maxBytes: spec.maxBytes, timeoutMs })
      return { ok: true, body }
    } catch (cause) {
      return {
        ok: false,
        message: `dev.to answer unreadable (${
          cause instanceof SyntaxError ? "not JSON" : describeTransportError(cause)
        })`,
        retryable: false,
        uncertain: true,
      }
    }
  } catch (cause) {
    return {
      ok: false,
      message: isRequestTimeout(cause)
        ? `dev.to request timed out after ${timeoutMs} ms`
        : `dev.to request failed (${describeTransportError(cause)})`,
      retryable: spec.idempotent,
      uncertain: true,
    }
  }
}

/** Sends `spec`, retrying what {@link sendOnce} marks retryable. */
const send = async (transport: PostTransport, apiKey: string, spec: RequestSpec) => {
  const run = await runWithRetry<Outcome>({
    policy: transport.policy,
    sleep: transport.sleep,
    clock: transport.clock,
    backoff: transport.backoff,
    attempt: async (_attempt, remainingBudgetMs) => {
      const value = await sendOnce(transport, apiKey, spec, remainingBudgetMs)
      return {
        failed: !value.ok && value.retryable,
        retryAfterMs: value.ok ? undefined : value.retryAfterMs,
        value,
      }
    },
  })
  return run.result
}

/** Checks the shared options; returns the transport, or the reason it cannot be built. */
const prepare = (options: DevtoClientOptions): PostTransport | string => {
  if (typeof options.apiKey !== "string" || !KEY_SHAPE.test(options.apiKey)) {
    return "invalid options: apiKey must be a non-empty string without spaces"
  }
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return "invalid options: requestTimeoutMs must be a positive number"
  }
  const transport = createPostTransport(POLICY, {
    fetcher: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep,
    requestTimeoutMs: timeout,
  })
  const jittered = transport.backoff
  // `Retry-After` is waited exactly, capped at `maxDelayMs`: jitter could cut it short and
  // spend the next attempt on another 429.
  transport.backoff = (attempt, retryAfterMs) =>
    retryAfterMs === undefined ? jittered(attempt) : Math.min(retryAfterMs, POLICY.maxDelayMs)
  return transport
}

/**
 * Posts `article` to Dev.to and returns its id and address. Never throws.
 *
 * Only `429` is sent again: after a `5xx`, a timeout or a dropped connection the article may
 * exist, so the error says to look it up with {@link findDevtoArticleByCanonical} first. A `4xx`
 * or a redirect means nothing was posted, and its error says nothing of the kind.
 *
 * @example
 * ```ts
 * const found = await findDevtoArticleByCanonical({ apiKey, canonicalUrl })
 * if (found.success && found.output === null) {
 *   const made = await createDevtoArticle({
 *     apiKey,
 *     article: { title, body_markdown, canonical_url: canonicalUrl, published: true },
 *   })
 *   if (!made.success) console.warn(made.error)
 * }
 * ```
 */
export const createDevtoArticle = async (
  options: CreateDevtoArticleOptions,
): Promise<DevtoCreateResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options)
  if (typeof transport === "string") return failure(transport)
  const article = ArticleInput(options.article)
  if (article instanceof type.errors) return failure(`invalid article: ${article.summary}`)
  if (webUrl(article.canonical_url) === undefined) {
    return failure("invalid article: canonical_url must be an http or https URL")
  }
  if (article.main_image !== undefined && webUrl(article.main_image) === undefined) {
    return failure("invalid article: main_image must be an http or https URL")
  }

  const body = JSON.stringify({
    article: {
      title: article.title,
      body_markdown: article.body_markdown,
      published: article.published,
      canonical_url: article.canonical_url,
      ...(article.description === undefined ? {} : { description: article.description }),
      ...(article.tags === undefined ? {} : { tags: article.tags.join(", ") }),
      ...(article.main_image === undefined ? {} : { main_image: article.main_image }),
    },
  })
  const outcome = await send(transport, options.apiKey, {
    method: "POST",
    url: `${API}/articles`,
    body,
    maxBytes: MAX_PAGE_BYTES,
    idempotent: false,
  })
  if (!outcome.ok) {
    return failure(
      outcome.uncertain
        ? `${outcome.message}; the article may exist, look it up before posting again`
        : outcome.message,
    )
  }
  const parsed = ArticleRef(outcome.body)
  const ref = parsed instanceof type.errors ? undefined : toRef(parsed)
  if (ref === undefined) {
    return failure(
      "dev.to answer has no valid id and https url; the article may exist, look it up",
    )
  }
  return { success: true, output: ref, error: "" }
}

/**
 * Finds the key owner's article whose `canonical_url` is `canonicalUrl`, published or not.
 * Never throws.
 *
 * Reads `/articles/me/all` page by page until an empty page or a match. Addresses are compared
 * after URL parsing, so `HTTPS://Example.com/a` matches `https://example.com/a`. A page with a
 * malformed article fails the lookup rather than skipping it, so a caller never posts twice
 * because of an answer it could not read. More than {@link DEVTO_MAX_PAGES} pages also fails.
 */
export const findDevtoArticleByCanonical = async (
  options: FindDevtoArticleByCanonicalOptions,
): Promise<DevtoFindResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options)
  if (typeof transport === "string") return failure(transport)
  const wanted = webUrl(options.canonicalUrl)?.href
  if (wanted === undefined) {
    return failure("invalid options: canonicalUrl must be an http or https URL")
  }

  const scan = await scanOwnArticles(
    transport,
    options.apiKey,
    (entry) => webUrl(entry.canonical_url)?.href === wanted,
  )
  if (!scan.ok) return failure(scan.error)
  if (scan.entry === null) return { success: true, output: null, error: "" }
  const ref = toRef(scan.entry)
  if (ref === undefined) return failure(`dev.to article ${scan.entry.id} has no https url`)
  return { success: true, output: ref, error: "" }
}

/**
 * Reads how one of the key owner's articles did: views, reactions and comments. Never throws.
 *
 * Forem reports views (`page_views_count`) only to the owner, in `/articles/me/all`, so this
 * reads that listing page by page until the article with `id` turns up, as
 * {@link findDevtoArticleByCanonical} does. `output` is `null` when no article of the key has
 * that id; `views` is `null` when Forem leaves the field out. A malformed page fails the read.
 */
export const readDevtoArticleResults = async (
  options: ReadDevtoArticleResultsOptions,
): Promise<DevtoResultsResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options)
  if (typeof transport === "string") return failure(transport)
  if (!Number.isSafeInteger(options.id) || options.id <= 0) {
    return failure("invalid options: id must be a positive integer")
  }
  const scan = await scanOwnArticles(transport, options.apiKey, (entry) => entry.id === options.id)
  if (!scan.ok) return failure(scan.error)
  if (scan.entry === null) return { success: true, output: null, error: "" }
  const stats = Stats(scan.raw)
  if (stats instanceof type.errors) {
    return failure(`dev.to article ${options.id} has malformed counts: ${stats.summary}`)
  }
  return {
    success: true,
    output: {
      views: stats.page_views_count ?? null,
      reactions: stats.public_reactions_count ?? null,
      comments: stats.comments_count ?? null,
      score: null,
    },
    error: "",
  }
}

type PageEntry = typeof Page.infer[number]

/** What {@link scanOwnArticles} found: the matching entry and its raw object, or `null`. */
type Scan =
  | { ok: true; entry: PageEntry; raw: unknown }
  | { ok: true; entry: null; raw: null }
  | { ok: false; error: string }

/**
 * Reads `/articles/me/all` page by page until `matches` picks an entry or a page is empty. A
 * malformed page, or more than {@link DEVTO_MAX_PAGES} pages, is a failure, never "not found".
 */
const scanOwnArticles = async (
  transport: PostTransport,
  apiKey: string,
  matches: (entry: PageEntry) => boolean,
): Promise<Scan> => {
  for (let page = 1; page <= DEVTO_MAX_PAGES; page++) {
    const outcome = await send(transport, apiKey, {
      method: "GET",
      url: `${API}/articles/me/all?page=${page}&per_page=${DEVTO_PAGE_SIZE}`,
      maxBytes: MAX_PAGE_BYTES,
      idempotent: true,
    })
    if (!outcome.ok) return { ok: false, error: outcome.message }
    const entries = Page(outcome.body)
    if (entries instanceof type.errors) {
      return { ok: false, error: `dev.to page ${page} is not a list of articles` }
    }
    if (entries.length === 0) return { ok: true, entry: null, raw: null }
    const index = entries.findIndex(matches)
    if (index !== -1) {
      return { ok: true, entry: entries[index], raw: (outcome.body as unknown[])[index] }
    }
  }
  return { ok: false, error: `dev.to lookup stopped after ${DEVTO_MAX_PAGES} pages` }
}
