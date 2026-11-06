/**
 * Hacker News: read how a story did, and find the stories that link to an address. Read only,
 * through the public Algolia search API (`https://hn.algolia.com/api/v1`), with no key.
 *
 * - **`readHackerNewsItemResults({ id | url, fetch?, requestTimeoutMs?, sleep? })`** reads
 *   `/search?tags=story,story_<id>` and answers the story's {@link ShareResults}: `score` is its
 *   points, `comments` its `num_comments` (the count Hacker News shows), `views` and `reactions`
 *   are `null`. The id comes from `https://news.ycombinator.com/item?id=<id>` or is given as is.
 *   `output` is `null` when the index has no such story, as for a story a few minutes old.
 * - **`findHackerNewsStoriesByUrl({ url, … })`** searches stories by address
 *   (`restrictSearchableAttributes=url`) and answers those whose address matches `url` once both
 *   are normalised: the scheme, a trailing slash, the `#fragment` and `utm_*` parameters are
 *   ignored. Each is `{ id, url, points, comments, createdAt }`, with `url` the discussion page.
 * - `429`, `5xx`, timeouts and transport failures are retried, three attempts at most, honouring
 *   `Retry-After` up to 30 s. A redirect is a failure and is never followed. Answers are read under
 *   a byte cap and checked with arktype; a malformed hit fails the call. Nothing throws.
 *
 * @module
 */

import { type } from "arktype"
import { createReadTransport, getJson, type ReadClientOptions } from "./_read.ts"
import type { ShareResults } from "./share-results.ts"

const API = "https://hn.algolia.com/api/v1"
const ITEM_PAGE = "https://news.ycombinator.com/item?id="
const MAX_BYTES = 4 * 1024 * 1024
/** Stories asked for per address search: plenty for one address, cheap to read. */
export const HACKERNEWS_SEARCH_LIMIT = 100

/** Options for {@link readHackerNewsItemResults}: the story's id or its discussion address. */
export interface ReadHackerNewsItemResultsOptions extends ReadClientOptions {
  id?: number | string
  url?: string
}

/** Options for {@link findHackerNewsStoriesByUrl}. */
export interface FindHackerNewsStoriesByUrlOptions extends ReadClientOptions {
  /** The address the stories link to, `http` or `https`. */
  url: string
}

/** A story that links to the address asked for. */
export interface HackerNewsStoryRef {
  id: number
  /** `https://news.ycombinator.com/item?id=<id>` */
  url: string
  points: number | null
  comments: number | null
  /** ISO 8601, UTC. */
  createdAt: string
}

/** Outcome of {@link readHackerNewsItemResults}; `output: null` when no such story is indexed. */
export type HackerNewsResultsResult =
  | { success: true; output: ShareResults | null; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link findHackerNewsStoriesByUrl}; an empty list when nobody submitted it. */
export type HackerNewsFindResult =
  | { success: true; output: HackerNewsStoryRef[]; error: "" }
  | { success: false; output: null; error: string }

const failure = (error: string) => ({ success: false as const, output: null, error })

const Hit = type({
  objectID: /^[1-9]\d{0,15}$/,
  "points?": "number.integer | null",
  "num_comments?": "number.integer >= 0 | null",
  "url?": "string | null",
  created_at: "string",
})
const Search = type({ hits: Hit.array() })

const HEADERS = { Accept: "application/json" }

/** `input` as a positive integer id, or `undefined`. */
const toId = (input: unknown): number | undefined => {
  const text = typeof input === "number" ? String(input) : input
  return typeof text === "string" && /^[1-9]\d{0,15}$/.test(text) &&
      Number.isSafeInteger(Number(text))
    ? Number(text)
    : undefined
}

/** The story id in a `news.ycombinator.com/item?id=` address, or `undefined`. */
const idFromUrl = (input: string): number | undefined => {
  try {
    const url = new URL(input)
    return url.protocol === "https:" && url.hostname === "news.ycombinator.com" &&
        url.pathname === "/item"
      ? toId(url.searchParams.get("id"))
      : undefined
  } catch {
    return undefined
  }
}

/**
 * `input` without its scheme, `#fragment`, `utm_*` parameters and trailing slash, or `undefined`
 * when it is not an `http`/`https` URL. Two addresses that differ only in those match.
 */
const normalise = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key)
  }
  return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`
}

const toIso = (text: string): string | undefined => {
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * Reads a Hacker News story's points and comment count. Never throws.
 *
 * @example
 * ```ts
 * const read = await readHackerNewsItemResults({ url: "https://news.ycombinator.com/item?id=1" })
 * if (read.success && read.output !== null) console.log(read.output.score)
 * ```
 */
export const readHackerNewsItemResults = async (
  options: ReadHackerNewsItemResultsOptions,
): Promise<HackerNewsResultsResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  if ((options.id === undefined) === (options.url === undefined)) {
    return failure("invalid options: give exactly one of id and url")
  }
  const id = options.url !== undefined ? idFromUrl(options.url) : toId(options.id)
  if (id === undefined) {
    return failure(
      options.url !== undefined
        ? "invalid options: url is not a news.ycombinator.com/item?id= address"
        : "invalid options: id must be a positive integer",
    )
  }
  const transport = createReadTransport(options)
  if (typeof transport === "string") return failure(transport)

  const outcome = await getJson(transport, {
    service: "hacker news",
    url: `${API}/search?tags=story,story_${id}&hitsPerPage=1`,
    headers: new Headers(HEADERS),
    maxBytes: MAX_BYTES,
  })
  if (!outcome.ok) return failure(outcome.message)
  const search = Search(outcome.body)
  if (search instanceof type.errors) return failure("hacker news answer is not a search result")
  const hit = search.hits.find((entry) => Number(entry.objectID) === id)
  if (hit === undefined) return { success: true, output: null, error: "" }
  return {
    success: true,
    output: {
      views: null,
      reactions: null,
      comments: hit.num_comments ?? null,
      score: hit.points ?? null,
    },
    error: "",
  }
}

/**
 * Lists the Hacker News stories whose address is `url`, ignoring the scheme, a trailing slash,
 * the fragment and `utm_*` parameters, at most {@link HACKERNEWS_SEARCH_LIMIT}. Never throws.
 */
export const findHackerNewsStoriesByUrl = async (
  options: FindHackerNewsStoriesByUrlOptions,
): Promise<HackerNewsFindResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const wanted = normalise(options.url)
  if (wanted === undefined) return failure("invalid options: url must be an http or https URL")
  const transport = createReadTransport(options)
  if (typeof transport === "string") return failure(transport)

  const query = new URLSearchParams({
    query: wanted,
    restrictSearchableAttributes: "url",
    tags: "story",
    hitsPerPage: String(HACKERNEWS_SEARCH_LIMIT),
  })
  const outcome = await getJson(transport, {
    service: "hacker news",
    url: `${API}/search?${query}`,
    headers: new Headers(HEADERS),
    maxBytes: MAX_BYTES,
  })
  if (!outcome.ok) return failure(outcome.message)
  const search = Search(outcome.body)
  if (search instanceof type.errors) return failure("hacker news answer is not a search result")
  const stories: HackerNewsStoryRef[] = []
  for (const hit of search.hits) {
    if (normalise(hit.url) !== wanted) continue
    const createdAt = toIso(hit.created_at)
    if (createdAt === undefined) {
      return failure(`hacker news story ${hit.objectID} has no valid date`)
    }
    stories.push({
      id: Number(hit.objectID),
      url: `${ITEM_PAGE}${hit.objectID}`,
      points: hit.points ?? null,
      comments: hit.num_comments ?? null,
      createdAt,
    })
  }
  return { success: true, output: stories, error: "" }
}
