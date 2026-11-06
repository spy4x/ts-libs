/**
 * Hashnode (GraphQL API): cross-post an article, find it by its slug and read how it did.
 *
 * Every call is one GraphQL request to {@link HASHNODE_API} with the personal access token in the
 * `Authorization` header, as https://apidocs.hashnode.com describes. Hashnode serves its API only
 * to publications on a Pro plan: any other publication gets a `FORBIDDEN` error, which comes back
 * as a failure.
 *
 * - **`publishHashnodePost({ token, publicationId, title, contentMarkdown, originalArticleURL,
 *   slug?, subtitle?, coverImageURL?, tags?, fetch?, requestTimeoutMs?, sleep? })`** runs the
 *   `publishPost` mutation and answers `output: { id, url }`. `originalArticleURL` is the
 *   original's address, which search engines are told to rank. `tags` are tag slugs, at most 15.
 * - **`findHashnodePostBySlug({ token?, host | publicationId, slug, … })`** answers the
 *   publication's post with that slug as `{ id, url }`, or `output: null` when it has none.
 * - **`readHashnodePostResults({ token?, id | host + slug, … })`** answers `{ id, url, views,
 *   reactions, comments, score: null }`; `views` is `null` when Hashnode does not report it.
 * - **Look up before posting.** Posting is not idempotent, so pass an explicit `slug`, call
 *   `findHashnodePostBySlug` first and post only when it answers `null`. Only `429` is retried on
 *   a post; after a `5xx`, a timeout, a dropped connection or a GraphQL `INTERNAL_SERVER_ERROR`
 *   the error says the post may exist. The lookups also retry `5xx` and transport failures.
 *   `Retry-After` is waited exactly, up to 30 s; three attempts at most.
 * - **GraphQL errors are failures.** Hashnode answers many errors with HTTP 200 and an `errors`
 *   list; their messages are joined, cleaned and capped at 200 characters.
 * - **The token stays secret.** It is sent only in the `Authorization` header, a redirect is
 *   refused rather than followed, transport errors carry only the error class, and Hashnode's
 *   text has the token replaced by `<REDACTED:TOKEN>`.
 * - **Answers are checked.** Bodies are read under a 1 MiB cap and validated with arktype; a post
 *   `url` that is not `https` is refused. The functions never throw.
 *
 * @example
 * ```ts
 * const found = await findHashnodePostBySlug({ token, publicationId, slug })
 * if (found.success && found.output === null) {
 *   const made = await publishHashnodePost({
 *     token, publicationId, slug, title, contentMarkdown, originalArticleURL: canonical,
 *   })
 *   if (!made.success) console.warn(made.error)
 * }
 * ```
 *
 * @module
 */

import { type } from "arktype"
import {
  cleanText,
  createJsonTransport,
  failure,
  type JsonClientOptions,
  type JsonOutcome,
  sendJson,
  TOKEN_SHAPE,
  webUrl,
} from "./_json-request.ts"
import type { PostTransport } from "./_post.ts"

/**
 * Hashnode's GraphQL endpoint. `https://apidocs.hashnode.com` points here; the older
 * `https://gql.hashnode.com` answers every request with a redirect.
 */
export const HASHNODE_API = "https://gql-beta.hashnode.com/"

/** The most tags Hashnode accepts on one post. */
export const HASHNODE_MAX_TAGS = 15

const MAX_BYTES = 1024 * 1024

/** Settings every call shares. */
export interface HashnodeClientOptions extends JsonClientOptions {
  /** Personal access token, from Settings → Developer. Never logged. */
  token: string
}

/** Options for {@link publishHashnodePost}. */
export interface PublishHashnodePostOptions extends HashnodeClientOptions {
  /** The publication's id, 24 hex digits. */
  publicationId: string
  title: string
  contentMarkdown: string
  /** The original's address, which search engines are told to rank. `http` or `https`. */
  originalArticleURL: string
  /** Pass one, so {@link findHashnodePostBySlug} can find the post before a second attempt. */
  slug?: string
  subtitle?: string
  /** Cover image address, `http` or `https`. */
  coverImageURL?: string
  /** Tag slugs, at most {@link HASHNODE_MAX_TAGS}; Hashnode creates a tag it does not know. */
  tags?: readonly string[]
}

/** Which publication to look in: its host (`blog.example.com`) or its id. */
export type HashnodePublicationRef = { host: string; publicationId?: never } | {
  publicationId: string
  host?: never
}

/** Options for {@link findHashnodePostBySlug}. */
export type FindHashnodePostBySlugOptions =
  & Partial<HashnodeClientOptions>
  & JsonClientOptions
  & HashnodePublicationRef
  & { slug: string }

/** Options for {@link readHashnodePostResults}: the post's id, or its publication host and slug. */
export type ReadHashnodePostResultsOptions =
  & Partial<HashnodeClientOptions>
  & JsonClientOptions
  & ({ id: string; host?: never; slug?: never } | { host: string; slug: string; id?: never })

/** A Hashnode post: its id and public address. */
export interface HashnodePostRef {
  id: string
  url: string
}

/**
 * How a copy did, in the shape every channel answers. Matches `ShareResults` from
 * `./share-results.ts`; `null` is a number Hashnode does not report.
 */
export interface HashnodeResults {
  views: number | null
  reactions: number | null
  comments: number | null
  score: number | null
}

/** Outcome of {@link publishHashnodePost}. */
export type HashnodePublishResult =
  | { success: true; output: HashnodePostRef; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link findHashnodePostBySlug}; a failure never means "not found". */
export type HashnodeFindResult =
  | { success: true; output: HashnodePostRef | null; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link readHashnodePostResults}. */
export type HashnodeResultsResult =
  | { success: true; output: HashnodePostRef & HashnodeResults; error: "" }
  | { success: false; output: null; error: string }

const OBJECT_ID = /^[0-9a-f]{24}$/i
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i
const SLUG = /^[\x21-\x7E]{1,250}$/

const PublishInput = type({
  publicationId: "string",
  title: "string > 0",
  contentMarkdown: "string > 0",
  originalArticleURL: "string",
  "slug?": "string > 0",
  "subtitle?": "string",
  "coverImageURL?": "string",
  "tags?": type("string > 0").array().atMostLength(HASHNODE_MAX_TAGS),
})

const GraphqlErrors = type({
  errors: type({ message: "string", "extensions?": { "code?": "unknown" } }).array(),
})

const PostRef = type({ id: "string > 0", url: "string" })

const PostStats = type({
  id: "string > 0",
  url: "string",
  "views?": "number.integer >= 0 | null",
  reactionCount: "number.integer >= 0",
  responseCount: "number.integer >= 0",
})

const PUBLISH = `mutation PublishPost($input: PublishPostInput!) {
  publishPost(input: $input) { post { id url } }
}`
const FIND_BY_HOST = `query FindPost($host: String!, $slug: String!) {
  publication(host: $host) { id post(slug: $slug) { id url } }
}`
const FIND_BY_ID = `query FindPost($id: ObjectId!, $slug: String!) {
  publication(id: $id) { id post(slug: $slug) { id url } }
}`
const STATS = "id url views reactionCount responseCount"
const RESULTS_BY_ID = `query PostResults($id: ID!) { post(id: $id) { ${STATS} } }`
const RESULTS_BY_SLUG = `query PostResults($host: String!, $slug: String!) {
  publication(host: $host) { id post(slug: $slug) { ${STATS} } }
}`

/** Only an `https` address leaves this module as a post's `url`. */
const toRef = (entry: { id: string; url: string }): HashnodePostRef | undefined =>
  webUrl(entry.url)?.protocol === "https:" ? { id: entry.id, url: entry.url } : undefined

/** The joined messages of a GraphQL `errors` list, or `undefined` when there is none. */
const graphqlMessage = (body: unknown, secrets: readonly string[]): string | undefined => {
  const parsed = GraphqlErrors(body)
  if (parsed instanceof type.errors || parsed.errors.length === 0) return undefined
  return cleanText(parsed.errors.map((error) => error.message).join("; "), secrets)
}

const hasInternalError = (body: unknown): boolean => {
  const parsed = GraphqlErrors(body)
  return !(parsed instanceof type.errors) &&
    parsed.errors.some((error) => error.extensions?.code === "INTERNAL_SERVER_ERROR")
}

/** What one GraphQL request produced: its `data`, or why there is none. */
type GraphqlOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string; uncertain: boolean }

/** Sends one GraphQL request and separates `data` from transport, HTTP and GraphQL errors. */
const graphql = async (
  transport: PostTransport,
  token: string | undefined,
  query: string,
  variables: Record<string, unknown>,
  idempotent: boolean,
): Promise<GraphqlOutcome> => {
  const secrets = token === undefined ? [] : [token]
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" })
  if (token !== undefined) headers.set("Authorization", token)
  const outcome: JsonOutcome = await sendJson(transport, {
    service: "hashnode",
    method: "POST",
    url: HASHNODE_API,
    headers,
    body: JSON.stringify({ query, variables }),
    maxBytes: MAX_BYTES,
    idempotent,
    readBody: true,
    secrets,
    detail: (body) => graphqlMessage(body, secrets),
  })
  if (!outcome.ok) return { ok: false, message: outcome.message, uncertain: outcome.uncertain }
  const message = graphqlMessage(outcome.body, secrets)
  if (message !== undefined) {
    return {
      ok: false,
      message: `hashnode answered with errors: ${message}`,
      uncertain: hasInternalError(outcome.body),
    }
  }
  const data = (outcome.body as { data?: unknown } | null)?.data
  if (typeof data !== "object" || data === null) {
    return { ok: false, message: "hashnode answer has no data", uncertain: true }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

/** Checks the token, when one is given, and builds the transport. */
const prepare = (
  options: Partial<HashnodeClientOptions>,
  tokenRequired: boolean,
): PostTransport | string => {
  const token = options.token
  if (token === undefined ? tokenRequired : typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    return "invalid options: token must be a non-empty string without spaces"
  }
  return createJsonTransport(options)
}

/** The publication argument of a lookup, or the reason it is unusable. */
const publicationOf = (
  options: { host?: unknown; publicationId?: unknown },
): { host: string } | { id: string } | string => {
  if (typeof options.host === "string" && options.publicationId === undefined) {
    return HOST.test(options.host)
      ? { host: options.host }
      : "invalid options: host must be a bare host name"
  }
  if (typeof options.publicationId === "string" && options.host === undefined) {
    return OBJECT_ID.test(options.publicationId)
      ? { id: options.publicationId }
      : "invalid options: publicationId must be 24 hex digits"
  }
  return "invalid options: pass either host or publicationId"
}

/** The `post` inside `publication`, or the failure a missing publication means. */
const postInPublication = (
  data: Record<string, unknown>,
): { post: unknown } | { error: string } => {
  const publication = data.publication
  if (publication === null || publication === undefined) {
    return { error: "hashnode has no such publication" }
  }
  if (typeof publication !== "object") return { error: "hashnode answer has no publication" }
  return { post: (publication as { post?: unknown }).post ?? null }
}

/**
 * Publishes a post to a Hashnode publication and returns its id and address. Never throws.
 *
 * Only `429` is sent again. After a `5xx`, a timeout, a dropped connection or a GraphQL
 * `INTERNAL_SERVER_ERROR` the post may exist, so the error says to look it up with
 * {@link findHashnodePostBySlug} first. Any other GraphQL error means nothing was posted.
 */
export const publishHashnodePost = async (
  options: PublishHashnodePostOptions,
): Promise<HashnodePublishResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options, true)
  if (typeof transport === "string") return failure(transport)
  const input = PublishInput({
    publicationId: options.publicationId,
    title: options.title,
    contentMarkdown: options.contentMarkdown,
    originalArticleURL: options.originalArticleURL,
    ...(options.slug === undefined ? {} : { slug: options.slug }),
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.coverImageURL === undefined ? {} : { coverImageURL: options.coverImageURL }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
  })
  if (input instanceof type.errors) return failure(`invalid post: ${input.summary}`)
  if (!OBJECT_ID.test(input.publicationId)) {
    return failure("invalid post: publicationId must be 24 hex digits")
  }
  if (webUrl(input.originalArticleURL) === undefined) {
    return failure("invalid post: originalArticleURL must be an http or https URL")
  }
  if (input.coverImageURL !== undefined && webUrl(input.coverImageURL) === undefined) {
    return failure("invalid post: coverImageURL must be an http or https URL")
  }
  if (input.slug !== undefined && !SLUG.test(input.slug)) {
    return failure("invalid post: slug must be printable ASCII without spaces")
  }

  const outcome = await graphql(transport, options.token, PUBLISH, {
    input: {
      publicationId: input.publicationId,
      title: input.title,
      contentMarkdown: input.contentMarkdown,
      originalArticleURL: input.originalArticleURL,
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
      ...(input.coverImageURL === undefined ? {} : { coverImage: input.coverImageURL }),
      ...(input.tags === undefined ? {} : { tags: input.tags.map((slug) => ({ slug })) }),
    },
  }, false)
  if (!outcome.ok) {
    return failure(
      outcome.uncertain
        ? `${outcome.message}; the post may exist, look it up before posting again`
        : outcome.message,
    )
  }
  const post = (outcome.data.publishPost as { post?: unknown } | null | undefined)?.post
  const parsed = PostRef(post)
  const ref = parsed instanceof type.errors ? undefined : toRef(parsed)
  if (ref === undefined) {
    return failure("hashnode answer has no valid id and https url; the post may exist, look it up")
  }
  return { success: true, output: ref, error: "" }
}

/**
 * Finds the post with `slug` in a publication, given its host or id. Never throws.
 *
 * Answers `output: null` only when Hashnode says the publication exists and has no such post; a
 * missing publication, an error or a malformed answer is a failure, so a caller never posts twice
 * because of an answer it could not read. The token is optional for a public post.
 */
export const findHashnodePostBySlug = async (
  options: FindHashnodePostBySlugOptions,
): Promise<HashnodeFindResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options, false)
  if (typeof transport === "string") return failure(transport)
  const publication = publicationOf(options)
  if (typeof publication === "string") return failure(publication)
  if (typeof options.slug !== "string" || !SLUG.test(options.slug)) {
    return failure("invalid options: slug must be printable ASCII without spaces")
  }

  const outcome = await graphql(
    transport,
    options.token,
    "host" in publication ? FIND_BY_HOST : FIND_BY_ID,
    { ...publication, slug: options.slug },
    true,
  )
  if (!outcome.ok) return failure(outcome.message)
  const found = postInPublication(outcome.data)
  if ("error" in found) return failure(found.error)
  const post = found.post
  if (post === null) return { success: true, output: null, error: "" }
  const parsed = PostRef(post)
  const ref = parsed instanceof type.errors ? undefined : toRef(parsed)
  if (ref === undefined) return failure("hashnode post has no valid id and https url")
  return { success: true, output: ref, error: "" }
}

/**
 * Reads a post's views, reactions and comments, by its id or by its publication host and slug.
 * Never throws. A post Hashnode does not know is a failure.
 */
export const readHashnodePostResults = async (
  options: ReadHashnodePostResultsOptions,
): Promise<HashnodeResultsResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const transport = prepare(options, false)
  if (typeof transport === "string") return failure(transport)

  let outcome: GraphqlOutcome
  if (typeof options.id === "string" && options.host === undefined) {
    if (!SLUG.test(options.id)) return failure("invalid options: id must be printable ASCII")
    outcome = await graphql(transport, options.token, RESULTS_BY_ID, { id: options.id }, true)
  } else if (typeof options.host === "string" && options.id === undefined) {
    if (!HOST.test(options.host)) return failure("invalid options: host must be a bare host name")
    if (typeof options.slug !== "string" || !SLUG.test(options.slug)) {
      return failure("invalid options: slug must be printable ASCII without spaces")
    }
    outcome = await graphql(
      transport,
      options.token,
      RESULTS_BY_SLUG,
      { host: options.host, slug: options.slug },
      true,
    )
  } else {
    return failure("invalid options: pass either id, or host and slug")
  }
  if (!outcome.ok) return failure(outcome.message)

  const found = "post" in outcome.data
    ? { post: outcome.data.post }
    : postInPublication(outcome.data)
  if ("error" in found) return failure(found.error)
  if (found.post === null || found.post === undefined) return failure("hashnode has no such post")
  const post = found.post
  const stats = PostStats(post)
  if (stats instanceof type.errors) return failure("hashnode post results are malformed")
  const ref = toRef(stats)
  if (ref === undefined) return failure("hashnode post has no https url")
  return {
    success: true,
    output: {
      ...ref,
      views: stats.views ?? null,
      reactions: stats.reactionCount,
      comments: stats.responseCount,
      score: null,
    },
    error: "",
  }
}
