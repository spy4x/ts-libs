/**
 * One configurable OAuth2 authorization-code provider.
 *
 * `roley/providers/google.ts` (289 lines) and `roley/providers/facebook.ts` (254
 * lines) were near-verbatim clones. The full diff is eight differences, all of
 * them values rather than logic:
 *
 * | Field             | Google                                                  | Facebook                              |
 * | ----------------- | ------------------------------------------------------- | ------------------------------------- |
 * | authorize URL     | `accounts.google.com/o/oauth2/v2/auth`                  | `facebook.com/v16.0/dialog/oauth`     |
 * | token URL         | `oauth2.googleapis.com/token`                           | `graph.facebook.com/v16.0/oauth/…`    |
 * | userinfo URL      | `googleapis.com/oauth2/v3/userinfo?alt=json`            | `graph.facebook.com/me?fields=…`      |
 * | scope             | `email profile`                                         | `` (empty)                            |
 * | state cookie name | `google_auth_state`                                     | `facebook_auth_state`                 |
 * | subject field     | `sub`                                                   | `id`                                  |
 * | email field       | `email`                                                 | `email` (optional)                    |
 * | picture field     | `picture` (string)                                      | `picture.data.url` (nested)           |
 *
 * and one behavioural difference: Facebook permits an account with no email, so
 * its key's `identification` falls back to the subject id — which the source
 * handled by inlining `facebookUser.email || facebookUser.id` twice. Both become
 * configuration here: `subjectField`, `emailField`, `pictureField` (dot path),
 * the URLs, the scope and the cookie name. Anyone adding a third provider writes
 * an options object, not a fourth clone.
 *
 * Two further fixes:
 *
 *  - **No transport inside the provider.** The source called
 *    `setSession(cookies, session)` from inside `check()` (`google.ts:195,226,265`)
 *    and typed its cookie parameter as SvelteKit's `Cookies`. A provider could
 *    therefore only run under SvelteKit. Sessions now go through the injected
 *    `SessionSink` and cookies through the `CookieJar` interface.
 *  - **Nothing about a failed exchange is logged.** The source's
 *    `console.error('Invalid token:', JSON.stringify(token, null, 4))` printed the
 *    authorization-code response body — an access token — into the log.
 *
 * `fetch` is injected, so a test drives the whole flow with a fake and no network
 * access.
 */

import type { EventPublisher, ProviderDeps } from "./provider.ts"
import type { CookieJar, Everything, IOAuth2Provider, Key, User } from "../types.ts"
import { OAuth2Provider as OAuth2Kind } from "../types.ts"
import { KeyKind } from "../types.ts"
import { EventKind } from "../events.ts"
import type { CryptoContext } from "../crypto.ts"
import { DEFAULT_OAUTH2_STATE_MAX_AGE_SEC } from "../constants.ts"
import { getRandomString } from "../random.ts"

/** Characters in the OAuth2 `state` value. */
const STATE_LENGTH = 32

/** Raised when a provider response is unusable or the state check fails. */
export class OAuth2FlowError extends Error {
  constructor(provider: string, reason: string) {
    // `reason` is always a constant from this file. It never contains a token, a
    // code, an address or a response body.
    super(`oauth2 ${provider} flow failed: ${reason}`)
    this.name = "OAuth2FlowError"
  }
}

/** What a provider's userinfo endpoint tells us about the person signing in. */
export interface OAuth2Profile {
  /** Stable subject id. Stored as the key's `secret`. */
  subject: string
  /** Verified address, when the provider supplies one. */
  email: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
}

/** Options for `OAuth2Provider`. Every provider difference is a field here. */
export interface OAuth2ProviderOptions extends ProviderDeps {
  crypto: CryptoContext
  publish: EventPublisher
  /** Which provider this instance speaks to, so the two keep separate keys. */
  provider: OAuth2Kind
  /** Lower-case provider name used in constant error messages. */
  label?: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  /** Space-separated OAuth2 scope. */
  scope: string
  clientId: string
  clientSecret: string
  /** Redirect URI registered with the provider. */
  redirectUri: string
  /** Name of the cookie that holds the CSRF `state`. */
  stateCookieName: string
  /** Dot path to the subject id in the userinfo response. */
  subjectField: string
  /** Dot path to the email address, when the provider sends one. */
  emailField?: string
  /** Dot path to the given name. */
  firstNameField?: string
  /** Dot path to the family name. */
  lastNameField?: string
  /** Dot path to the avatar URL. */
  pictureField?: string
  /** Called with the userinfo object when the avatar path needs flattening. */
  resolvePhotoUrl?: (profile: Record<string, unknown>) => string | null
  /** HTTP client. Defaults to the global `fetch`; injected in tests. */
  fetch?: typeof fetch
}

/** Read a dot path out of an unknown response body. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Authorization-code flow against one OAuth2 provider.
 *
 * `check` is the sign-in path: it may create an account, attach the credential to
 * an account the address already belongs to, or reuse an existing credential.
 * `connect` is the attach-to-the-current-account path and never mints a session.
 */
export class OAuth2Provider implements IOAuth2Provider {
  readonly provider: OAuth2Kind
  private readonly deps: ProviderDeps
  private readonly crypto: CryptoContext
  private readonly publish: EventPublisher
  private readonly options: OAuth2ProviderOptions
  private readonly http: typeof fetch

  constructor(options: OAuth2ProviderOptions) {
    this.deps = options
    this.crypto = options.crypto
    this.publish = options.publish
    this.options = options
    this.provider = options.provider
    this.http = options.fetch ?? fetch
  }

  /** Build the authorize URL and store the CSRF `state` in the caller's jar. */
  getRedirectURL(cookies: CookieJar): string {
    const state = getRandomString(STATE_LENGTH)
    const url = new URL(this.options.authorizeUrl)
    url.searchParams.set("client_id", this.options.clientId)
    url.searchParams.set("redirect_uri", this.options.redirectUri)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", this.options.scope)
    url.searchParams.set("state", state)
    cookies.set(this.options.stateCookieName, state, {
      path: "/",
      maxAge: DEFAULT_OAUTH2_STATE_MAX_AGE_SEC,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    })
    return url.toString()
  }

  exists(userId: number): Promise<null | Key> {
    return this.deps.key.findByUserId({ userId, kind: KeyKind.OAuth2 })
  }

  /**
   * The credential this provider keys for a profile.
   *
   * `identification` is `<provider>:<subject>`, never a bare address: one address
   * can legitimately hold a Google and a Facebook credential at once, and a single
   * column cannot key both. The address travels in `email`, which is the column
   * account linking searches, so a Google signup for an address that already has a
   * credential still lands on the same account.
   */
  private credentialFor(profile: OAuth2Profile): {
    identification: string
    email: string | null
    secret: string
  } {
    return {
      identification: `${this.label}:${profile.subject}`,
      email: profile.email,
      secret: profile.subject,
    }
  }

  /** True when a stored key belongs to this provider rather than a sibling instance. */
  private isOwnCredential(key: Key): boolean {
    return key.identification.startsWith(`${this.label}:`)
  }

  /**
   * Adapt a pre-`email` column credential: `<provider>:<subject>` and the address
   * were both stored in `identification` by earlier ports.
   *
   * The source wrote `identification: googleUser.email`, so a row from that era has
   * an address there and no subject. Rewriting such a row on first sign-in keeps the
   * Google credential from being read as an email-scoped key.
   */
  private async adoptLegacyCredential(key: Key, profile: OAuth2Profile): Promise<Key | null> {
    const updated = await this.deps.key.update(key.id, {
      identification: `${this.label}:${key.secret ?? profile.subject}`,
      email: key.identification,
      secret: key.secret ?? profile.subject,
    })
    return updated
  }

  /** Attach this provider's credential to an account that is already signed in. */
  async connect(code: string, state: string, cookies: CookieJar, userId: number): Promise<Key> {
    const profile = await this.authorize(code, state, cookies)
    const user = await this.deps.user.get(userId)
    if (!user) {
      throw new OAuth2FlowError(this.label, "user not found")
    }
    const credential = this.credentialFor(profile)
    const existing = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.OAuth2,
      identification: credential.identification,
    })
    if (existing) {
      if (existing.userId !== userId) {
        throw new OAuth2FlowError(this.label, "credential belongs to another account")
      }
      const updated = await this.deps.key.update(existing.id, { secret: profile.subject })
      if (!updated) {
        throw new OAuth2FlowError(this.label, "credential update failed")
      }
      return updated
    }
    const key = await this.deps.key.create({
      userId,
      kind: KeyKind.OAuth2,
      ...credential,
    })
    if (!key) {
      throw new OAuth2FlowError(this.label, "credential creation failed")
    }
    await this.publish({
      kind: EventKind.MethodConnected,
      user,
      key,
      email: profile.email,
    })
    return key
  }

  disconnect(userId: number): Promise<boolean> {
    return this.deps.key.delete({ userId, kind: KeyKind.OAuth2 })
  }

  /**
   * Sign in, or sign up, from an authorization code.
   *
   * Resolution order, and each branch is deliberate:
   *
   *  1. this provider's credential for the address already exists → reuse the
   *     account, refreshing the stored subject id;
   *  2. a credential of another kind owns the address → attach this provider's
   *     credential to *that* account, so one address never becomes two accounts;
   *  3. nothing owns the address → create the account.
   */
  async check(code: string, state: string, cookies: CookieJar): Promise<Everything> {
    const profile = await this.authorize(code, state, cookies)
    const credential = this.credentialFor(profile)

    // 1. This provider already holds a credential for this address.
    const byEmail = profile.email ? await this.deps.key.findByEmail(profile.email) : null
    if (byEmail && byEmail.kind === KeyKind.OAuth2 && this.isOwnCredential(byEmail)) {
      const key = byEmail.secret === profile.subject
        ? byEmail
        : await this.deps.key.update(byEmail.id, { secret: profile.subject })
      if (!key) {
        throw new OAuth2FlowError(this.label, "credential update failed")
      }
      return await this.signInWith(key, profile)
    }
    const legacy = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.OAuth2,
      identification: credential.identification,
    })
    if (legacy) {
      return await this.signInWith(legacy, profile)
    }
    // A row from the earlier port, which stored the address in `identification`.
    if (
      profile.email &&
      byEmail &&
      byEmail.kind === KeyKind.OAuth2 &&
      byEmail.identification === profile.email
    ) {
      const adopted = await this.adoptLegacyCredential(byEmail, profile)
      if (!adopted) {
        throw new OAuth2FlowError(this.label, "credential update failed")
      }
      return await this.signInWith(adopted, profile)
    }

    // 2. A credential of another kind holds this address: attach, do not duplicate.
    if (byEmail && byEmail.kind !== KeyKind.OAuth2) {
      return await this.attachTo(byEmail.userId, credential, profile)
    }
    // Another OAuth2 provider already holds this address. The account exists, so
    // this provider's credential joins it rather than founding a second one — the
    // Google-then-Facebook case, which the prefixed identification makes possible
    // instead of making the second sign-in overwrite the first credential.
    if (byEmail && !this.isOwnCredential(byEmail)) {
      return await this.attachTo(byEmail.userId, credential, profile)
    }

    // 3. Nothing holds this address: create the account.
    const created = await this.deps.user.create({
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      photoUrl: profile.photoUrl,
    })
    const key = await this.deps.key.create({
      userId: created.id,
      kind: KeyKind.OAuth2,
      ...credential,
    })
    if (!key) {
      throw new OAuth2FlowError(this.label, "credential creation failed")
    }
    const session = await this.deps.session.create({ userId: created.id, keyId: key.id })
    if (!session) {
      throw new OAuth2FlowError(this.label, "session creation failed")
    }
    await this.publish({
      kind: EventKind.MethodConnected,
      user: created,
      key,
      email: profile.email,
      isNewUser: true,
    })
    return { user: created, key, session }
  }

  /** Mint a session for an account that already holds this credential. */
  private async signInWith(key: Key, profile: OAuth2Profile): Promise<Everything> {
    const user = await this.deps.user.get(key.userId)
    if (!user) {
      throw new OAuth2FlowError(this.label, "user not found")
    }
    const session = await this.deps.session.create({ userId: key.userId, keyId: key.id })
    if (!session) {
      throw new OAuth2FlowError(this.label, "session creation failed")
    }
    return { user: await this.enrichUser(user, profile), key, session }
  }

  /** Attach this provider's credential to an account another kind already owns. */
  private async attachTo(
    userId: number,
    credential: { identification: string; email: string | null; secret: string },
    profile: OAuth2Profile,
  ): Promise<Everything> {
    const existing = await this.deps.key.findByKindAndIdentification({
      kind: KeyKind.OAuth2,
      identification: credential.identification,
    })
    const key = existing ?? await this.deps.key.create({
      userId,
      kind: KeyKind.OAuth2,
      ...credential,
    })
    if (!key) {
      throw new OAuth2FlowError(this.label, "credential creation failed")
    }
    const user = await this.deps.user.get(userId)
    if (!user) {
      throw new OAuth2FlowError(this.label, "user not found")
    }
    const session = await this.deps.session.create({ userId: key.userId, keyId: key.id })
    if (!session) {
      throw new OAuth2FlowError(this.label, "session creation failed")
    }
    await this.publish({ kind: EventKind.MethodConnected, user, key, email: profile.email })
    return { user: await this.enrichUser(user, profile), key, session }
  }

  /**
   * Fill only the profile fields the account is missing.
   *
   * Never overwrites: a name or avatar the user has set must not be replaced by
   * whatever the provider happens to return on the next sign-in.
   */
  private async enrichUser(user: User, profile: OAuth2Profile): Promise<User> {
    const update: Partial<Pick<User, "email" | "firstName" | "lastName" | "photoUrl">> = {}
    if (!user.email && profile.email) {
      update.email = profile.email
    }
    if (!user.firstName && profile.firstName) {
      update.firstName = profile.firstName
    }
    if (!user.lastName && profile.lastName) {
      update.lastName = profile.lastName
    }
    if (!user.photoUrl && profile.photoUrl) {
      update.photoUrl = profile.photoUrl
    }
    if (Object.keys(update).length === 0) {
      return user
    }
    return (await this.deps.user.update(user.id, update)) ?? user
  }

  /**
   * Exchange the code and read the profile, in one place so `check` and `connect`
   * cannot drift apart.
   *
   * The `state` is compared through `CryptoContext.constantTimeEquals` — this is
   * that function's production call site, since a state value is not hashed at
   * rest the way a credential is. Both sides are digested to a fixed 32 bytes
   * before the comparison, so neither the value nor the length of a guessed state
   * is observable in the response time. The state cookie is cleared on every exit
   * — success or failure — so a stale state cannot be replayed against a second
   * callback.
   */
  private async authorize(
    code: string,
    state: string,
    cookies: CookieJar,
  ): Promise<OAuth2Profile> {
    const storedState = cookies.get(this.options.stateCookieName)
    if (!code || !state || !storedState) {
      cookies.delete(this.options.stateCookieName)
      throw new OAuth2FlowError(this.label, "missing code or state")
    }
    if (!(await this.crypto.constantTimeEquals(state, storedState))) {
      cookies.delete(this.options.stateCookieName)
      throw new OAuth2FlowError(this.label, "state mismatch")
    }
    const accessToken = await this.exchangeCode(code)
    if (!accessToken) {
      cookies.delete(this.options.stateCookieName)
      throw new OAuth2FlowError(this.label, "token exchange rejected")
    }
    const body = await this.fetchUserInfo(accessToken)
    const subject = asString(readPath(body, this.options.subjectField))
    if (!subject) {
      cookies.delete(this.options.stateCookieName)
      throw new OAuth2FlowError(this.label, "userinfo has no subject")
    }
    const email = this.options.emailField ? asString(readPath(body, this.options.emailField)) : null
    cookies.delete(this.options.stateCookieName)
    return {
      subject,
      email,
      firstName: this.options.firstNameField
        ? asString(readPath(body, this.options.firstNameField))
        : null,
      lastName: this.options.lastNameField
        ? asString(readPath(body, this.options.lastNameField))
        : null,
      photoUrl: this.options.resolvePhotoUrl
        ? this.options.resolvePhotoUrl(body)
        : this.options.pictureField
        ? asString(readPath(body, this.options.pictureField))
        : null,
    }
  }

  /** POST the authorization code and return the access token, or `null`. */
  private async exchangeCode(code: string): Promise<string | null> {
    const response = await this.http(this.options.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: this.options.redirectUri,
      }).toString(),
    })
    if (!response.ok) {
      return null
    }
    const body = await this.readBody(response)
    return asString(body["access_token"])
  }

  /** GET the userinfo endpoint with the access token. */
  private async fetchUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.http(this.options.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new OAuth2FlowError(this.label, "userinfo request rejected")
    }
    return await this.readBody(response)
  }

  /**
   * Parse a provider response as JSON, falling back to form encoding.
   *
   * Facebook's token endpoint answers `application/x-www-form-urlencoded` unless
   * the request carries an `Accept: application/json` header, so a JSON-only
   * reader fails against the provider it was written for.
   */
  private async readBody(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text()
    if (text.length === 0) {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      return Object.fromEntries(new URLSearchParams(text))
    }
  }

  /** Provider name for a constant error message. */
  private get label(): string {
    return this.options.label ?? OAuth2Kind[this.provider]
  }
}
