/**
 * GitHub's {@link OAuthProviderConfig} for `createOAuthSignIn` from `@spy4x/server/auth/oauth`.
 *
 * GitHub is OAuth2 without OpenID Connect. The person is read from `GET /user`, whose numeric `id`
 * is GitHub's stable user id; its `email` is only the address the person chose to make public, and
 * GitHub does not say whether it is verified. The address is therefore read from
 * `GET /user/emails` (scope `user:email`), and only the one marked both `primary` and `verified`
 * counts as vouched for. Every other address is ignored.
 *
 * @module
 */

import { type } from "arktype"
import { validate } from "@spy4x/validation"

import type { OAuthProfile, OAuthProfileContext, OAuthProviderConfig } from "./oauth.ts"

/** GitHub's authorization endpoint. */
export const GITHUB_AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize"
/** GitHub's token endpoint. It answers JSON because the request asks for `application/json`. */
export const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token"
/** GitHub's REST endpoint for the signed-in person. */
export const GITHUB_USER_ENDPOINT = "https://api.github.com/user"
/** GitHub's REST endpoint listing the signed-in person's addresses. */
export const GITHUB_EMAILS_ENDPOINT = "https://api.github.com/user/emails"
/** The scopes that let GitHub answer the person and their addresses. */
export const GITHUB_DEFAULT_SCOPES: readonly string[] = ["read:user", "user:email"]

/** Options of {@link createGitHubOAuthProvider}. */
export interface GitHubOAuthOptions {
  /** The OAuth app's client id. */
  clientId: string
  /** The OAuth app's client secret. Read it from the environment; never commit it. */
  clientSecret: string
  /** Defaults to {@link GITHUB_DEFAULT_SCOPES}. Keep `user:email` when you replace them. */
  scopes?: readonly string[]
  /** Extra authorization parameters, such as `{ allow_signup: "false" }`. */
  authorizationParams?: Readonly<Record<string, string>>
}

const githubUser = type({ id: "number.integer > 0" })

const githubEmails = type({
  email: "string",
  // Read as unknown: only the boolean `true` counts, and any other value ignores the entry.
  "primary?": "unknown",
  "verified?": "unknown",
}).array()

/**
 * Reads GitHub's `GET /user` answer: the numeric `id` as the subject, as a decimal string. The
 * address is left out (null, not vouched for); {@link readGitHubPrimaryEmail} supplies it. Null
 * when `id` is missing or not a positive safe integer.
 */
export function readGitHubUser(body: unknown): OAuthProfile | null {
  const { error, data } = validate(githubUser, body)
  if (error || !Number.isSafeInteger(data.id)) return null
  return { subject: String(data.id), email: null, emailVerified: false }
}

/**
 * Reads GitHub's `GET /user/emails` answer: the address marked both `primary: true` and
 * `verified: true`, or null when there is none or the body is not a list of addresses.
 */
export function readGitHubPrimaryEmail(body: unknown): string | null {
  const { error, data } = validate(githubEmails, body)
  if (error) return null
  const vouched = data.find((entry) => entry.primary === true && entry.verified === true)
  return vouched?.email ?? null
}

/** Adds the primary, verified address from `GET /user/emails` to the profile `/user` gave. */
async function completeGitHubProfile(
  profile: OAuthProfile,
  context: OAuthProfileContext,
): Promise<OAuthProfile> {
  const email = readGitHubPrimaryEmail(await context.getJson(GITHUB_EMAILS_ENDPOINT))
  return { subject: profile.subject, email, emailVerified: email !== null }
}

/** GitHub as an {@link OAuthProviderConfig}, method `oauth:github`. */
export function createGitHubOAuthProvider(options: GitHubOAuthOptions): OAuthProviderConfig {
  return {
    id: "github",
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
    userInfoEndpoint: GITHUB_USER_ENDPOINT,
    scopes: options.scopes ?? GITHUB_DEFAULT_SCOPES,
    authorizationParams: options.authorizationParams,
    profile: readGitHubUser,
    completeProfile: completeGitHubProfile,
  }
}
