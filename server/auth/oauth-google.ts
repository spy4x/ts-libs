/**
 * Google's {@link OAuthProviderConfig} for `createOAuthSignIn` from `@ts-libs/server/auth/oauth`.
 *
 * The endpoints are the ones Google's OpenID Connect discovery document
 * (`https://accounts.google.com/.well-known/openid-configuration`) names. The person is read from
 * the user-info endpoint: `sub` is Google's stable user id, and `email_verified` must be the boolean
 * `true` before the address counts as vouched for.
 *
 * @module
 */

import { type } from "arktype"
import { validate } from "@ts-libs/validation"

import type { OAuthProfile, OAuthProviderConfig } from "./oauth.ts"

/** Google's authorization endpoint. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
/** Google's token endpoint. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
/** Google's OpenID Connect user-info endpoint. */
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
/** The scopes that make Google answer `sub`, `email` and `email_verified`. */
export const GOOGLE_DEFAULT_SCOPES: readonly string[] = ["openid", "email"]

/** Options of {@link createGoogleOAuthProvider}. */
export interface GoogleOAuthOptions {
  /** The OAuth client id from the Google Cloud console. */
  clientId: string
  /** The OAuth client secret. Read it from the environment; never commit it. */
  clientSecret: string
  /** Defaults to {@link GOOGLE_DEFAULT_SCOPES}. Keep `openid` and `email` when you replace them. */
  scopes?: readonly string[]
  /** Extra authorization parameters, such as `{ prompt: "select_account" }`. */
  authorizationParams?: Readonly<Record<string, string>>
}

const googleUserInfo = type({
  sub: "string",
  "email?": "string",
  // Read as unknown: only the boolean `true` vouches, and any other value still signs the person in.
  "email_verified?": "unknown",
})

/**
 * Reads Google's user-info answer. `emailVerified` is true only for `email_verified: true` with an
 * `email` present; null when `sub` is missing or the body is not an object of the expected shape.
 */
export function readGoogleProfile(body: unknown): OAuthProfile | null {
  const { error, data } = validate(googleUserInfo, body)
  if (error) return null
  const email = data.email ?? null
  return { subject: data.sub, email, emailVerified: email !== null && data.email_verified === true }
}

/** Google as an {@link OAuthProviderConfig}, method `oauth:google`. */
export function createGoogleOAuthProvider(options: GoogleOAuthOptions): OAuthProviderConfig {
  return {
    id: "google",
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    userInfoEndpoint: GOOGLE_USERINFO_ENDPOINT,
    scopes: options.scopes ?? GOOGLE_DEFAULT_SCOPES,
    authorizationParams: options.authorizationParams,
    profile: readGoogleProfile,
  }
}
