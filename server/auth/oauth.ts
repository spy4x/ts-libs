/**
 * Sign-in with an OAuth2 / OpenID Connect provider (Google, or any provider the app configures).
 *
 * Written from the rules in issue #57, finding 2, not moved from the earlier
 * `providers/oauth2.ts`. The rules this file carries:
 *
 * - An existing key is matched by the provider's own user id (`sub`), never by email. The key's
 *   `method` is `oauth:<provider id>` and its `subject` is the `sub`, looked up with `findKey`. An
 *   address decides only where a new `sub` lands, and only when the provider vouches for it
 *   (`emailVerified`) and a user already owns that address as a proven one.
 * - An address the provider does not vouch for is not stored on the key at all.
 * - Every flow uses PKCE (S256) and a single-use, expiring `state`, which must also match the value
 *   the app kept in the browser that started the flow.
 * - The pending flow is deleted before anything else happens in the callback, so it is gone on
 *   every exit, including a token or profile request that throws.
 * - `disconnect` deletes one key by id, and only when it is this provider's key of this user.
 * - With `signUp: "confirm"` a callback that would create a user stops instead and returns a
 *   single-use token, kept in the flow store under the key method and the token's SHA-256 hash for
 *   10 minutes, so only the sign-in that issued it can redeem it;
 *   `confirmSignUp(token)` creates the user. Signing in and linking stay automatic.
 *
 * Pending flows live in an {@link OAuthFlowStore}. The default keeps them in memory inside the
 * object {@link createOAuthSignIn} returns, so a callback must reach the same process that built
 * the authorization URL; pass {@link OAuthSignInOptions.flows} to share them between processes.
 *
 * @module
 */

import { encodeBase64Url } from "@std/encoding/base64url"
import { type } from "arktype"
import { constantTimeEquals, randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import { systemClock } from "@spy4x/platform/universal/time"
import { readBoundedJson } from "@spy4x/net/bounded-body"
import { SecondFactorStatus } from "../sign-in/mod.ts"
import { validate } from "@spy4x/validation"

import { isStoreText, MAX_SUBJECT_LENGTH } from "./input.ts"
import { AuthConflictError, type AuthKey, type AuthUser, normalizeEmail } from "./model.ts"
import {
  createMemoryOAuthFlowStore,
  type OAuthFlowStore,
  type OAuthTakenFlow,
} from "./oauth-flows.ts"
import type { ProviderDeps, SignInResult } from "./provider.ts"

export {
  createKvOAuthFlowStore,
  createMemoryOAuthFlowStore,
  DEFAULT_OAUTH_FLOW_KEY_PREFIX,
  type KvOAuthFlowStoreOptions,
  MAX_PENDING_OAUTH_FLOWS,
  type MemoryOAuthFlowStoreOptions,
  type OAuthFlowKv,
  type OAuthFlowStore,
  type OAuthPendingFlow,
  type OAuthTakenFlow,
} from "./oauth-flows.ts"

/** What a provider says about the person who signed in, read from its user-info response. */
export interface OAuthProfile {
  /** The provider's own, stable user id (`sub`). */
  subject: string
  /** The address the provider reports, as it sent it, or null. */
  email: string | null
  /**
   * True only when the provider vouches that the person receives mail at `email`. A provider that
   * does not own the address (or does not say) must report false: a true value can link this sign-in
   * to an existing account that owns the address.
   */
  emailVerified: boolean
}

/** What {@link OAuthProviderConfig.completeProfile} may use. */
export interface OAuthProfileContext {
  /**
   * Sends a GET to the `https:` URL `url` with the sign-in's access token and returns the JSON
   * answer, within the same time limit as the other provider requests.
   *
   * @throws {OAuthSignInError} `profile-failed` when the request fails, or the answer is not JSON,
   * is larger than 64 KiB or stalls.
   */
  getJson(url: string): Promise<unknown>
}

/**
 * One provider, supplied by the app. `oauth-google.ts` ships Google's; any other OAuth2 provider
 * with a user-info endpoint is added the same way, without editing an enum.
 */
export interface OAuthProviderConfig {
  /**
   * Short name: lower-case letters, digits and `-`, 1 to 58 characters. The key method is
   * `oauth:<id>`.
   */
  id: string
  clientId: string
  clientSecret: string
  /** `https:` URL the browser is sent to. */
  authorizationEndpoint: string
  /** `https:` URL the code is exchanged at. The client secret goes in the form body. */
  tokenEndpoint: string
  /** `https:` URL that answers the person's profile for the access token. */
  userInfoEndpoint: string
  scopes: readonly string[]
  /**
   * Extra query parameters for the authorization URL, such as `prompt`. They cannot replace the
   * parameters this module sets (`client_id`, `state`, the PKCE pair, …).
   */
  authorizationParams?: Readonly<Record<string, string>>
  /** Reads the user-info response body; null when it does not describe a person. */
  profile(body: unknown): OAuthProfile | null
  /**
   * Completes the profile `profile` read with further requests, for a provider whose user-info
   * answer lacks something, such as GitHub's address. Returns the profile to use, or null when the
   * person cannot be keyed. Optional: without it the profile is used as read.
   */
  completeProfile?(
    profile: OAuthProfile,
    context: OAuthProfileContext,
  ): Promise<OAuthProfile | null>
}

/** Options of {@link createOAuthSignIn}. */
export interface OAuthSignInOptions extends ProviderDeps {
  provider: OAuthProviderConfig
  /** Absolute `http:` or `https:` URL of the app's callback route, registered with the provider. */
  redirectUri: string
  /** How long a started flow can be completed, in whole seconds. Defaults to 600. */
  flowTtlSeconds?: number
  /**
   * Time limit of each request to the provider, in milliseconds, and the longest wait for the next
   * chunk of its answer. Defaults to 10 000. An answer is read up to 64 KiB; a larger one refuses
   * the step.
   */
  timeoutMs?: number
  /** Sends the requests to the provider. Defaults to the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>
  /**
   * Where started flows wait for their callback (#150). Defaults to
   * `createMemoryOAuthFlowStore({ clock })`: in this process, at most
   * {@link MAX_PENDING_OAUTH_FLOWS}. Pass `createKvOAuthFlowStore` on a shared Redis when more than
   * one process serves the callback, or when a flood of started flows must not push out others.
   * Instances that share a store must share the provider config too.
   */
  flows?: OAuthFlowStore
}

/** Options of {@link createOAuthSignIn} for a sign-in that asks before it creates a user. */
export interface ConfirmableOAuthSignInOptions extends OAuthSignInOptions {
  /**
   * Stops a callback that would create a user and returns an {@link OAuthPendingSignUp} instead,
   * so the app can ask before a new account exists. Without it the callback creates the user.
   */
  signUp: "confirm"
}

/** A started flow: send the browser to `url`, and keep `state` in an HttpOnly cookie until the callback. */
export interface OAuthAuthorization {
  url: URL
  state: string
  expiresAt: Date
}

/** What the app passes from the callback request. */
export interface OAuthCallbackInput {
  /** The callback URL's query: `code` and `state`, or `error`. */
  query: URLSearchParams
  /** The `state` the app kept in the browser (the cookie), or null/undefined when it has none. */
  browserState: string | null | undefined
}

/** How a successful callback resolved the person. Numbered from 1 so no value is falsy. */
export enum OAuthOutcome {
  /** A key with this `sub` existed; its user is signed in. */
  SignedIn = 1,
  /** A new user was created with this key. */
  SignedUp = 2,
  /** The key was added to the existing user who owns the verified address. */
  Linked = 3,
  /** Nobody was created yet: the callback returned a token for `confirmSignUp` (`signUp: "confirm"`). */
  PendingSignUp = 4,
}

/** A successful callback: the session, plus how the person was resolved and what the provider said. */
export interface OAuthSignInResult extends SignInResult {
  outcome: OAuthOutcome.SignedIn | OAuthOutcome.SignedUp | OAuthOutcome.Linked
  profile: OAuthProfile
}

/**
 * A callback that would have created a user, with `signUp: "confirm"`. Nothing is written yet: show
 * the person `profile`, and call `confirmSignUp(token)` when they choose to create the account.
 */
export interface OAuthPendingSignUp {
  outcome: OAuthOutcome.PendingSignUp
  /** What the provider said about the person. */
  profile: OAuthProfile
  /**
   * Single-use, 256-bit secret. Keep it server-side or in an HttpOnly cookie, never in a URL. Only
   * its SHA-256 hash is stored.
   */
  token: string
  /** When `token` stops working: 10 minutes after the callback. */
  expiresAt: Date
}

/** Why a callback was refused. */
export type OAuthFailure =
  /** The query has no `code` or no `state`. */
  | "invalid-request"
  /** No live flow for this `state`, or the browser's `state` differs. */
  | "invalid-state"
  /** The provider sent `error` instead of a code (for example the person declined). */
  | "provider-error"
  /** The token request failed or its answer was unusable. */
  | "token-exchange-failed"
  /** The user-info request failed, or its answer was not JSON, too large or stalled. */
  | "profile-failed"
  /** The user-info answer does not describe a person the store can key. */
  | "invalid-profile"
  /** The user this sign-in resolves to is deleted. */
  | "user-deleted"
  /** `confirmSignUp` got a token that is unknown, already used or expired. */
  | "invalid-sign-up"

/** Thrown by {@link OAuthSignIn.handleCallback}. `reason` says why; the message is not an API. */
export class OAuthSignInError extends Error {
  readonly reason: OAuthFailure

  constructor(reason: OAuthFailure, options?: { cause?: unknown }) {
    super(`OAuth sign-in failed: ${reason}`, options)
    this.name = "OAuthSignInError"
    this.reason = reason
  }
}

/** Sign-in with one provider. */
export interface OAuthSignIn {
  /** The key method this provider writes: `oauth:<id>`. */
  readonly method: string
  /** Starts a flow: a fresh `state` and PKCE pair, and the URL to send the browser to. */
  authorizationUrl(): Promise<OAuthAuthorization>
  /**
   * Completes a flow: checks `state`, exchanges the code with the PKCE verifier, reads the profile,
   * then signs the person in, signs them up, or links the key to the owner of the verified address.
   *
   * @throws {OAuthSignInError} When the callback is refused. The flow is consumed either way.
   */
  handleCallback(input: OAuthCallbackInput): Promise<OAuthSignInResult>
  /**
   * Deletes the key `keyId` when it is this provider's key of `userId`, and nothing else. false
   * when there is no such key. Its sessions end with it on the Postgres store, which cascades the
   * delete; the in-memory store has no sessions to cascade.
   */
  disconnect(userId: number, keyId: number): Promise<boolean>
}

/** Sign-in with one provider, created with `signUp: "confirm"`. */
export interface ConfirmableOAuthSignIn extends Omit<OAuthSignIn, "handleCallback"> {
  /**
   * Like {@link OAuthSignIn.handleCallback}, but returns an {@link OAuthPendingSignUp} instead of
   * creating a user. Signing in an existing key and linking to the owner of a vouched-for address
   * still complete here.
   *
   * @throws {OAuthSignInError} When the callback is refused. The flow is consumed either way.
   */
  handleCallback(input: OAuthCallbackInput): Promise<OAuthSignInResult | OAuthPendingSignUp>
  /**
   * Redeems a pending sign-up's token and creates the user, then starts the session. The token is
   * removed in the same step it is read, so of parallel calls only one proceeds. Resolution runs in
   * full again, so a key or proven address that appeared since the callback signs in or links instead.
   *
   * @throws {OAuthSignInError} `invalid-sign-up` when the token is unknown, used or expired.
   */
  confirmSignUp(token: string): Promise<OAuthSignInResult>
}

const DEFAULT_FLOW_TTL_SECONDS = 600
const DEFAULT_TIMEOUT_MS = 10_000
/**
 * Most bytes read from one provider answer. A token, profile or address list is a few KiB at most;
 * anything larger refuses the step instead of being buffered (#331).
 */
const MAX_RESPONSE_BYTES = 64 * 1024
/** 256 bits each; base64url renders them as 43 characters, the PKCE verifier's minimum length. */
const STATE_BYTES = 32
const VERIFIER_BYTES = 32
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,57}$/
/** Tries of the account resolution when a parallel write changed what it read. */
const RESOLVE_ATTEMPTS = 2
/** How long a pending sign-up's token can be confirmed. */
const SIGN_UP_TTL_MS = 600_000
/**
 * Flow-store key prefix of pending sign-ups, before the key method and the token's hash. The method
 * binds a token to the sign-in that issued it, so a sign-in sharing the store cannot redeem it.
 */
const SIGN_UP_KEY_PREFIX = "sign-up:"

const tokenResponse = type({
  access_token: "0 < string <= 4096",
  "token_type?": "string",
})

/**
 * Creates sign-in with one provider. Validates the configuration once, here.
 *
 * @throws {TypeError} When the provider id, a credential, an endpoint, the redirect URI, `signUp`
 *     or a number option is not valid.
 */
export function createOAuthSignIn(options: ConfirmableOAuthSignInOptions): ConfirmableOAuthSignIn
export function createOAuthSignIn(options: OAuthSignInOptions): OAuthSignIn
export function createOAuthSignIn(
  options: OAuthSignInOptions | ConfirmableOAuthSignInOptions,
): OAuthSignIn | ConfirmableOAuthSignIn {
  const { provider, store, sessions } = options
  if (typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id)) {
    throw new TypeError("provider.id must be 1 to 58 lower-case letters, digits or '-'")
  }
  requireText(provider.clientId, "provider.clientId")
  requireText(provider.clientSecret, "provider.clientSecret")
  const authorizationEndpoint = requireUrl(provider.authorizationEndpoint, "authorizationEndpoint")
  const tokenEndpoint = requireUrl(provider.tokenEndpoint, "tokenEndpoint")
  const userInfoEndpoint = requireUrl(provider.userInfoEndpoint, "userInfoEndpoint")
  const redirectUri = requireRedirectUri(options.redirectUri)
  const ttlMs =
    positiveInteger(options.flowTtlSeconds ?? DEFAULT_FLOW_TTL_SECONDS, "flowTtlSeconds") *
    1000
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const clock = options.clock ?? systemClock
  const method = `oauth:${provider.id}`
  const flows = options.flows ?? createMemoryOAuthFlowStore({ clock })
  const signUp = "signUp" in options ? options.signUp : undefined
  if (signUp !== undefined && signUp !== "confirm") {
    throw new TypeError(`signUp must be "confirm" or left out`)
  }

  async function authorizationUrl(): Promise<OAuthAuthorization> {
    const state = randomBase64Url(STATE_BYTES)
    const verifier = randomBase64Url(VERIFIER_BYTES)
    const expiresAt = clock.now() + ttlMs
    await flows.put(state, { verifier }, new Date(expiresAt))

    const url = new URL(authorizationEndpoint)
    for (const [name, value] of Object.entries(provider.authorizationParams ?? {})) {
      url.searchParams.set(name, value)
    }
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", provider.clientId)
    url.searchParams.set("redirect_uri", redirectUri)
    url.searchParams.set("scope", provider.scopes.join(" "))
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge", await pkceChallenge(verifier))
    url.searchParams.set("code_challenge_method", "S256")
    return { url, state, expiresAt: new Date(expiresAt) }
  }

  /**
   * Removes the flow for `state` and returns it when it is live and the browser holds the same state.
   * The store's `take` deletes it first, so it is gone on every exit.
   */
  async function takeFlow(state: string, browserState: unknown): Promise<OAuthTakenFlow> {
    const flow = await flows.take(state)
    if (!flow || flow.signUp || typeof browserState !== "string") {
      throw new OAuthSignInError("invalid-state")
    }
    const same = await constantTimeEquals(await sha256Hex(state), await sha256Hex(browserState))
    // Checked here too, so a store that ignores `expiresAt` still cannot complete a stale flow.
    const live = flow.expiresAt instanceof Date && flow.expiresAt.getTime() > clock.now()
    if (!same || !live) throw new OAuthSignInError("invalid-state")
    return flow
  }

  async function request(
    build: () => Request,
    failure: OAuthFailure,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await send(build())
    } catch (cause) {
      throw new OAuthSignInError(failure, { cause })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new OAuthSignInError(failure)
    }
    try {
      return await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs })
    } catch (cause) {
      // JSON.parse quotes the start of the body in its message, and a token answer carries secrets,
      // so a parse failure keeps no cause. The size and stall errors name only their limits.
      if (cause instanceof SyntaxError) throw new OAuthSignInError(failure)
      throw new OAuthSignInError(failure, { cause })
    }
  }

  async function exchangeCode(code: string, verifier: string): Promise<string> {
    const body = await request(() =>
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }), "token-exchange-failed")
    const { error, data } = validate(tokenResponse, body)
    if (error) throw new OAuthSignInError("token-exchange-failed")
    if (data.token_type !== undefined && data.token_type.toLowerCase() !== "bearer") {
      throw new OAuthSignInError("token-exchange-failed")
    }
    return data.access_token
  }

  function getJson(url: string, accessToken: string): Promise<unknown> {
    return request(() =>
      new Request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      }), "profile-failed")
  }

  async function fetchProfile(accessToken: string): Promise<OAuthProfile> {
    const body = await getJson(userInfoEndpoint, accessToken)
    let profile: OAuthProfile | null
    try {
      profile = keyable(provider.profile(body))
      if (profile && provider.completeProfile) {
        const context: OAuthProfileContext = {
          getJson: (url) => getJson(requireUrl(url, "completeProfile URL"), accessToken),
        }
        profile = keyable(await provider.completeProfile(profile, context))
      }
    } catch (cause) {
      if (cause instanceof OAuthSignInError) throw cause
      throw new OAuthSignInError("invalid-profile", { cause })
    }
    if (!profile) throw new OAuthSignInError("invalid-profile")
    return profile
  }

  async function liveUser(userId: number): Promise<AuthUser> {
    const user = await store.findUser(userId)
    if (!user || user.deletedAt !== null) throw new OAuthSignInError("user-deleted")
    return user
  }

  /**
   * Finds or creates the key for this `sub`. The decision, in order:
   *
   * 1. A key with this method and `sub` exists → sign in its user, whatever the email says now.
   * 2. The provider vouches for the address and a user owns it proven → add a proven key to that
   *    user (linking).
   * 3. The provider vouches for the address and nobody owns it → a new user with a proven key; the
   *    store evicts every other user's unproven claim to the address.
   * 4. Otherwise → a new user with a key that carries no address.
   *
   * With `create` false it stops before 3 and 4 and returns null.
   */
  async function resolveKey(profile: OAuthProfile, create: true): Promise<Resolved>
  async function resolveKey(profile: OAuthProfile, create: boolean): Promise<Resolved | null>
  async function resolveKey(profile: OAuthProfile, create: boolean): Promise<Resolved | null> {
    const email = profile.emailVerified === true ? normalizeEmail(profile.email) : null
    for (let attempt = 1;; attempt++) {
      try {
        const existing = await store.findKey(method, profile.subject)
        if (existing) {
          return {
            user: await liveUser(existing.userId),
            key: existing,
            outcome: OAuthOutcome.SignedIn,
          }
        }
        const now = new Date(clock.now())
        const newKey = {
          method,
          subject: profile.subject,
          email,
          secret: null,
          provenAt: email === null ? null : now,
        }
        const ownerId = email === null ? null : await store.findUserIdByProvenEmail(email)
        if (ownerId !== null) {
          const user = await liveUser(ownerId)
          return { user, key: await store.addKey(user.id, newKey), outcome: OAuthOutcome.Linked }
        }
        if (!create) return null
        const created = await store.createUserWithKey(newKey)
        return { ...created, outcome: OAuthOutcome.SignedUp }
      } catch (error) {
        // A parallel callback created this key, or someone proved the address, between the reads
        // and the write. Reading again resolves it.
        if (!(error instanceof AuthConflictError) || attempt >= RESOLVE_ATTEMPTS) throw error
      }
    }
  }

  async function handleCallback(
    input: OAuthCallbackInput,
  ): Promise<OAuthSignInResult | OAuthPendingSignUp> {
    const state = input.query.get("state")
    if (state === null || state === "") throw new OAuthSignInError("invalid-request")
    const flow = await takeFlow(state, input.browserState)
    if (input.query.has("error")) throw new OAuthSignInError("provider-error")
    const code = input.query.get("code")
    if (code === null || code === "") throw new OAuthSignInError("invalid-request")

    const accessToken = await exchangeCode(code, flow.verifier)
    const profile = await fetchProfile(accessToken)
    const resolved = await resolveKey(profile, signUp === undefined)
    if (!resolved) return await holdSignUp(profile)
    return await startSession(resolved, profile)
  }

  async function startSession(
    { user, key, outcome }: Resolved,
    profile: OAuthProfile,
  ): Promise<OAuthSignInResult> {
    const secondFactor = options.secondFactorFor
      ? await options.secondFactorFor(user)
      : SecondFactorStatus.NotRequired
    const session = await sessions.create({ userId: user.id, keyId: key.id, secondFactor })
    return { user, key, session, outcome, profile }
  }

  /** Where a pending sign-up's token is kept: this sign-in's method and the token's hash. */
  async function signUpKey(token: string): Promise<string> {
    return `${SIGN_UP_KEY_PREFIX}${method}:${await sha256Hex(token)}`
  }

  /** Keeps `profile` under the hash of a fresh token until the person confirms the sign-up. */
  async function holdSignUp(profile: OAuthProfile): Promise<OAuthPendingSignUp> {
    const token = randomBase64Url(STATE_BYTES)
    const expiresAt = new Date(clock.now() + SIGN_UP_TTL_MS)
    const { subject, email, emailVerified } = profile
    await flows.put(
      await signUpKey(token),
      { verifier: randomBase64Url(VERIFIER_BYTES), signUp: { subject, email, emailVerified } },
      expiresAt,
    )
    return { outcome: OAuthOutcome.PendingSignUp, profile, token, expiresAt }
  }

  async function confirmSignUp(token: string): Promise<OAuthSignInResult> {
    if (typeof token !== "string" || token === "") throw new OAuthSignInError("invalid-sign-up")
    const entry = await flows.take(await signUpKey(token))
    // Checked here too, so a store that ignores `expiresAt` still cannot confirm a stale sign-up.
    const live = entry?.expiresAt instanceof Date && entry.expiresAt.getTime() > clock.now()
    const profile = live ? keyable(entry.signUp ?? null) : null
    if (!profile) throw new OAuthSignInError("invalid-sign-up")
    return await startSession(await resolveKey(profile, true), profile)
  }

  async function disconnect(userId: number, keyId: number): Promise<boolean> {
    const key = await store.findKeyById(keyId)
    if (!key || key.userId !== userId || key.method !== method) return false
    return await store.deleteKey(userId, key.id)
  }

  const signIn: ConfirmableOAuthSignIn = {
    method,
    authorizationUrl,
    handleCallback,
    confirmSignUp,
    disconnect,
  }
  return signIn
}

/** How {@link createOAuthSignIn} resolved a profile to a user and key. */
interface Resolved {
  user: AuthUser
  key: AuthKey
  outcome: OAuthSignInResult["outcome"]
}

/** `profile` when the store can key its subject, otherwise null. */
function keyable(profile: OAuthProfile | null): OAuthProfile | null {
  if (
    !profile || !isStoreText(profile.subject) || profile.subject.length === 0 ||
    profile.subject.length > MAX_SUBJECT_LENGTH
  ) {
    return null
  }
  return profile
}

/** The S256 code challenge: base64url (unpadded) of the SHA-256 of the verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return encodeBase64Url(new Uint8Array(digest))
}

function requireText(value: unknown, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function requireUrl(value: unknown, name: string): string {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null
  if (!url || url.protocol !== "https:") throw new TypeError(`${name} must be an https: URL`)
  return url.href
}

function requireRedirectUri(value: unknown): string {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new TypeError("redirectUri must be an absolute http: or https: URL")
  }
  // As given, not `url.href`: the provider compares it with the registered URI character by
  // character, and `href` can add a trailing slash.
  return value as string
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value as number
}
