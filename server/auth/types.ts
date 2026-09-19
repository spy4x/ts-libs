/**
 * The ported contract of the `roley` auth system: the record shapes, the adapter
 * interface every persistence backend implements, and the provider interfaces
 * that `lib.ts` assembles.
 *
 * Two deliberate departures from the source, both security-driven:
 *
 *  - `KeyKind` is numbered from 1. The source started `EMAIL_PASSWORD` at 0, so
 *    every `if (!kind)` guard silently treated an email-password key as "no key".
 *  - `KeyBase` carries `expiresAt` and `attempts`. The source had nowhere to
 *    record an OTP's deadline or failure count, so a consumed code stayed valid
 *    forever. See `providers/otp.ts` and `providers/magic-link.ts`.
 *
 * Nothing here knows about SvelteKit, Hono, Deno KV or Postgres. Cookies arrive
 * as the `CookieJar` below and sessions are written through `SessionContext`, so
 * the same provider runs in a worker, a serverless handler or a test.
 */

/**
 * How a key identifies its holder. The numeric values are persisted, so a
 * renumbering is a data migration — `docs` in the PR body record the stance.
 */
export enum KeyKind {
  /** `identification` is an email, `secret` a password hash. */
  EmailPassword = 1,
  /** `identification` is an email, `secret` a single-use reset-token hash. */
  EmailPasswordReset = 2,
  /**
   * `identification` is an email when the provider supplies a verified one
   * (else the subject id), `secret` is the OAuth subject id. Google and
   * Facebook share this kind; `OAuth2Provider` discriminates them.
   */
  OAuth2 = 3,
  /** `identification` is a random opaque id. */
  Anonymous = 4,
  /** `identification` is an email, `secret` a single-use token hash. */
  MagicLink = 5,
  /** `identification` is an email, `secret` a single-use OTP hash. */
  Otp = 6,
}

/** Identity-provider discriminator for `KeyKind.OAuth2`. */
export enum OAuth2Provider {
  Google = 1,
  Facebook = 2,
}

/** Fields every persisted record carries. */
export interface BaseModel {
  id: number
  createdAt: Date
  updatedAt: Date
}

/** The account. `email` is null until a method supplies one. */
export interface UserBase extends BaseModel {
  email: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
  permission: null | number
}

/** An account. Distinct name from `UserBase` so a partial update cannot be passed as a user. */
export interface User extends UserBase {}

/**
 * A credential attached to a user.
 *
 * `attempts` is the running count of failed verifications for this key and is
 * only meaningful for the single-use kinds. `expiresAt` is the deadline of the
 * credential currently stored in `secret`; once it passes the key is inert.
 */
export interface KeyBase {
  userId: number
  kind: KeyKind
  /**
   * What this credential is keyed on, unique within `kind`.
   *
   * For most kinds that is the address. For `KeyKind.OAuth2` it is
   * `<provider>:<subject id>`, because one address can hold a Google and a
   * Facebook credential at once and a single `identification` column cannot key
   * both — see `email`.
   */
  identification: string
  /**
   * The address this credential was established with, when it knows one.
   *
   * This is the column account linking searches: a credential for an address that
   * already exists attaches to that account whatever the other credential's
   * `kind` is. Without it, two OAuth2 providers for one address would each create
   * an account, and a magic-link-only account could never be found by an OAuth2
   * signup.
   */
  email?: null | string
  /** Password hash, OTP hash or single-use link-token hash. */
  secret?: null | string
  /** Deadline of the credential in `secret`. Null for durable credentials. */
  expiresAt?: null | Date
  /** Failed verification count for the credential in `secret`. */
  attempts?: number
}

/** A credential attached to a user. */
export interface Key extends KeyBase, BaseModel {}

/**
 * The credential fields needed to create a key for a user that does not exist
 * yet. `userId` is assigned by the adapter inside the creating transaction, which
 * is why it is absent here.
 */
export type NewKeyLike = Pick<
  KeyBase,
  "kind" | "identification" | "secret" | "expiresAt" | "attempts" | "email"
>

/** The transport-visible half of a session. `token` is the raw, unhashed token. */ export interface SessionBase {
  token: string
  userId: number
  keyId: number
  expiresAt?: null | Date
}

/** A signed-in session. */
export interface Session extends SessionBase, BaseModel {}

/**
 * What a provider needs in order to mint a session, without knowing how one is
 * stored. `lib.ts` binds this to the `SessionManager`; a test binds it to a fake.
 */
export interface SessionContext {
  create(session: Pick<SessionBase, "userId" | "keyId">): Promise<null | Session>
  /** Revoke every session of an account. A password change must not leave them alive. */
  deleteAll(userId: number): Promise<void>
  createBody(
    session: Pick<SessionBase, "userId" | "keyId">,
  ): Promise<{ notHashedToken: string; session: SessionBase }>
}

/** A user, the credential they authenticated with, and their new session. */
export interface Everything {
  user: User
  key: Key
  session: Session
}

/** The minimal cookie surface an OAuth2 flow needs. Satisfied by `Cookies` and by Hono's helper. */
export interface CookieJar {
  get(name: string): string | undefined
  set(name: string, value: string, options?: CookieOptions): void
  delete(name: string): void
}

/** Cookie attributes a state cookie uses. */
export interface CookieOptions {
  path?: string
  maxAge?: number
  httpOnly?: boolean
  sameSite?: "strict" | "lax" | "none"
  secure?: boolean
}

/**
 * Hands a freshly minted session to the transport. Providers never write a
 * cookie themselves — the source called `setSession(cookies, ...)` inside the
 * Google flow, which made that provider unusable outside SvelteKit.
 */
export interface SessionSink {
  setSession(session: Session): void
  /** The opaque value a transport puts in its cookie: `<sessionId>:<rawToken>`. */
  getIdToken(session: Session): string
}

/**
 * Persistence. Every method is total: a miss is `null`, never a throw, so a
 * provider decides whether a miss is an error. Any backend — Postgres, SQLite,
 * KV, an in-memory fake — implements this and nothing else.
 */
export interface Adapter {
  getUser(id: number): Promise<null | User>
  createUser(payload?: Partial<UserBase>): Promise<User>
  createUserWithEverything(
    key: NewKeyLike,
    session: SessionBase,
    user?: Partial<UserBase>,
  ): Promise<Everything>
  updateUser(id: number, update: Partial<UserBase>): Promise<null | User>

  getKey(id: number): Promise<null | Key>
  getAllKeys(userId: number): Promise<Key[]>
  createKey(
    key: NewKeyLike & Pick<KeyBase, "userId">,
  ): Promise<null | Key>
  deleteKey(key: Pick<KeyBase, "userId" | "kind">): Promise<boolean>
  deleteKeyById(id: number): Promise<void>
  updateKey(id: number, key: Partial<KeyBase>): Promise<null | Key>
  findKeyByIdentification(identification: KeyBase["identification"]): Promise<null | Key>
  /**
   * The credential, of any kind, established with an address.
   *
   * `null` when no credential carries that address. Used by the linking path, and
   * separate from `findKeyByIdentification` precisely because an OAuth2
   * credential's identification is provider-scoped rather than an address.
   */
  findKeyByEmail(email: string): Promise<null | Key>
  findKeyByKindAndIdentification(
    key: Pick<KeyBase, "kind" | "identification">,
  ): Promise<null | Key>
  findKeyByUserId(key: Pick<Key, "kind" | "userId">): Promise<null | Key>

  getSession(id: number): Promise<null | Session>
  getAllSessions(userId: number): Promise<Session[]>
  createSession(
    session: Pick<SessionBase, "token" | "userId" | "keyId" | "expiresAt">,
  ): Promise<null | Session>
  updateSession(id: number, session: Partial<SessionBase>): Promise<null | Session>
  deleteSession(id: number): Promise<void>
  deleteSessionByIdToken(id: number, token: string): Promise<void>
  deleteAllSessions(userId: number): Promise<void>
  deleteExpiredSessions(): Promise<void>
}

/** Session minting and validation. Implemented by `managers/session.ts`. */
export interface ISessionManager extends SessionContext {
  get(id: number): Promise<null | Session>
  getAll(userId: number): Promise<Session[]>
  validate(sessionIdToken: string): Promise<null | Session>
  getIdTokenForCookie(session: Session): string
  parseSessionIdToken(sessionIdToken: string): null | { id: number; token: string }
  create(session: Pick<SessionBase, "userId" | "keyId">): Promise<null | Session>
  update(id: number, session: Partial<SessionBase>): Promise<null | Session>
  delete(sessionIdToken: string): Promise<boolean>
  deleteAll(userId: number): Promise<void>
  deleteExpired(): Promise<void>
}

/** Account reads and writes. Implemented by `managers/user.ts`. */
export interface IUserManager {
  get(id: number): Promise<null | User>
  create(payload?: Partial<UserBase>): Promise<User>
  createWithEverything(
    key: NewKeyLike,
    session: SessionBase,
    user?: Partial<UserBase>,
  ): Promise<Everything>
  update(id: number, user: Partial<UserBase>): Promise<null | User>
}

/** Credential reads and writes. Implemented by `managers/key.ts`. */
export interface IKeyManager {
  get(keyId: number): Promise<null | Key>
  getAll(userId: number): Promise<Key[]>
  findByIdentification(identification: KeyBase["identification"]): Promise<null | Key>
  findByEmail(email: string): Promise<null | Key>
  findByKindAndIdentification(
    key: Pick<KeyBase, "kind" | "identification">,
  ): Promise<null | Key>
  findByUserId(key: Pick<KeyBase, "kind" | "userId">): Promise<null | Key>
  create(
    key: NewKeyLike & Pick<KeyBase, "userId">,
  ): Promise<null | Key>
  update(keyId: number, key: Partial<KeyBase>): Promise<null | Key>
  delete(key: Pick<KeyBase, "userId" | "kind">): Promise<boolean>
  deleteById(keyId: number): Promise<void>
}

/** An account created before it authenticates with anything durable. */
export interface IAnonymousProvider {
  isAnonymous(userId: number): Promise<boolean>
  signUp(): Promise<Everything>
  disconnect(userId: number): Promise<boolean>
}

/** Email + password, including the reset-token flow. */
export interface IEmailPasswordProvider {
  signUp(email: string, password: string): Promise<Everything>
  signIn(email: string, password: string): Promise<null | Everything>
  connect(userId: number, email: string, password: string): Promise<null | Everything>
  disconnect(userId: number): Promise<boolean>
  getUserByEmail(email: string): Promise<null | User>
  createPasswordResetToken(email: string): Promise<null | string>
  validatePasswordResetToken(
    email: string,
    token: string,
    newPassword: string,
  ): Promise<null | Session>
  isEmailTaken(email: string): Promise<boolean>
  changeEmail(userId: number, email: string, password: string): Promise<boolean>
  changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<null | Session>
  hashPassword(password: string): Promise<string>
  checkPassword(password: string, hash: string): Promise<boolean>
}

/**
 * Single-use emailed link. The token is returned exactly once, to the caller
 * that emails it — only its hash is persisted.
 */
export interface IMagicLinkProvider {
  signIn(email: string): Promise<string>
  signUp(email: string): Promise<string>
  getUserByEmail(email: string): Promise<null | User>
  /**
   * Create a link key not yet attached to an account (`userId: -1`), for a caller
   * that mails the link and links the key on first use.
   *
   * The raw token travels beside the key and is returned exactly once; the source
   * declared this method and then returned `null` unconditionally.
   */
  createToken(email: string): Promise<null | { key: Key; notHashedToken: string }>
  changeEmail(userId: number, email: string): Promise<string>
  getRedirectURL(email: string, token: string): string
  check(email: string, token: string): Promise<null | Everything>
  connect(userId: number, email: string): Promise<Everything>
  disconnect(userId: number): Promise<boolean>
  exists(existingUserId: number): Promise<null | Key>
  /**
   * Constant-time token comparison, against the stored digest rather than a raw
   * token. Exposed because it is the security-critical step and a caller replacing
   * `check` needs the same guarantee.
   */
  verifyToken(provided: string, storedSecret: string): Promise<boolean>
}

/** Single-use emailed code, with a deadline and a failed-attempt lockout. */
export interface IOtpProvider {
  generateOtp(): Promise<string>
  signUp(email: string): Promise<string>
  signIn(email: string): Promise<string>
  check(email: string, otp: string): Promise<null | Everything>
  changeEmail(userId: number, email: string): Promise<string>
  connect(userId: number, email: string): Promise<Everything>
  disconnect(userId: number): Promise<boolean>
}

/**
 * One configurable OAuth2 authorization-code provider. Google and Facebook were
 * verbatim clones in the source; the differences are the URLs, the scope and the
 * field names, all of which are options here.
 */
export interface IOAuth2Provider {
  /** Provider discriminator, so two instances keep separate keys. */
  readonly provider: OAuth2Provider
  getRedirectURL(cookies: CookieJar): string
  exists(userId: number): Promise<null | Key>
  connect(code: string, state: string, cookies: CookieJar, userId: number): Promise<Key>
  disconnect(userId: number): Promise<boolean>
  check(code: string, state: string, cookies: CookieJar): Promise<Everything>
}
