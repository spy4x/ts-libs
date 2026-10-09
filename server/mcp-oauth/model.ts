/**
 * Records and the storage port of the single-user OAuth authorization server.
 *
 * Every secret the server hands out (pending consent id, authorization code, access token, refresh
 * token) is a 256-bit random string. Only its SHA-256 hex digest is ever passed to the store, so a
 * leaked database does not leak a usable credential.
 * @module
 */

/** An authorization request that passed every check and waits for the owner's click. */
export interface PendingAuthorization {
  /** The `client_id`, an HTTPS URL to the client's metadata document. */
  clientId: string
  /** The client's display name from its metadata document. Self-asserted: never trust it. */
  clientName: string
  /** The exact `redirect_uri` of the request. */
  redirectUri: string
  /** The S256 `code_challenge`. */
  codeChallenge: string
  /** The canonical resource (audience) the tokens will be bound to. */
  resource: string
  /** Granted scopes, space separated; empty when none were asked for. */
  scope: string
  /** The client's `state`, echoed back untouched; `undefined` when the client sent none. */
  state: string | undefined
  /** Epoch milliseconds after which the consent page can no longer be approved. */
  expiresAt: number
}

/** An issued authorization code. */
export interface CodeRecord {
  /** Every token minted from this code shares this id, so a replay can revoke them all. */
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource: string
  scope: string
  /** Epoch milliseconds after which the code is refused. */
  expiresAt: number
  /** Epoch milliseconds of the first redemption; `undefined` until then. */
  usedAt?: number
  /**
   * Epoch milliseconds the grant ends at: no token minted from this code, or from a refresh of
   * those, outlives it. Unset only on records written before grants had an end.
   */
  grantExpiresAt?: number
}

/** An issued access token. */
export interface AccessTokenRecord {
  grantId: string
  clientId: string
  /** The audience: the only resource server that may accept this token. */
  resource: string
  scope: string
  expiresAt: number
}

/** An issued refresh token. Rotated on every use. */
export interface RefreshTokenRecord {
  grantId: string
  clientId: string
  resource: string
  scope: string
  expiresAt: number
  /** Epoch milliseconds of the redemption that rotated it; `undefined` while it is current. */
  usedAt?: number
  /**
   * Epoch milliseconds the grant ends at; a rotation never moves it. Unset only on tokens issued
   * before grants had an end: their first rotation gives the grant one.
   */
  grantExpiresAt?: number
}

/**
 * One client the owner approved: what `listGrants` shows, so the owner can see who is connected and
 * revoke one without signing every client out. Saved when the code is redeemed.
 */
export interface GrantRecord {
  /** Pass it to {@link OAuthStore.revokeGrant} to sign this client out. */
  grantId: string
  /** The client's `client_id` URL. Its host is who the owner approved. */
  clientId: string
  /** The canonical resource the grant's tokens work for. */
  resource: string
  /** Granted scopes, space separated; empty when none were asked for. */
  scope: string
  /** Epoch milliseconds the grant was saved at. */
  createdAt: number
  /**
   * Epoch milliseconds the grant ends at, whatever its refresh tokens do. Revoking with this as
   * `until` refuses the grant for good.
   */
  expiresAt: number
}

/**
 * A one-time approval code the owner made from a shell with `createApprovalCode`. Typed into the
 * consent page's password input, it approves once without the owner password and its lockout.
 */
export interface ApprovalCodeRecord {
  /** Epoch milliseconds after which the code is refused. */
  expiresAt: number
}

/**
 * Where the authorization server keeps its state. Keys are SHA-256 hex digests of the secrets.
 *
 * The two `consume*` methods, `takePending` and `takeApprovalCode` must be atomic: two concurrent
 * calls with the same key must not both see the record unused. That is what makes a code single-use
 * and lets a reused refresh token be detected. A store may drop a record once its `expiresAt` has
 * passed; the server checks expiry itself, so keeping it longer is harmless.
 */
export interface OAuthStore {
  /** Save a pending authorization under the digest of its id. */
  savePending(key: string, record: PendingAuthorization): Promise<void>
  /** Remove and return a pending authorization, or `undefined` when there is none. */
  takePending(key: string): Promise<PendingAuthorization | undefined>
  /** Save a new authorization code. */
  saveCode(key: string, record: CodeRecord): Promise<void>
  /**
   * Mark a code used and return the record as it was before: `usedAt` is unset on the first call
   * and set on every later one. `undefined` when there is no such code.
   */
  consumeCode(key: string): Promise<CodeRecord | undefined>
  /**
   * Save a new access token, unless its grant is revoked. Returns `false`, saving nothing, when it
   * is. The check and the save must be atomic with {@link OAuthStore.revokeGrant}.
   */
  saveAccessToken(key: string, record: AccessTokenRecord): Promise<boolean>
  /** Read an access token, or `undefined` when there is none. */
  findAccessToken(key: string): Promise<AccessTokenRecord | undefined>
  /**
   * Delete one access token and nothing else of its grant: what revoking an access token does. Does
   * nothing when there is no such token.
   */
  deleteAccessToken(key: string): Promise<void>
  /** Same contract as {@link OAuthStore.saveAccessToken}, for refresh tokens. */
  saveRefreshToken(key: string, record: RefreshTokenRecord): Promise<boolean>
  /**
   * Read a refresh token without marking it used, or `undefined` when there is none. Lets the
   * server refuse a request that names the wrong resource or scope without spending the token.
   */
  findRefreshToken(key: string): Promise<RefreshTokenRecord | undefined>
  /** Same contract as {@link OAuthStore.consumeCode}, for refresh tokens. */
  consumeRefreshToken(key: string): Promise<RefreshTokenRecord | undefined>
  /**
   * Delete every access and refresh token of a grant and its grant record, and refuse to save new
   * ones for it until `until` (epoch milliseconds). The refusal closes a race: a request that
   * redeemed the code or refresh token first may still be about to save its tokens when the replay
   * revokes the grant.
   */
  revokeGrant(grantId: string, until: number): Promise<void>
  /**
   * Save a grant record, unless its grant is revoked. Same contract as
   * {@link OAuthStore.saveAccessToken}; {@link OAuthStore.revokeGrant} deletes it.
   */
  saveGrant(record: GrantRecord): Promise<boolean>
  /** Every grant whose `expiresAt` has not passed, oldest first. */
  listGrants(): Promise<GrantRecord[]>
  /**
   * Count one password attempt under `key`, unless `limit` attempts made within the `windowMs`
   * milliseconds before `at` are counted already. Returns 0 when it counted the attempt, else how
   * many milliseconds until it would. Atomic: of concurrent calls, at most `limit` see 0. Must
   * survive a restart when the store does, or a restart would reset the owner-password lockout.
   */
  takeAttempt(key: string, at: number, limit: number, windowMs: number): Promise<number>
  /** Uncount one attempt `takeAttempt` counted under `key` at `at`, after a right password. */
  releaseAttempt(key: string, at: number): Promise<void>
  /** Save a one-time approval code under the digest of the code. */
  saveApprovalCode(key: string, record: ApprovalCodeRecord): Promise<void>
  /**
   * Remove and return an approval code, or `undefined` when there is none. Atomic, as
   * {@link OAuthStore.takePending} is: of two concurrent calls, only one gets the record.
   */
  takeApprovalCode(key: string): Promise<ApprovalCodeRecord | undefined>
}

/**
 * Thrown by a store that gave up on a write because other writes to the same key kept winning, as
 * `KvOAuthStore` does after 32 conflicts. The authorization server answers a password attempt that
 * hits it with `429`; any other store error is a failure and surfaces as `500`.
 */
export class OAuthStoreContentionError extends Error {
  override name = "OAuthStoreContentionError"
}
