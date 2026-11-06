/**
 * Bluesky (AT Protocol): sign in with an app password, post a link with its card, find that post
 * again, and read back how it did.
 *
 * - **`createBlueskySession({ service?, identifier, appPassword, … })`** calls
 *   `com.atproto.server.createSession` on `service` (`https://bsky.social` by default) and answers
 *   `{ service, did, handle, accessJwt }`. The access token lasts about two hours and is not
 *   refreshed here: sign in once per run.
 * - **`uploadBlueskyBlob({ session, data, mimeType, … })`** uploads a card image
 *   (`com.atproto.repo.uploadBlob`, an image of at most 1,000,000 bytes) and answers the blob to
 *   pass as `link.thumbBlob`.
 * - **`postBlueskyLink({ session, text, link: { uri, title, description, thumbBlob? }, langs?,
 *   createdAt?, … })`** creates an `app.bsky.feed.post` record (`com.atproto.repo.createRecord`)
 *   with an `app.bsky.embed.external` card. When `link.uri` appears in `text`, its first
 *   occurrence gets a link facet, with the UTF-8 byte offsets the protocol counts in. Text over
 *   300 graphemes or 3,000 UTF-8 bytes is refused, as the post lexicon limits it. Answers
 *   `{ uri, cid, url }`: the `at://` address, the record's content id and the
 *   `https://bsky.app/profile/<did>/post/<rkey>` page.
 * - **`findBlueskyPostByLink({ actor, uri, maxPages?, … })`** reads the author's feed
 *   (`app.bsky.feed.getAuthorFeed`, 100 posts a page, {@link BLUESKY_FEED_PAGES} pages by default)
 *   and answers the author's own post whose card or link facet points at `uri`, or `null`.
 *   `actor` is a DID or handle; pass `session.did`.
 * - **`readBlueskyPostResults({ uri, … })`** reads `app.bsky.feed.getPosts` and answers
 *   `{ views: null, reactions: likes, comments: replies, score: null, reposts, quotes }`.
 * - **Look up before posting.** Creating a record is not idempotent: only `429` is retried, and
 *   after a `5xx`, a timeout or a dropped connection the error says the post may exist. The
 *   lookup only sees posts the AppView has indexed, which takes a few seconds after a post.
 * - **Reading needs no token.** The lookup and the results go to the public AppView
 *   (`https://public.api.bsky.app` by default), with no `Authorization` header.
 * - **Secrets stay secret.** The app password goes only into the sign-in body and the access
 *   token only into its header; a redirect is refused rather than followed, transport errors carry
 *   only the error class, and the server's error text is cleaned, capped at 200 characters and has
 *   both replaced by `<REDACTED:TOKEN>`.
 * - **Answers are checked.** Bodies are read under a byte cap and validated with arktype; every
 *   host setting must be a bare `https` origin.
 * - `429` is waited out with `Retry-After`, up to 30 s; reads, sign-in and uploads also retry
 *   `5xx` and timeouts. Three attempts at most. Every function answers `{ success, output, error }`
 *   and never throws.
 *
 * @example
 * ```ts
 * const signedIn = await createBlueskySession({ identifier: "seed.example.com", appPassword })
 * if (!signedIn.success) throw new Error(signedIn.error)
 * const session = signedIn.output
 * const found = await findBlueskyPostByLink({ actor: session.did, uri: postUrl })
 * if (found.success && found.output === null) {
 *   await postBlueskyLink({
 *     session,
 *     text: `New post: ${postUrl}`,
 *     link: { uri: postUrl, title, description },
 *   })
 * }
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
  type JsonOutcome,
  sendJson,
  TOKEN_SHAPE,
  webUrl,
} from "./_json-request.ts"
import type { PostTransport } from "./_post.ts"

const SERVICE = "bluesky"

/** Where an account signs in when no `service` is given. */
export const BLUESKY_DEFAULT_SERVICE = "https://bsky.social"

/** The public AppView, which answers reads without a token. */
export const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app"

/** The post lexicon's limit on `text`, in graphemes. */
export const BLUESKY_MAX_GRAPHEMES = 300

/** The post lexicon's limit on `text`, in UTF-8 bytes. */
export const BLUESKY_MAX_TEXT_BYTES = 3000

/** The largest image an external card's `thumb` takes. */
export const BLUESKY_MAX_THUMB_BYTES = 1_000_000

/** Feed pages {@link findBlueskyPostByLink} reads by default: the latest 1,000 posts. */
export const BLUESKY_FEED_PAGES = 10

const FEED_PAGE_SIZE = 100
const MAX_PAGES_LIMIT = 100
const MAX_SMALL_BYTES = 256 * 1024
const MAX_PAGE_BYTES = 8 * 1024 * 1024

/** A signed-in account. `accessJwt` is a credential: never log or store it. */
export interface BlueskySession {
  /** The host the session was made on; writes go there. */
  service: string
  did: string
  handle: string
  accessJwt: string
}

/** An uploaded blob, as the protocol references it from a record. */
export interface BlueskyBlob {
  $type: "blob"
  ref: { $link: string }
  mimeType: string
  size: number
}

/** The link card. */
export interface BlueskyLinkCard {
  /** The address the card opens, `http` or `https`. */
  uri: string
  title: string
  description: string
  /** The card image, from {@link uploadBlueskyBlob}. */
  thumbBlob?: BlueskyBlob
}

/** A post: its `at://` address, content id and public page. */
export interface BlueskyPostRef {
  uri: string
  cid: string
  url: string
}

/**
 * How a copy did, in the shape every channel answers. Structurally identical to `ShareResults`
 * from `@spy4x/integrations/share-results`; `null` means Bluesky does not report it.
 */
export interface BlueskyResults {
  views: number | null
  reactions: number | null
  comments: number | null
  score: number | null
}

/** {@link BlueskyResults} with Bluesky's own counts: likes are `reactions`, replies `comments`. */
export interface BlueskyPostResults extends BlueskyResults {
  views: null
  score: null
  reposts: number | null
  quotes: number | null
}

/** Options for {@link createBlueskySession}. */
export interface CreateBlueskySessionOptions extends JsonClientOptions {
  /** The account's host, a bare `https` origin; {@link BLUESKY_DEFAULT_SERVICE} by default. */
  service?: string
  /** Handle, DID or email. */
  identifier: string
  /** An app password from Settings → App passwords, never the account password. Never logged. */
  appPassword: string
}

/** Options for {@link uploadBlueskyBlob}. */
export interface UploadBlueskyBlobOptions extends JsonClientOptions {
  session: BlueskySession
  data: Uint8Array<ArrayBuffer>
  /** An image type, such as `image/png`. */
  mimeType: string
}

/** Options for {@link postBlueskyLink}. */
export interface PostBlueskyLinkOptions extends JsonClientOptions {
  session: BlueskySession
  text: string
  link: BlueskyLinkCard
  /** Up to three language tags, such as `en` or `pt-BR`. */
  langs?: readonly string[]
  /** An ISO 8601 timestamp; now when left out. */
  createdAt?: string
}

/** Options for {@link findBlueskyPostByLink}. */
export interface FindBlueskyPostByLinkOptions extends JsonClientOptions {
  /** The author: a DID or a handle. */
  actor: string
  /** The address the post links to. */
  uri: string
  /** Feed pages to read, 100 posts each; {@link BLUESKY_FEED_PAGES} by default, 100 at most. */
  maxPages?: number
  /** A bare `https` origin; {@link BLUESKY_PUBLIC_APPVIEW} by default. */
  appView?: string
}

/** Options for {@link readBlueskyPostResults}. */
export interface ReadBlueskyPostResultsOptions extends JsonClientOptions {
  /** The post's `at://` address. */
  uri: string
  /** A bare `https` origin; {@link BLUESKY_PUBLIC_APPVIEW} by default. */
  appView?: string
}

/** Outcome of {@link createBlueskySession}. */
export type BlueskySessionResult =
  | { success: true; output: BlueskySession; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link uploadBlueskyBlob}. */
export type BlueskyBlobResult =
  | { success: true; output: BlueskyBlob; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link postBlueskyLink}. */
export type BlueskyPostResult =
  | { success: true; output: BlueskyPostRef; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link findBlueskyPostByLink}: `null` when none of the pages read has the link. */
export type BlueskyFindResult =
  | { success: true; output: BlueskyPostRef | null; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link readBlueskyPostResults}. */
export type BlueskyResultsResult =
  | { success: true; output: BlueskyPostResults; error: "" }
  | { success: false; output: null; error: string }

const POST_URI =
  /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/
const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/
const HANDLE = /^[A-Za-z0-9.-]{1,253}$/
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/

const Blob = type({
  $type: "'blob'",
  ref: { $link: "string > 0" },
  mimeType: "string > 0",
  size: "number.integer >= 0",
})

const Session = type({ did: DID, handle: "string > 0", accessJwt: TOKEN_SHAPE })
const SessionInput = type({
  service: "string",
  did: DID,
  handle: "string",
  accessJwt: TOKEN_SHAPE,
})

const LinkInput = type({
  uri: "string",
  title: "string",
  description: "string",
  "thumbBlob?": Blob,
})

const Created = type({ uri: POST_URI, cid: "string > 0" })

const LinkFeature = type({ $type: "string", "uri?": "unknown" })
const PostRecord = type({
  "embed?": type({ $type: "string", "external?": { uri: "unknown" } }),
  "facets?": type({ features: LinkFeature.array() }).array(),
})
const FeedPage = type({
  "cursor?": "string",
  feed: type({
    post: {
      uri: "string",
      cid: "string",
      author: { did: "string", handle: "string" },
      record: "unknown",
    },
  }).array(),
})

const Count = "number.integer >= 0"
const Posts = type({
  posts: type({
    uri: "string",
    "likeCount?": Count,
    "replyCount?": Count,
    "repostCount?": Count,
    "quoteCount?": Count,
  }).array(),
})

/** The `https://bsky.app` page of an `at://` post address. */
const toRef = (uri: string, cid: string): BlueskyPostRef | undefined => {
  const match = POST_URI.exec(uri)
  if (match === null) return undefined
  return { uri, cid, url: `https://bsky.app/profile/${match[1]}/post/${match[2]}` }
}

/** Graphemes as people count them: one emoji or accented letter is one. */
const graphemeCount = (text: string): number => {
  let count = 0
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count++
  return count
}

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength

/** A link facet over the first occurrence of `uri` in `text`, or `undefined`. */
const linkFacet = (text: string, uri: string) => {
  const at = text.indexOf(uri)
  if (at === -1) return undefined
  const byteStart = utf8(text.slice(0, at))
  return {
    index: { byteStart, byteEnd: byteStart + utf8(uri) },
    features: [{ $type: "app.bsky.richtext.facet#link", uri }],
  }
}

const transportOf = (options: JsonClientOptions): PostTransport | string =>
  typeof options !== "object" || options === null
    ? "invalid options: expected an options object"
    : createJsonTransport(options)

/** Checks a session passed in; returns its write host, or why it is invalid. */
const checkSession = (session: unknown) => {
  const parsed = SessionInput(session)
  if (parsed instanceof type.errors) return "invalid options: session is not a Bluesky session"
  const service = httpsOrigin(parsed.service)
  if (service === undefined) return "invalid options: session.service must be an https origin"
  return { service, did: parsed.did, accessJwt: parsed.accessJwt }
}

const authorized = (accessJwt: string): Headers =>
  new Headers({ Accept: "application/json", Authorization: `Bearer ${accessJwt}` })

/** Signs in with an app password. Never throws. */
export const createBlueskySession = async (
  options: CreateBlueskySessionOptions,
): Promise<BlueskySessionResult> => {
  const transport = transportOf(options)
  if (typeof transport === "string") return failure(transport)
  const service = httpsOrigin(options.service ?? BLUESKY_DEFAULT_SERVICE)
  if (service === undefined) return failure("invalid options: service must be an https origin")
  if (typeof options.identifier !== "string" || options.identifier.trim() === "") {
    return failure("invalid options: identifier must be a non-empty string")
  }
  if (typeof options.appPassword !== "string" || options.appPassword === "") {
    return failure("invalid options: appPassword must be a non-empty string")
  }
  const outcome = await sendJson(transport, {
    service: SERVICE,
    method: "POST",
    url: `${service}/xrpc/com.atproto.server.createSession`,
    headers: new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
    body: JSON.stringify({ identifier: options.identifier, password: options.appPassword }),
    maxBytes: MAX_SMALL_BYTES,
    // A second session is harmless, so a lost answer may be asked again.
    idempotent: true,
    secrets: [options.appPassword],
  })
  if (!outcome.ok) return failure(outcome.message)
  const parsed = Session(outcome.body)
  if (parsed instanceof type.errors) return failure("bluesky sign-in answer has no did and token")
  return {
    success: true,
    output: { service, did: parsed.did, handle: parsed.handle, accessJwt: parsed.accessJwt },
    error: "",
  }
}

/** Uploads an image for a link card. Never throws. */
export const uploadBlueskyBlob = async (
  options: UploadBlueskyBlobOptions,
): Promise<BlueskyBlobResult> => {
  const transport = transportOf(options)
  if (typeof transport === "string") return failure(transport)
  const session = checkSession(options.session)
  if (typeof session === "string") return failure(session)
  if (!(options.data instanceof Uint8Array) || options.data.byteLength === 0) {
    return failure("invalid options: data must be a non-empty Uint8Array")
  }
  if (options.data.byteLength > BLUESKY_MAX_THUMB_BYTES) {
    return failure(`invalid options: data is over ${BLUESKY_MAX_THUMB_BYTES} bytes`)
  }
  if (typeof options.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/.test(options.mimeType)) {
    return failure("invalid options: mimeType must be an image type")
  }
  const headers = authorized(session.accessJwt)
  headers.set("Content-Type", options.mimeType)
  const outcome = await sendJson(transport, {
    service: SERVICE,
    method: "POST",
    url: `${session.service}/xrpc/com.atproto.repo.uploadBlob`,
    headers,
    body: options.data,
    maxBytes: MAX_SMALL_BYTES,
    // Blobs are addressed by their content: the same bytes twice are one blob.
    idempotent: true,
    secrets: [session.accessJwt],
  })
  if (!outcome.ok) return failure(outcome.message)
  const parsed = type({ blob: Blob })(outcome.body)
  if (parsed instanceof type.errors) return failure("bluesky upload answer has no blob")
  return { success: true, output: parsed.blob, error: "" }
}

/** Posts `text` with a link card. Not idempotent: look the link up first. Never throws. */
export const postBlueskyLink = async (
  options: PostBlueskyLinkOptions,
): Promise<BlueskyPostResult> => {
  const transport = transportOf(options)
  if (typeof transport === "string") return failure(transport)
  const session = checkSession(options.session)
  if (typeof session === "string") return failure(session)
  const { text } = options
  if (typeof text !== "string" || text.trim() === "") {
    return failure("invalid post: text must be a non-empty string")
  }
  if (graphemeCount(text) > BLUESKY_MAX_GRAPHEMES || utf8(text) > BLUESKY_MAX_TEXT_BYTES) {
    return failure(
      `invalid post: text is over ${BLUESKY_MAX_GRAPHEMES} graphemes or ${BLUESKY_MAX_TEXT_BYTES} bytes`,
    )
  }
  const link = LinkInput(options.link)
  if (link instanceof type.errors) return failure(`invalid link: ${link.summary}`)
  if (webUrl(link.uri) === undefined) {
    return failure("invalid link: uri must be an http or https URL")
  }
  const langs = options.langs ?? []
  if (!Array.isArray(langs) || langs.length > 3 || !langs.every((l) => LANG.test(l))) {
    return failure("invalid post: langs must be at most three language tags")
  }
  const createdAt = options.createdAt ?? new Date().toISOString()
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return failure("invalid post: createdAt must be an ISO 8601 timestamp")
  }

  const facet = linkFacet(text, link.uri)
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt,
    ...(langs.length === 0 ? {} : { langs }),
    ...(facet === undefined ? {} : { facets: [facet] }),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: link.uri,
        title: link.title,
        description: link.description,
        ...(link.thumbBlob === undefined ? {} : { thumb: link.thumbBlob }),
      },
    },
  }
  const headers = authorized(session.accessJwt)
  headers.set("Content-Type", "application/json")
  const outcome = await sendJson(transport, {
    service: SERVICE,
    method: "POST",
    url: `${session.service}/xrpc/com.atproto.repo.createRecord`,
    headers,
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
    maxBytes: MAX_SMALL_BYTES,
    idempotent: false,
    secrets: [session.accessJwt],
  })
  if (!outcome.ok) {
    return failure(
      outcome.uncertain
        ? `${outcome.message}; the post may exist, look it up before posting again`
        : outcome.message,
    )
  }
  const parsed = Created(outcome.body)
  const ref = parsed instanceof type.errors ? undefined : toRef(parsed.uri, parsed.cid)
  if (ref === undefined) {
    return failure("bluesky answer has no post uri and cid; the post may exist, look it up")
  }
  return { success: true, output: ref, error: "" }
}

/** Whether a feed record's card or one of its link facets points at `wanted`. */
const linksTo = (record: unknown, wanted: string): boolean => {
  const parsed = PostRecord(record)
  if (parsed instanceof type.errors) return false
  const same = (uri: unknown) => webUrl(uri)?.href === wanted
  if (parsed.embed?.$type === "app.bsky.embed.external" && same(parsed.embed.external?.uri)) {
    return true
  }
  return (parsed.facets ?? []).some((facet) =>
    facet.features.some((f) => f.$type === "app.bsky.richtext.facet#link" && same(f.uri))
  )
}

const readFrom = (transport: PostTransport, url: string): Promise<JsonOutcome> =>
  sendJson(transport, {
    service: SERVICE,
    method: "GET",
    url,
    headers: new Headers({ Accept: "application/json" }),
    maxBytes: MAX_PAGE_BYTES,
    idempotent: true,
    secrets: [],
  })

/**
 * Finds the author's own post that links to `uri`, among the latest `maxPages` pages of their
 * feed. Reposts of other people's posts are skipped. A malformed page fails the lookup rather
 * than reading as "not found", so a caller never posts twice because of an answer it could not
 * read. Never throws.
 */
export const findBlueskyPostByLink = async (
  options: FindBlueskyPostByLinkOptions,
): Promise<BlueskyFindResult> => {
  const transport = transportOf(options)
  if (typeof transport === "string") return failure(transport)
  const appView = httpsOrigin(options.appView ?? BLUESKY_PUBLIC_APPVIEW)
  if (appView === undefined) return failure("invalid options: appView must be an https origin")
  const actor = options.actor
  if (typeof actor !== "string" || !(DID.test(actor) || HANDLE.test(actor))) {
    return failure("invalid options: actor must be a DID or a handle")
  }
  const wanted = webUrl(options.uri)?.href
  if (wanted === undefined) return failure("invalid options: uri must be an http or https URL")
  const maxPages = options.maxPages ?? BLUESKY_FEED_PAGES
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    return failure(`invalid options: maxPages must be an integer from 1 to ${MAX_PAGES_LIMIT}`)
  }

  const isAuthor = (author: { did: string; handle: string }) =>
    author.did === actor || author.handle.toLowerCase() === actor.toLowerCase()
  let cursor: string | undefined
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ actor, limit: String(FEED_PAGE_SIZE) })
    if (cursor !== undefined) query.set("cursor", cursor)
    const outcome = await readFrom(
      transport,
      `${appView}/xrpc/app.bsky.feed.getAuthorFeed?${query}`,
    )
    if (!outcome.ok) return failure(outcome.message)
    const parsed = FeedPage(outcome.body)
    if (parsed instanceof type.errors) return failure(`bluesky feed page ${page} is malformed`)
    const match = parsed.feed.find(({ post }) =>
      isAuthor(post.author) && linksTo(post.record, wanted)
    )
    if (match !== undefined) {
      const ref = toRef(match.post.uri, match.post.cid)
      if (ref === undefined) return failure("bluesky feed has a post with an invalid uri")
      return { success: true, output: ref, error: "" }
    }
    if (parsed.cursor === undefined || parsed.feed.length === 0) break
    cursor = parsed.cursor
  }
  return { success: true, output: null, error: "" }
}

/** Reads a post's likes, replies, reposts and quotes from the public AppView. Never throws. */
export const readBlueskyPostResults = async (
  options: ReadBlueskyPostResultsOptions,
): Promise<BlueskyResultsResult> => {
  const transport = transportOf(options)
  if (typeof transport === "string") return failure(transport)
  const appView = httpsOrigin(options.appView ?? BLUESKY_PUBLIC_APPVIEW)
  if (appView === undefined) return failure("invalid options: appView must be an https origin")
  if (typeof options.uri !== "string" || !POST_URI.test(options.uri)) {
    return failure("invalid options: uri must be an at:// post address")
  }
  const query = new URLSearchParams({ uris: options.uri })
  const outcome = await readFrom(transport, `${appView}/xrpc/app.bsky.feed.getPosts?${query}`)
  if (!outcome.ok) return failure(outcome.message)
  const parsed = Posts(outcome.body)
  if (parsed instanceof type.errors) return failure("bluesky answer is not a list of posts")
  const post = parsed.posts.find((entry) => entry.uri === options.uri)
  if (post === undefined) return failure("bluesky post not found; it may have been deleted")
  return {
    success: true,
    output: {
      views: null,
      reactions: post.likeCount ?? null,
      comments: post.replyCount ?? null,
      score: null,
      reposts: post.repostCount ?? null,
      quotes: post.quoteCount ?? null,
    },
    error: "",
  }
}
