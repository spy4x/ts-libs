/**
 * Reddit: read how a submitted post did, and find the posts that link to an address. Read only,
 * through Reddit's public JSON, with no sign-in and no posting.
 *
 * - **`readRedditPostResults({ id | url, userAgent, fetch?, requestTimeoutMs?, sleep? })`** reads
 *   `https://www.reddit.com/by_id/t3_<id>.json` and answers the post's {@link ShareResults}:
 *   `comments` is `num_comments`, `score` is `score`, `views` and `reactions` are `null` (Reddit
 *   reports neither), plus `upvoteRatio`. The id comes from a post address such as
 *   `https://www.reddit.com/r/deno/comments/1abc2d/title/` or `https://redd.it/1abc2d`. `output`
 *   is `null` when Reddit lists no such post.
 * - **`findRedditPostsByUrl({ url, userAgent, … })`** reads
 *   `https://www.reddit.com/api/info.json?url=<url>&limit=100` and answers every submission of that
 *   exact address, `{ id, url, subreddit, createdAt }`, so a caller finds shares it did not record.
 * - **A descriptive `userAgent` is required**, such as `web:seedsaas.com:1.0 (by /u/name)`: Reddit
 *   blocks generic ones.
 * - **Reddit throttles unauthenticated reads.** `403` (Reddit refuses this host or user agent) is
 *   reported plainly and not retried. `429`, `5xx`, timeouts and transport failures are retried,
 *   three attempts at most, honouring `Retry-After` up to 30 s.
 * - A redirect is a failure and is never followed. Answers are read under a byte cap and checked
 *   with arktype; a malformed post fails the call rather than being skipped. Nothing throws.
 *
 * @module
 */

import { type } from "arktype"
import { createReadTransport, getJson, type ReadClientOptions } from "./_read.ts"
import type { ShareResults } from "./share-results.ts"

const ORIGIN = "https://www.reddit.com"
const MAX_POST_BYTES = 1024 * 1024
/** 100 posts, each with up to 40,000 characters of text. */
const MAX_LISTING_BYTES = 8 * 1024 * 1024
/** Submissions asked for at most: the most one `info.json` page holds. */
export const REDDIT_INFO_LIMIT = 100

const HINTS = {
  403: "Reddit refuses unauthenticated reads from this host or user agent",
  429: "rate limited; Reddit allows few unauthenticated reads",
}

/** Printable ASCII, so `Headers` cannot throw on it. */
const AGENT_SHAPE = /^[\x20-\x7E]{1,256}$/
const ID_SHAPE = /^[a-z0-9]{1,16}$/
const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"])

/** Settings both calls share. */
export interface RedditClientOptions extends ReadClientOptions {
  /** Sent as `User-Agent`, e.g. `web:seedsaas.com:1.0 (by /u/name)`. Required. */
  userAgent: string
}

/** Options for {@link readRedditPostResults}: the post's id (`1abc2d` or `t3_1abc2d`) or address. */
export interface ReadRedditPostResultsOptions extends RedditClientOptions {
  id?: string
  url?: string
}

/** Options for {@link findRedditPostsByUrl}. */
export interface FindRedditPostsByUrlOptions extends RedditClientOptions {
  /** The address the posts link to, `http` or `https`. Reddit matches it exactly. */
  url: string
}

/** A post's {@link ShareResults}, plus the share of its votes that are upvotes (0 to 1). */
export interface RedditPostResults extends ShareResults {
  upvoteRatio: number | null
}

/** A submission that links to the address asked for. */
export interface RedditPostRef {
  /** Base-36 id without the `t3_` prefix. */
  id: string
  /** `https://www.reddit.com/r/<subreddit>/comments/<id>/…/` */
  url: string
  subreddit: string
  /** ISO 8601, UTC. */
  createdAt: string
}

/** Outcome of {@link readRedditPostResults}; `output: null` when Reddit lists no such post. */
export type RedditResultsResult =
  | { success: true; output: RedditPostResults | null; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link findRedditPostsByUrl}; an empty list when nobody submitted the address. */
export type RedditFindResult =
  | { success: true; output: RedditPostRef[]; error: "" }
  | { success: false; output: null; error: string }

const failure = (error: string) => ({ success: false as const, output: null, error })

const Listing = type({
  data: { children: type({ kind: "string", data: "object" }).array() },
})

const Post = type({
  id: ID_SHAPE,
  num_comments: "number.integer >= 0",
  score: "number.integer",
  "upvote_ratio?": "0 <= number <= 1",
  permalink: /^\/r\/[^/]/,
  subreddit: "string > 0",
  // Bounded so `toISOString` cannot throw on an absurd date.
  created_utc: "0 <= number < 100000000000",
})
type Post = typeof Post.infer

/** The base-36 post id in a Reddit post address, or `undefined`. */
const postIdFromUrl = (input: string): string | undefined => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  const parts = url.pathname.split("/").filter((part) => part !== "")
  let id: string | undefined
  if (url.hostname === "redd.it" && parts.length === 1) id = parts[0]
  if (REDDIT_HOSTS.has(url.hostname)) {
    // `/r/<subreddit>/comments/<id>/…` or `/comments/<id>/…`
    const at = parts[0] === "r" ? 2 : 0
    if (parts[at] === "comments") id = parts[at + 1]
  }
  return id !== undefined && ID_SHAPE.test(id.toLowerCase()) ? id.toLowerCase() : undefined
}

/** Reads a listing's `t3` children; a malformed one fails the whole listing. */
const posts = (body: unknown): Post[] | string => {
  const listing = Listing(body)
  if (listing instanceof type.errors) return "reddit answer is not a listing"
  const found: Post[] = []
  for (const child of listing.data.children) {
    if (child.kind !== "t3") continue
    const post = Post(child.data)
    if (post instanceof type.errors) return `reddit answer has a malformed post: ${post.summary}`
    found.push(post)
  }
  return found
}

const headersFor = (userAgent: string) =>
  new Headers({ "User-Agent": userAgent, Accept: "application/json" })

const checkAgent = (options: RedditClientOptions): string | undefined =>
  typeof options.userAgent === "string" && AGENT_SHAPE.test(options.userAgent) &&
    options.userAgent.trim() !== ""
    ? undefined
    : "invalid options: userAgent must be a descriptive printable ASCII string of at most 256 characters"

/**
 * Reads a Reddit post's comments, score and upvote ratio. Never throws.
 *
 * @example
 * ```ts
 * const read = await readRedditPostResults({
 *   url: "https://www.reddit.com/r/Deno/comments/1abc2d/my_post/",
 *   userAgent: "web:seedsaas.com:1.0 (by /u/name)",
 * })
 * if (read.success && read.output !== null) console.log(read.output.score)
 * ```
 */
export const readRedditPostResults = async (
  options: ReadRedditPostResultsOptions,
): Promise<RedditResultsResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const agentError = checkAgent(options)
  if (agentError !== undefined) return failure(agentError)
  if ((options.id === undefined) === (options.url === undefined)) {
    return failure("invalid options: give exactly one of id and url")
  }
  const id = options.url !== undefined
    ? postIdFromUrl(options.url)
    : typeof options.id === "string"
    ? options.id.replace(/^t3_/, "")
    : undefined
  if (id === undefined || !ID_SHAPE.test(id)) {
    return failure(
      options.url !== undefined
        ? "invalid options: url is not a Reddit post address"
        : "invalid options: id must be a base-36 Reddit post id",
    )
  }
  const transport = createReadTransport(options)
  if (typeof transport === "string") return failure(transport)

  const outcome = await getJson(transport, {
    service: "reddit",
    url: `${ORIGIN}/by_id/t3_${id}.json`,
    headers: headersFor(options.userAgent),
    maxBytes: MAX_POST_BYTES,
    hints: HINTS,
  })
  if (!outcome.ok) return failure(outcome.message)
  const found = posts(outcome.body)
  if (typeof found === "string") return failure(found)
  const post = found.find((entry) => entry.id === id)
  if (post === undefined) return { success: true, output: null, error: "" }
  return {
    success: true,
    output: {
      views: null,
      reactions: null,
      comments: post.num_comments,
      score: post.score,
      upvoteRatio: post.upvote_ratio ?? null,
    },
    error: "",
  }
}

/**
 * Lists the Reddit submissions of `url`, newest data Reddit has, at most
 * {@link REDDIT_INFO_LIMIT}. Never throws.
 *
 * Reddit matches the address exactly: `https://a.com/x` and `https://a.com/x/` are different
 * addresses, so a caller that shares with `utm_*` tags looks each tagged address up.
 */
export const findRedditPostsByUrl = async (
  options: FindRedditPostsByUrlOptions,
): Promise<RedditFindResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const agentError = checkAgent(options)
  if (agentError !== undefined) return failure(agentError)
  let target: URL
  try {
    target = new URL(options.url)
  } catch {
    return failure("invalid options: url must be an http or https URL")
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return failure("invalid options: url must be an http or https URL")
  }
  const transport = createReadTransport(options)
  if (typeof transport === "string") return failure(transport)

  const query = new URLSearchParams({ url: options.url, limit: String(REDDIT_INFO_LIMIT) })
  const outcome = await getJson(transport, {
    service: "reddit",
    url: `${ORIGIN}/api/info.json?${query}`,
    headers: headersFor(options.userAgent),
    maxBytes: MAX_LISTING_BYTES,
    hints: HINTS,
  })
  if (!outcome.ok) return failure(outcome.message)
  const found = posts(outcome.body)
  if (typeof found === "string") return failure(found)
  return {
    success: true,
    output: found.map((post) => ({
      id: post.id,
      url: `${ORIGIN}${post.permalink}`,
      subreddit: post.subreddit,
      createdAt: new Date(post.created_utc * 1000).toISOString(),
    })),
    error: "",
  }
}
