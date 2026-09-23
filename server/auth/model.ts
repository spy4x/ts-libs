/**
 * The sign-in account model: a minimal user, the ways that user signs in ("keys"), and the
 * guess-counted challenges a provider issues (a code sent by email, a password-reset code).
 *
 * Written from the rules in issue #57, not moved from the earlier `server/auth/types.ts`. The rules
 * this file carries:
 *
 * - A key has a proven or an unproven state (`provenAt`). Only a proven address can link sign-in
 *   methods to an existing user, and at most one user owns a proven address.
 * - A user has no app fields. The app keeps its profile in its own table, keyed by `AuthUser.id`.
 * - A sign-in method is a free string, so a provider is added by configuration, never by editing an
 *   enum.
 * - Addresses are compared in one normal form, so `A@X.com` and `a@x.com` are one address.
 *
 * @module
 */

import { isAddress } from "@ts-libs/email/address"
import type { SessionRecord } from "@ts-libs/server/sign-in"

/** A signed-in person. Minimal on purpose: the app keeps its profile in its own table keyed by `id`. */
export interface AuthUser {
  /** Positive integer from the store. */
  id: number
  createdAt: Date
  /** A deleted user can never sign in. */
  deletedAt: Date | null
}

/**
 * One way of signing in. `method` is a free string chosen by the provider or the app ("password",
 * "email-code", "oauth:google", …) — never an enum, so a provider is added by configuration.
 */
export interface AuthKey {
  id: number
  userId: number
  method: string
  /**
   * Unique per method: the normalised email for password and email-code, the provider's own user
   * id ("sub") for OAuth. The store refuses a second key with the same (method, subject).
   */
  subject: string
  /**
   * The normalised address this key carries, or null. Set it whenever the subject is an address: a
   * key whose subject is an address but whose `email` is null is invisible to eviction, so the
   * person who proves that address cannot displace it.
   */
  email: string | null
  /** A stored secret such as a password hash. Never a raw secret. */
  secret: string | null
  /** When ownership of `email` was proven for this key; null = unproven. */
  provenAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** The fields a caller supplies for a new key. The store assigns the rest. */
export interface NewAuthKey {
  method: string
  subject: string
  /**
   * The normalised address, or null. Set it whenever the subject is an address: a key whose subject
   * is an address but whose `email` is null is invisible to eviction.
   */
  email: string | null
  secret: string | null
  provenAt: Date | null
}

/** Session row: `SessionRecord` from `@ts-libs/server/sign-in` plus the key that created it. */
export interface AuthSessionRecord extends SessionRecord {
  keyId: number
}

/** Longest address {@link normalizeEmail} accepts: the limit of an SMTP forward path (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254

/**
 * Lower-cases and trims an address and checks its shape; null when it is not an address.
 * "A@X.com" and "a@x.com" normalise to the same value.
 *
 * The shape check is `isAddress` from `@ts-libs/email/address`, so every address this accepts is
 * one the email package will send to.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null
  return isAddress(email) ? email : null
}

/** What {@link AuthStore.attemptChallenge} found. Numbered from 1 so no outcome is falsy. */
export enum ChallengeOutcome {
  /** The guess matched. The challenge is consumed; the same code never matches again. */
  Matched = 1,
  /** The guess was compared, did not match, and was counted. */
  WrongGuess = 2,
  /** The challenge has used up its guesses. Nothing was compared. */
  LockedOut = 3,
  /** No live challenge: never issued, already consumed, or expired. Nothing was compared. */
  Missing = 4,
}

/** Which uniqueness rule a refused write would have broken. */
export type AuthConflictReason =
  /** Another key already has this (method, subject). */
  | "key-exists"
  /** Another user already owns this proven address. */
  | "email-owned"

/** Thrown by the store when a write would break a uniqueness rule. `reason` names which. */
export class AuthConflictError extends Error {
  readonly reason: AuthConflictReason

  constructor(reason: AuthConflictReason, message?: string) {
    super(message ?? defaultConflictMessage(reason))
    this.name = "AuthConflictError"
    this.reason = reason
  }
}

function defaultConflictMessage(reason: AuthConflictReason): string {
  return reason === "key-exists"
    ? "a key with this method and subject already exists"
    : "another user already owns this address"
}
