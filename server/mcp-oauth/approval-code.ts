/**
 * One-time approval codes: how the owner approves a consent while the owner-password lockout is
 * reached. Made from a shell, never over HTTP.
 * @module
 */

import { randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import type { OAuthStore } from "./model.ts"

/** What every approval code starts with, so a typed password is never taken for one. */
export const APPROVAL_CODE_PREFIX = "approve_"
/**
 * The shape of every approval code: {@link APPROVAL_CODE_PREFIX} and 43 base64url characters (256
 * random bits). The server looks a typed value up as a code only when it has this shape, so the
 * store never sees a digest of the owner password.
 */
export const APPROVAL_CODE_SHAPE = /^approve_[A-Za-z0-9_-]{43}$/

/** Default {@link ApprovalCodeOptions.ttlMs}: 5 minutes. */
export const DEFAULT_APPROVAL_CODE_TTL_MS = 5 * 60_000
/**
 * Longest {@link ApprovalCodeOptions.ttlMs} allowed: 15 minutes, so a code is never a standing key.
 */
export const MAX_APPROVAL_CODE_TTL_MS = 15 * 60_000

/** Options for {@link createApprovalCode}. */
export interface ApprovalCodeOptions {
  /**
   * How long the code works, in milliseconds. Defaults to {@link DEFAULT_APPROVAL_CODE_TTL_MS}; at
   * most {@link MAX_APPROVAL_CODE_TTL_MS}.
   */
  ttlMs?: number
  /** Defaults to the system clock. Pass the one the authorization server uses. */
  clock?: Clock
}

/** A code {@link createApprovalCode} made. */
export interface ApprovalCode {
  /**
   * Show this to the owner once; the store keeps only its SHA-256 digest. Matches
   * {@link APPROVAL_CODE_SHAPE}.
   */
  code: string
  /** Epoch milliseconds after which the code is refused. */
  expiresAt: number
}

/**
 * Make a one-time approval code for an authorization server that asks for the owner password. The
 * owner types it into the consent page's password input instead of the password: it approves one
 * pending consent, and neither the password check nor the wrong-password lockout applies to it.
 * The first approval spends it, and it stops working after `ttlMs`.
 *
 * Wrap it in the app's command-line interface, run where the app's store lives, so only someone
 * with a shell on the server can make one. No route of the authorization server makes one.
 *
 * @param store The store the authorization server uses.
 * @throws {RangeError} When `ttlMs` is not positive or is above {@link MAX_APPROVAL_CODE_TTL_MS}.
 */
export async function createApprovalCode(
  store: OAuthStore,
  options: ApprovalCodeOptions = {},
): Promise<ApprovalCode> {
  const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_CODE_TTL_MS
  if (!(ttlMs > 0 && ttlMs <= MAX_APPROVAL_CODE_TTL_MS)) {
    throw new RangeError(`ttlMs must be above 0 and at most ${MAX_APPROVAL_CODE_TTL_MS}`)
  }
  const code = APPROVAL_CODE_PREFIX + randomBase64Url(32)
  const expiresAt = (options.clock ?? systemClock).now() + ttlMs
  await store.saveApprovalCode(await sha256Hex(code), { expiresAt })
  return { code, expiresAt }
}
