/**
 * `AuthStore`: persistence for users, keys and guess-counted challenges.
 *
 * Two implementations ship: `createPostgresAuthStore` (`@spy4x/server/auth/postgres`) for
 * production and `MemoryAuthStore` (`@spy4x/server/auth/memory-store`) for unit tests. One
 * contract suite (`store-contract.test.ts`) runs against both, so a provider tested against the
 * memory store relies only on behaviour Postgres also has.
 *
 * @module
 */

import type { AuthKey, AuthUser, ChallengeOutcome, NewAuthKey } from "./model.ts"

/** Input of {@link AuthStore.issueChallenge}. */
export interface IssueChallengeInput {
  /** What the challenge is for, chosen by the provider, e.g. "email-code" or "password-reset". */
  purpose: string
  /** Whom it is for, e.g. a normalised address. */
  subject: string
  /** A hash of the code. Never the raw code. */
  secretHash: string
  expiresAt: Date
  now: Date
}

/** Input of {@link AuthStore.attemptChallenge}. */
export interface AttemptChallengeInput {
  purpose: string
  subject: string
  /** The hash of the guessed code, computed the same way as the issued `secretHash`. */
  secretHash: string
  /** Guesses allowed per challenge, a positive integer. */
  maxAttempts: number
  now: Date
}

/**
 * Users, keys and challenges. Every method that writes more than one row does so atomically: a
 * refused write changes nothing.
 */
export interface AuthStore {
  findUser(id: number): Promise<AuthUser | null>
  /** Creates a user and its first key atomically. Throws AuthConflictError; creates nothing then. */
  createUserWithKey(key: NewAuthKey): Promise<{ user: AuthUser; key: AuthKey }>
  /** Adds a key to an existing user. Throws AuthConflictError. */
  addKey(userId: number, key: NewAuthKey): Promise<AuthKey>
  findKey(method: string, subject: string): Promise<AuthKey | null>
  findKeyById(id: number): Promise<AuthKey | null>
  listKeys(userId: number): Promise<AuthKey[]>
  /** The user who owns this proven address, or null. At most one user owns a proven address. */
  findUserIdByProvenEmail(email: string): Promise<number | null>
  /**
   * Marks the key proven and makes its user the owner of its address, atomically. In the same
   * transaction it deletes every other user's UNPROVEN key that carries that address (a
   * pre-registered claim loses to the person who proves the address). Throws AuthConflictError
   * ("email-owned") and changes nothing when another user already owns the address. A key with no
   * email throws TypeError.
   */
  proveKey(keyId: number, now: Date): Promise<AuthKey>
  /** Replaces the key's secret. false when the key does not exist. */
  updateKeySecret(keyId: number, secret: string): Promise<boolean>
  /** Deletes exactly this key of this user and nothing else. false when no such key. */
  deleteKey(userId: number, keyId: number): Promise<boolean>
  /**
   * Stores a new challenge secret (a hash, never the raw code) for (purpose, subject), replacing any
   * earlier secret and expiry. The guess counter is KEPT when a challenge for the same
   * (purpose, subject) exists and has not expired; it starts at 0 only when there was none or the
   * previous one had expired. So asking for a new code never resets the counter.
   */
  issueChallenge(input: IssueChallengeInput): Promise<void>
  /**
   * Checks one guess and counts it in ONE database statement. Counts the guess only while the
   * challenge exists, has not expired and has fewer than `maxAttempts` guesses. Matched consumes
   * the challenge (a second use of the same code is Missing). N parallel calls with maxAttempts M
   * compare at most M guesses.
   */
  attemptChallenge(input: AttemptChallengeInput): Promise<ChallengeOutcome>
}

/** The method names of {@link AuthStore}, sorted. The contract suite checks both stores against it. */
export const AUTH_STORE_METHODS: readonly string[] = [
  "addKey",
  "attemptChallenge",
  "createUserWithKey",
  "deleteKey",
  "findKey",
  "findKeyById",
  "findUser",
  "findUserIdByProvenEmail",
  "issueChallenge",
  "listKeys",
  "proveKey",
  "updateKeySecret",
]
