/**
 * The DI factory: one adapter, one pepper, one set of explicit options in; one
 * assembled `Auth` out.
 *
 * The shape is the source's (`roley/auth/lib.ts`), which was right. What changed:
 *
 *  - **No environment reads.** The source pulled `env.APP_URL`,
 *    `env.AUTH_GOOGLE_CLIENT_ID`, `env.AUTH_FACEBOOK_APP_ID` and friends from
 *    SvelteKit's `$env/dynamic/private` at module scope, so the module could not
 *    be imported before the environment existed and could not be tested without
 *    it. Every value is an option here, and a test imports this module in a
 *    process with no environment set to prove it does not throw.
 *  - **The pepper is required and fails closed.** No `'custom-auth'` default, no
 *    module-level read. A missing or blank pepper throws `MissingPepperError`
 *    during construction.
 *  - **One OAuth2 provider type, N instances.** Google and Facebook were the same
 *    class with different options, so `auth.oauth2.google` and
 *    `auth.oauth2.facebook` exist without the 250 duplicated lines.
 *  - **The event bus is per instance, not a process singleton.** Two `Auth`
 *    instances — the normal case in tests, and a legitimate case for two products
 *    in one process — cannot see each other's events.
 *
 * `Auth` exposes named fields rather than the source's nine-positional-argument
 * constructor, in which two providers of the same shape could be swapped without
 * a type error.
 */

import { assertPepper, CryptoContext } from "./crypto.ts"
import type { ProviderDeps } from "./providers/provider.ts"
import { AnonymousProvider } from "./providers/anonymous.ts"
import { EmailPasswordProvider } from "./providers/email-password.ts"
import { MagicLinkProvider } from "./providers/magic-link.ts"
import { OtpProvider } from "./providers/otp.ts"
import { OAuth2Provider } from "./providers/oauth2.ts"
import { KeyManager } from "./managers/key.ts"
import { UserManager } from "./managers/user.ts"
import { type NegativeSessionCache, SessionManager, type SessionStore } from "./session.ts"
import { createLinkHandlers, type LinkableProvider } from "./account-linking.ts"
import { AuthEventBus } from "./events.ts"
import type { AuthEvent, AuthEventContext, AuthEventHandler } from "./events.ts"
import type {
  Adapter,
  IAnonymousProvider,
  IEmailPasswordProvider,
  IKeyManager,
  IMagicLinkProvider,
  IOAuth2Provider,
  IOtpProvider,
  IUserManager,
  SessionSink,
} from "./types.ts"
import { OAuth2Provider as OAuth2Kind } from "./types.ts"

/** One OAuth2 instance. `provider`, the URLs and the field paths are what differ per vendor. */
export interface OAuth2InstanceOptions {
  provider: OAuth2Kind
  /** Lower-case vendor name used in constant error messages. */
  label?: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  /** Query parameters the userinfo endpoint needs, e.g. Facebook's `fields`. */
  userInfoParams?: Record<string, string>
  scope: string
  clientId: string
  clientSecret: string
  redirectUri: string
  stateCookieName: string
  subjectField: string
  emailField?: string
  firstNameField?: string
  lastNameField?: string
  pictureField?: string
  /** Called with the userinfo object when the avatar path needs flattening. */
  resolvePhotoUrl?: (profile: Record<string, unknown>) => string | null
  /** HTTP client for this provider. Injected in tests; defaults to global `fetch`. */
  fetch?: typeof fetch
}

/** Everything `createAuth` needs. Only `adapter` and `passwordPepper` are required. */
export interface AuthOptions {
  adapter: Adapter
  /**
   * Deployment pepper mixed into every stored secret. Required and non-blank.
   * Reading it from the environment is the caller's job — this module never does.
   */
  passwordPepper: string
  /** Base URL a magic link or OTP redirect points at, without query. */
  appUrl?: string
  /** Characters in a session token. */
  sessionLength?: number
  /** Session lifetime in minutes. */
  sessionDurationMin?: number
  /** PBKDF2 iterations. Lowered by tests; never lowered in a deployment. */
  hashIterations?: number
  /** Credential lifetime in milliseconds, for OTP and magic link alike. */
  credentialTtlMs?: number
  /** Failed verifications of one OTP or magic link before it locks out. */
  maxAttempts?: number
  /** OAuth2 instances to build, keyed by the name the caller wants to use. */
  oauth2?: Record<string, OAuth2InstanceOptions>
  /**
   * Writes the session cookie. Omit when the transport reads `Everything.session`
   * directly. A provider never sets a session cookie itself either way.
   */
  sessionSink?: SessionSink
  /** TTL cache over dead session tokens. Omitted disables the negative cache. */
  negativeSessionCache?: NegativeSessionCache
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Receives handler failures. Defaults to a fixed-shape `console.error` line. */
  onEventError?: (event: AuthEvent, error: unknown) => void
}

/** One assembled auth system. */
export class Auth {
  readonly user: IUserManager
  readonly key: IKeyManager
  readonly session: SessionManager
  readonly anonymous: IAnonymousProvider
  readonly emailPassword: IEmailPasswordProvider
  readonly magicLink: IMagicLinkProvider
  readonly otp: IOtpProvider
  readonly oauth2: Readonly<Record<string, IOAuth2Provider>>
  readonly bus: AuthEventBus
  /** Present only when the caller supplied `sessionSink`. */
  readonly sessionSink: SessionSink | undefined

  constructor(init: {
    user: IUserManager
    key: IKeyManager
    session: SessionManager
    anonymous: IAnonymousProvider
    emailPassword: IEmailPasswordProvider
    magicLink: IMagicLinkProvider
    otp: IOtpProvider
    oauth2: Readonly<Record<string, IOAuth2Provider>>
    bus: AuthEventBus
    sessionSink?: SessionSink
  }) {
    this.user = init.user
    this.key = init.key
    this.session = init.session
    this.anonymous = init.anonymous
    this.emailPassword = init.emailPassword
    this.magicLink = init.magicLink
    this.otp = init.otp
    this.oauth2 = init.oauth2
    this.bus = init.bus
    this.sessionSink = init.sessionSink
  }

  /** Subscribe an extra handler. Returns an unsubscribe function. */
  subscribe(handler: AuthEventHandler): () => void {
    return this.bus.subscribe(handler)
  }
}

/** Fallback redirect base. An email link needs an absolute URL; a deployment must supply one. */
const DEFAULT_APP_URL = "http://localhost:3000"

/**
 * Build an `Auth` from an adapter and an explicit option set.
 *
 * Throws `MissingPepperError` when `passwordPepper` is absent or blank — the one
 * failure that must not be silent, because the alternative is hashing every
 * password in a deployment with a string an attacker can read out of this
 * repository.
 */
export function createAuth(options: AuthOptions): Auth {
  assertPepper(options.passwordPepper)
  const crypto = new CryptoContext({
    pepper: options.passwordPepper,
    iterations: options.hashIterations,
  })
  const now = options.now ?? Date.now

  const session = new SessionManager({
    store: options.adapter as SessionStore,
    crypto,
    negativeCache: options.negativeSessionCache,
    sessionLength: options.sessionLength,
    sessionDurationMin: options.sessionDurationMin,
    now,
  })
  const key = new KeyManager(options.adapter)
  const user = new UserManager(options.adapter)
  const bus = new AuthEventBus(options.onEventError)

  const deps: ProviderDeps = { user, key, session }

  // Linking resolves its targets lazily. The handlers need the providers, the
  // providers publish to the bus, and the bus holds the handlers: closing that in
  // a constructor would be a cycle, closing it through a getter is not.
  let magicLink: MagicLinkProvider | null = null
  let otp: OtpProvider | null = null
  let anonymousProvider: IAnonymousProvider | null = null

  const context: AuthEventContext = {
    publish: (event) => bus.dispatch(event, context).then(() => undefined),
    setUserEmail: (userId, email) => user.update(userId, { email }).then(() => undefined),
  }
  const publish = (event: AuthEvent): Promise<void> =>
    bus.dispatch(event, context).then(() => undefined)

  const anonymous = new AnonymousProvider({ ...deps, publish })
  anonymousProvider = anonymous

  const emailPassword = new EmailPasswordProvider({ ...deps, crypto, publish, now })
  magicLink = new MagicLinkProvider({
    ...deps,
    crypto,
    publish,
    now,
    redirectUri: `${options.appUrl ?? DEFAULT_APP_URL}/auth`,
    ttlMs: options.credentialTtlMs,
    maxAttempts: options.maxAttempts,
  })
  otp = new OtpProvider({
    ...deps,
    crypto,
    publish,
    now,
    ttlMs: options.credentialTtlMs,
    maxAttempts: options.maxAttempts,
  })

  const oauth2: Record<string, IOAuth2Provider> = {}
  for (const [name, instance] of Object.entries(options.oauth2 ?? {})) {
    oauth2[name] = new OAuth2Provider({ ...deps, crypto, publish, ...instance })
  }

  const linkedMagicLink = magicLink
  const linkedOtp = otp
  const providers = (): LinkableProvider[] => [linkedMagicLink, linkedOtp]

  for (
    const handler of createLinkHandlers({
      key,
      getProviders: providers,
      getAnonymous: () => anonymousProvider,
    })
  ) {
    bus.subscribe(handler)
  }

  return new Auth({
    user,
    key,
    session,
    anonymous,
    emailPassword,
    magicLink: linkedMagicLink,
    otp: linkedOtp,
    oauth2,
    bus,
    sessionSink: options.sessionSink,
  })
}
