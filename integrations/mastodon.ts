/**
 * Mastodon: post a status and read back how it did.
 *
 * - **`postMastodonStatus({ instanceUrl, accessToken, status, idempotencyKey, language?,
 *   visibility?, fetch?, requestTimeoutMs?, sleep? })`** posts `{ status, visibility?, language? }`
 *   to `<instance>/api/v1/statuses` with `Authorization: Bearer` and answers `output: { id, url }`.
 * - **`readMastodonStatusResults({ instanceUrl, accessToken?, statusId, … })`** reads
 *   `GET /api/v1/statuses/:id` and answers `{ views: null, reactions, comments, score: null,
 *   favourites, reblogs }`. `reactions` is `favourites_count` alone, the way Bluesky's likes and
 *   Dev.to's reactions are counted; reblogs are shares, kept apart in `reblogs`. `comments` is
 *   `replies_count`. Without a token only a public or unlisted status can be read.
 * - **Posting may be retried.** The request carries the `Idempotency-Key` header Mastodon
 *   documents (https://docs.joinmastodon.org/methods/statuses/#create): the server keeps the key
 *   for an hour and answers a repeat with the same status instead of making a second one. So
 *   `5xx`, timeouts and dropped connections are retried like `429`, and a caller that retries a
 *   failed run passes the same key. After an hour a repeat posts again.
 * - **The token stays secret.** It is sent only in its header, a redirect is refused rather than
 *   followed, transport errors carry only the error class, and Mastodon's error text is cleaned,
 *   capped at 200 characters and has the token replaced by `<REDACTED:TOKEN>`.
 * - **Answers are checked.** Bodies are read under a byte cap and validated with arktype.
 *   `instanceUrl` must be a bare `https` origin, and a status `url` that is not `https` is refused.
 * - `429` is waited out with `Retry-After`, up to 30 s; three attempts at most. Both functions
 *   answer `{ success, output, error }` and never throw.
 *
 * @example
 * ```ts
 * const posted = await postMastodonStatus({
 *   instanceUrl: "https://mastodon.social",
 *   accessToken,
 *   status: "New post: https://example.com/blog/hello",
 *   idempotencyKey: postId,
 * })
 * if (!posted.success) console.warn(posted.error)
 * ```
 *
 * @module
 */

import { type } from "arktype"
import {
  createJsonTransport,
  failure,
  httpsOrigin,
  type JsonClientOptions,
  sendJson,
  TOKEN_SHAPE,
  webUrl,
} from "./_json-request.ts"

const SERVICE = "mastodon"
const MAX_STATUS_BYTES = 1024 * 1024

/** Who sees a status; Mastodon's four values. */
export type MastodonVisibility = "public" | "unlisted" | "private" | "direct"

/** Settings both calls share. */
export interface MastodonClientOptions extends JsonClientOptions {
  /** The instance's address, a bare `https` origin such as `https://mastodon.social`. */
  instanceUrl: string
}

/** Options for {@link postMastodonStatus}. */
export interface PostMastodonStatusOptions extends MastodonClientOptions {
  /** An access token with the `write:statuses` scope. Never logged. */
  accessToken: string
  /** The text. The instance sets the length limit (500 characters by default). */
  status: string
  /**
   * Sent as `Idempotency-Key`: the same key within an hour answers the same status. Use one key
   * per thing posted, such as the blog post's id. Printable ASCII, at most 256 characters.
   */
  idempotencyKey: string
  /** ISO 639 language code, such as `en`. */
  language?: string
  /** `public` when left out, or whatever the account's default is. */
  visibility?: MastodonVisibility
}

/** Options for {@link readMastodonStatusResults}. */
export interface ReadMastodonStatusResultsOptions extends MastodonClientOptions {
  /** Needed only for a private or direct status. Never logged. */
  accessToken?: string
  statusId: string
}

/** A posted status: its id on the instance and its public address. */
export interface MastodonStatusRef {
  id: string
  url: string
}

/**
 * How a copy did, in the shape every channel answers. Structurally identical to `ShareResults`
 * from `@spy4x/integrations/share-results`; `null` means Mastodon does not report it.
 */
export interface MastodonResults {
  views: number | null
  reactions: number | null
  comments: number | null
  score: number | null
}

/** {@link MastodonResults} with Mastodon's own counts. */
export interface MastodonStatusResults extends MastodonResults {
  views: null
  reactions: number
  comments: number
  score: null
  favourites: number
  reblogs: number
}

/** Outcome of {@link postMastodonStatus}. */
export type MastodonPostResult =
  | { success: true; output: MastodonStatusRef; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link readMastodonStatusResults}. */
export type MastodonResultsResult =
  | { success: true; output: MastodonStatusResults; error: "" }
  | { success: false; output: null; error: string }

const PostInput = type({
  status: "string > 0",
  idempotencyKey: /^[\x21-\x7E]{1,256}$/,
  "language?": /^[a-zA-Z]{2,3}$/,
  "visibility?": "'public' | 'unlisted' | 'private' | 'direct'",
})

const StatusRef = type({ id: "string > 0", "url?": "string | null", uri: "string" })

const Count = "number.integer >= 0"
const StatusCounts = type({
  favourites_count: Count,
  reblogs_count: Count,
  replies_count: Count,
})

/** Checks the shared options; returns the origin, or why it is invalid. */
const prepare = (options: MastodonClientOptions, token: unknown, required: boolean) => {
  if (typeof options !== "object" || options === null) {
    return "invalid options: expected an options object"
  }
  const origin = httpsOrigin(options.instanceUrl)
  if (origin === undefined) {
    return "invalid options: instanceUrl must be an https origin with no path"
  }
  if (
    (required || token !== undefined) && (typeof token !== "string" || !TOKEN_SHAPE.test(token))
  ) {
    return "invalid options: accessToken must be a non-empty string without spaces"
  }
  const transport = createJsonTransport(options)
  return typeof transport === "string" ? transport : { origin, transport }
}

const headersFor = (token: string | undefined): Headers => {
  const headers = new Headers({ Accept: "application/json" })
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`)
  return headers
}

/**
 * Posts a status and returns its id and address. Never throws.
 *
 * Every failure that may have posted (a `5xx`, a timeout, a dropped connection) is retried with
 * the same `Idempotency-Key`, so the instance makes one status at most. A `4xx` or a redirect
 * means nothing was posted.
 */
export const postMastodonStatus = async (
  options: PostMastodonStatusOptions,
): Promise<MastodonPostResult> => {
  const prepared = prepare(options, options?.accessToken, true)
  if (typeof prepared === "string") return failure(prepared)
  const input = PostInput({
    status: options.status,
    idempotencyKey: options.idempotencyKey,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
  })
  if (input instanceof type.errors) return failure(`invalid status: ${input.summary}`)

  const headers = headersFor(options.accessToken)
  headers.set("Content-Type", "application/json")
  headers.set("Idempotency-Key", input.idempotencyKey)
  const outcome = await sendJson(prepared.transport, {
    service: SERVICE,
    method: "POST",
    url: `${prepared.origin}/api/v1/statuses`,
    headers,
    body: JSON.stringify({
      status: input.status,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.language === undefined ? {} : { language: input.language }),
    }),
    maxBytes: MAX_STATUS_BYTES,
    idempotent: true,
    secrets: [options.accessToken],
  })
  if (!outcome.ok) {
    return failure(
      outcome.uncertain
        ? `${outcome.message}; the status may exist, retry with the same idempotencyKey`
        : outcome.message,
    )
  }
  const parsed = StatusRef(outcome.body)
  if (parsed instanceof type.errors) {
    return failure("mastodon answer has no status id; retry with the same idempotencyKey")
  }
  // `url` is the page people open; `uri` is the ActivityPub id, used only when `url` is missing.
  const url = parsed.url ?? parsed.uri
  if (webUrl(url)?.protocol !== "https:") {
    return failure(`mastodon status ${parsed.id} has no https url`)
  }
  return { success: true, output: { id: parsed.id, url }, error: "" }
}

/** Reads a status's favourites, reblogs and replies. Never throws. */
export const readMastodonStatusResults = async (
  options: ReadMastodonStatusResultsOptions,
): Promise<MastodonResultsResult> => {
  const prepared = prepare(options, options?.accessToken, false)
  if (typeof prepared === "string") return failure(prepared)
  if (typeof options.statusId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(options.statusId)) {
    return failure("invalid options: statusId must be a Mastodon status id")
  }
  const outcome = await sendJson(prepared.transport, {
    service: SERVICE,
    method: "GET",
    url: `${prepared.origin}/api/v1/statuses/${options.statusId}`,
    headers: headersFor(options.accessToken),
    maxBytes: MAX_STATUS_BYTES,
    idempotent: true,
    secrets: options.accessToken === undefined ? [] : [options.accessToken],
  })
  if (!outcome.ok) return failure(outcome.message)
  const counts = StatusCounts(outcome.body)
  if (counts instanceof type.errors) return failure("mastodon answer has no valid counts")
  return {
    success: true,
    output: {
      views: null,
      reactions: counts.favourites_count,
      comments: counts.replies_count,
      score: null,
      favourites: counts.favourites_count,
      reblogs: counts.reblogs_count,
    },
    error: "",
  }
}
