/**
 * LinkedIn: sign a member in once, then share a link on their own profile.
 *
 * The app needs the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products,
 * which grant the scopes `openid profile w_member_social`. The flow is the one
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * describes; the post goes through the versioned Posts API.
 *
 * - **`linkedinAuthorizeUrl({ clientId, redirectUri, state, scopes? })`** builds the sign-in
 *   address to send the member to. It is pure and throws a `TypeError` on a bad argument.
 * - **`exchangeLinkedinCode({ clientId, clientSecret, redirectUri, code, … })`** trades the code
 *   LinkedIn sends back for `{ accessToken, expiresAt, refreshToken?, refreshTokenExpiresAt? }`,
 *   times as ISO strings. Check the `state` the callback carries before calling it.
 * - **No refresh.** LinkedIn gives programmatic refresh tokens only to a limited set of approved
 *   partners, not to these products, so this module has no refresh call: an access token lives 60
 *   days, then the member signs in again. When LinkedIn does send a refresh token, it is returned.
 * - **`readLinkedinMember({ accessToken, … })`** reads `/v2/userinfo` and answers
 *   `{ sub, authorUrn }`, where `authorUrn` is `urn:li:person:<sub>`, the post's author.
 * - **`postLinkedinShare({ accessToken, authorUrn, commentary, link: { url, title, description? },
 *   linkedinVersion?, … })`** posts a public article share to `https://api.linkedin.com/rest/posts`
 *   with `LinkedIn-Version` ({@link LINKEDIN_VERSION} by default) and
 *   `X-Restli-Protocol-Version: 2.0.0`, and answers `{ id, url }`: the post URN from the
 *   `x-restli-id` header and `https://www.linkedin.com/feed/update/<id>/`. `commentary` is plain
 *   text: every character LinkedIn's "little" format reserves is escaped, except a `#` that starts
 *   a word, so hashtags still work. The link has no thumbnail, which needs LinkedIn's image upload.
 * - **Record before posting.** A post is not idempotent and these products offer no way to find a
 *   post again, so the caller records the attempt before posting and never repeats it blindly.
 *   Only `429` is retried on a post; after a `5xx`, a timeout or a dropped connection the error
 *   says the post may exist. The code exchange is not repeated either, since a code works once.
 *   `Retry-After` is waited exactly, up to 30 s; three attempts at most.
 * - **No results.** LinkedIn's member post statistics are restricted to approved partners, so
 *   this module cannot read how a share did.
 * - **Secrets stay secret.** The access token goes only in the `Authorization` header and the
 *   client secret and code only in the token request's form body. A redirect is refused, transport
 *   errors carry only the error class, and LinkedIn's text has the token, the secret and the code
 *   replaced by `<REDACTED:TOKEN>`.
 * - **Answers are checked.** Bodies are read under a 64 KiB cap and validated with arktype. The
 *   network calls never throw.
 *
 * @example
 * ```ts
 * const member = await readLinkedinMember({ accessToken })
 * if (member.success) {
 *   await recordAttempt() // the app's own record, so a crash never posts twice
 *   const shared = await postLinkedinShare({
 *     accessToken,
 *     authorUrn: member.output.authorUrn,
 *     commentary: "New post on the blog #deno",
 *     link: { url: canonical, title },
 *   })
 *   if (!shared.success) console.warn(shared.error)
 * }
 * ```
 *
 * @module
 */

import { type } from "arktype"
import {
  createJsonTransport,
  failure,
  type JsonClientOptions,
  sendJson,
  TOKEN_SHAPE,
  webUrl,
} from "./_json-request.ts"
import type { Clock } from "./retry.ts"

const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization"
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken"
const USERINFO = "https://api.linkedin.com/v2/userinfo"
const POSTS = "https://api.linkedin.com/rest/posts"

/**
 * The Posts API version sent by default, `YYYYMM`: the newest LinkedIn listed in 2026-10. LinkedIn
 * supports a version for about a year, so pass a newer `linkedinVersion` once this one is retired.
 */
export const LINKEDIN_VERSION = "202610"

/** The scopes that sign a member in and let the app post as them. */
export const LINKEDIN_DEFAULT_SCOPES: readonly string[] = ["openid", "profile", "w_member_social"]

/** The longest `commentary` LinkedIn accepts, in characters. */
export const LINKEDIN_MAX_COMMENTARY = 3000

const MAX_BYTES = 64 * 1024

/** Options for {@link linkedinAuthorizeUrl}. */
export interface LinkedinAuthorizeUrlOptions {
  clientId: string
  /** One of the app's registered redirect URLs, `http` or `https`. */
  redirectUri: string
  /** A hard-to-guess value the app keeps and compares with the callback's `state`. */
  state: string
  /** {@link LINKEDIN_DEFAULT_SCOPES} by default. */
  scopes?: readonly string[]
}

/** Options for {@link exchangeLinkedinCode}. */
export interface ExchangeLinkedinCodeOptions extends JsonClientOptions {
  clientId: string
  /** Never logged. */
  clientSecret: string
  /** The same `redirectUri` the sign-in address used. */
  redirectUri: string
  /** The `code` from the callback; it works once, within 30 minutes. */
  code: string
  /** Turns `expires_in` into `expiresAt`; `Date.now` by default. */
  clock?: Clock
}

/** A member's tokens. Times are ISO 8601. */
export interface LinkedinTokens {
  accessToken: string
  expiresAt: string
  /** Only for apps LinkedIn approved for programmatic refresh. */
  refreshToken?: string
  refreshTokenExpiresAt?: string
}

/** Settings the member's calls share. */
export interface LinkedinMemberOptions extends JsonClientOptions {
  /** The member's access token. Never logged. */
  accessToken: string
}

/** The signed-in member. */
export interface LinkedinMember {
  /** The member's id for this app, from `/v2/userinfo`. */
  sub: string
  /** `urn:li:person:<sub>`, the author of the member's posts. */
  authorUrn: string
}

/** The article a share links to. */
export interface LinkedinShareLink {
  /** `http` or `https`. */
  url: string
  title: string
  description?: string
}

/** Options for {@link postLinkedinShare}. */
export interface PostLinkedinShareOptions extends LinkedinMemberOptions {
  /** `urn:li:person:<sub>`, from {@link readLinkedinMember}. */
  authorUrn: string
  /** Plain text, at most {@link LINKEDIN_MAX_COMMENTARY} characters. */
  commentary: string
  link: LinkedinShareLink
  /** `YYYYMM`; {@link LINKEDIN_VERSION} by default. */
  linkedinVersion?: string
}

/** A LinkedIn post: its URN and public address. */
export interface LinkedinPostRef {
  id: string
  url: string
}

/** Outcome of {@link exchangeLinkedinCode}. */
export type LinkedinTokensResult =
  | { success: true; output: LinkedinTokens; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link readLinkedinMember}. */
export type LinkedinMemberResult =
  | { success: true; output: LinkedinMember; error: "" }
  | { success: false; output: null; error: string }

/** Outcome of {@link postLinkedinShare}. */
export type LinkedinShareResult =
  | { success: true; output: LinkedinPostRef; error: "" }
  | { success: false; output: null; error: string }

const SCOPE = /^[A-Za-z0-9_:.-]+$/
const SUB = /^[A-Za-z0-9_-]{1,100}$/
const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]{1,100}$/
const POST_URN = /^urn:li:(?:share|ugcPost):\d{1,30}$/
const VERSION = /^\d{6}$/

const TokenAnswer = type({
  access_token: "string > 0",
  expires_in: "number.integer > 0",
  "refresh_token?": "string > 0",
  "refresh_token_expires_in?": "number.integer > 0",
})

const UserInfo = type({ sub: "string" })

const ShareInput = type({
  commentary: `0 < string <= ${LINKEDIN_MAX_COMMENTARY}`,
  link: { url: "string", title: "string > 0", "description?": "string" },
})

/** LinkedIn's REST errors carry `message`; its OAuth errors carry `error` and `error_description`. */
const linkedinDetail = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const { message, error, error_description } = body as Record<string, unknown>
  if (typeof message === "string") return message
  if (typeof error === "string") {
    return typeof error_description === "string" ? `${error}: ${error_description}` : error
  }
  return undefined
}

/** A `401` from the API means the member must sign in again; the error says so. */
const withSignInHint = (message: string, status: number | undefined): string =>
  status === 401 ? `${message}; the access token is invalid or expired, sign in again` : message

/**
 * Escapes every character LinkedIn's "little" text format reserves, so `commentary` reads as
 * plain text. A `#` at the start of a word and followed by a letter or digit stays a hashtag.
 */
const escapeCommentary = (text: string): string =>
  text.replace(/[\\|{}@[\]()<>#*_~]/g, (character, offset: number) => {
    if (character !== "#") return `\\${character}`
    const before = offset === 0 ? "" : text[offset - 1]
    const startsWord = before === "" || /\s/u.test(before)
    return startsWord && /^[\p{L}\p{N}]/u.test(text.slice(offset + 1)) ? "#" : "\\#"
  })

const checkString = (value: unknown, name: string): string | undefined =>
  typeof value === "string" && TOKEN_SHAPE.test(value)
    ? undefined
    : `invalid options: ${name} must be a non-empty string without spaces`

/**
 * Builds the address that asks the member to sign in and grant `scopes`. Throws a `TypeError`
 * when an argument is unusable, since a wrong sign-in address is a programming error.
 */
export const linkedinAuthorizeUrl = (options: LinkedinAuthorizeUrlOptions): string => {
  const problem = checkString(options?.clientId, "clientId") ??
    checkString(options?.state, "state") ??
    (webUrl(options?.redirectUri) === undefined
      ? "invalid options: redirectUri must be an http or https URL"
      : undefined)
  if (problem !== undefined) throw new TypeError(problem)
  const scopes = options.scopes ?? LINKEDIN_DEFAULT_SCOPES
  if (scopes.length === 0 || !scopes.every((scope) => SCOPE.test(scope))) {
    throw new TypeError("invalid options: scopes must be a non-empty list of scope names")
  }
  const url = new URL(AUTHORIZE)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: scopes.join(" "),
  }).toString()
  return url.href
}

/**
 * Trades the callback's `code` for the member's tokens. Never throws.
 *
 * Sent once, retried only on `429`: a code works a single time, so after a `5xx` or a lost answer
 * the member signs in again.
 */
export const exchangeLinkedinCode = async (
  options: ExchangeLinkedinCodeOptions,
): Promise<LinkedinTokensResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const problem = checkString(options.clientId, "clientId") ??
    checkString(options.clientSecret, "clientSecret") ??
    checkString(options.code, "code") ??
    (webUrl(options.redirectUri) === undefined
      ? "invalid options: redirectUri must be an http or https URL"
      : undefined)
  if (problem !== undefined) return failure(problem)
  const transport = createJsonTransport(options)
  if (typeof transport === "string") return failure(transport)

  const secrets = [options.clientSecret, options.code]
  const outcome = await sendJson(transport, {
    service: "linkedin",
    method: "POST",
    url: TOKEN,
    headers: new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
    }).toString(),
    maxBytes: MAX_BYTES,
    idempotent: false,
    readBody: true,
    secrets,
    detail: linkedinDetail,
  })
  if (!outcome.ok) return failure(outcome.message)
  const answer = TokenAnswer(outcome.body)
  if (answer instanceof type.errors || !TOKEN_SHAPE.test(answer.access_token)) {
    return failure("linkedin token answer is malformed")
  }
  const now = transport.clock()
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString()
  return {
    success: true,
    output: {
      accessToken: answer.access_token,
      expiresAt: at(answer.expires_in),
      ...(answer.refresh_token === undefined ? {} : { refreshToken: answer.refresh_token }),
      ...(answer.refresh_token_expires_in === undefined
        ? {}
        : { refreshTokenExpiresAt: at(answer.refresh_token_expires_in) }),
    },
    error: "",
  }
}

/** Reads the signed-in member's id and author URN. Never throws. */
export const readLinkedinMember = async (
  options: LinkedinMemberOptions,
): Promise<LinkedinMemberResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const problem = checkString(options.accessToken, "accessToken")
  if (problem !== undefined) return failure(problem)
  const transport = createJsonTransport(options)
  if (typeof transport === "string") return failure(transport)

  const outcome = await sendJson(transport, {
    service: "linkedin",
    method: "GET",
    url: USERINFO,
    headers: new Headers({
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
    }),
    maxBytes: MAX_BYTES,
    idempotent: true,
    readBody: true,
    secrets: [options.accessToken],
    detail: linkedinDetail,
  })
  if (!outcome.ok) return failure(withSignInHint(outcome.message, outcome.status))
  const info = UserInfo(outcome.body)
  if (info instanceof type.errors || !SUB.test(info.sub)) {
    return failure("linkedin userinfo answer has no valid sub")
  }
  return {
    success: true,
    output: { sub: info.sub, authorUrn: `urn:li:person:${info.sub}` },
    error: "",
  }
}

/**
 * Shares `link` with `commentary` on the member's own profile, visible to everyone. Never throws.
 *
 * Not idempotent, and nothing can find the post again: record the attempt first. Only `429` is
 * sent again; after a `5xx`, a timeout or a dropped connection the error says the post may exist.
 */
export const postLinkedinShare = async (
  options: PostLinkedinShareOptions,
): Promise<LinkedinShareResult> => {
  if (typeof options !== "object" || options === null) {
    return failure("invalid options: expected an options object")
  }
  const problem = checkString(options.accessToken, "accessToken")
  if (problem !== undefined) return failure(problem)
  if (typeof options.authorUrn !== "string" || !PERSON_URN.test(options.authorUrn)) {
    return failure("invalid options: authorUrn must be urn:li:person:<id>")
  }
  const version = options.linkedinVersion ?? LINKEDIN_VERSION
  if (typeof version !== "string" || !VERSION.test(version)) {
    return failure("invalid options: linkedinVersion must be YYYYMM")
  }
  const share = ShareInput({ commentary: options.commentary, link: options.link })
  if (share instanceof type.errors) return failure(`invalid share: ${share.summary}`)
  if (webUrl(share.link.url) === undefined) {
    return failure("invalid share: link.url must be an http or https URL")
  }
  const transport = createJsonTransport(options)
  if (typeof transport === "string") return failure(transport)

  const outcome = await sendJson(transport, {
    service: "linkedin",
    method: "POST",
    url: POSTS,
    headers: new Headers({
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": version,
      "X-Restli-Protocol-Version": "2.0.0",
    }),
    body: JSON.stringify({
      author: options.authorUrn,
      commentary: escapeCommentary(share.commentary),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: share.link.url,
          title: share.link.title,
          ...(share.link.description === undefined ? {} : { description: share.link.description }),
        },
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    maxBytes: MAX_BYTES,
    idempotent: false,
    readBody: false,
    secrets: [options.accessToken],
    detail: linkedinDetail,
  })
  if (!outcome.ok) {
    const message = withSignInHint(outcome.message, outcome.status)
    return failure(
      outcome.uncertain ? `${message}; the post may exist, check the profile first` : message,
    )
  }
  const id = outcome.headers.get("x-restli-id") ?? ""
  if (!POST_URN.test(id)) {
    return failure(
      "linkedin answer has no valid x-restli-id; the post may exist, check the profile",
    )
  }
  return {
    success: true,
    output: { id, url: `https://www.linkedin.com/feed/update/${id}/` },
    error: "",
  }
}
