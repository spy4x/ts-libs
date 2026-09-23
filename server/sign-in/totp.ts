// Authenticator-app codes (TOTP, RFC 6238): secret generation, the enrolment QR code, and
// verification that refuses a code twice.
//
// Rewritten from `template/apps/api/services/auth/totp.ts`. What changed and why:
//
// - The issuer and account label were hard-coded to one customer's names. They are parameters now.
// - The secret was the base32 of the text of a password hash of a config value and the user's login
//   name, which is 97 bytes of hex digits and a colon rather than random bytes, and depended on two
//   config secrets for no benefit. It is now 20 random bytes, the length RFC 4226 recommends.
// - A code could be used again as often as it liked for as long as it stayed inside the window, so
//   a code seen over a shoulder or in a log could be replayed for up to a minute and a half.
//   `verifyTotp` returns the time step it accepted, and refuses any code whose step is not later than
//   the last one accepted for that user.
//
// Kept from the source: SHA-1, six digits, 30-second steps, and one step of tolerance either side.
// Every mainstream authenticator app supports exactly that configuration.
//
// Guessing is not limited here. Six digits across three accepted steps means a random guess succeeds
// about once in 333 000 tries, so the app must rate-limit this check per user (see
// `@ts-libs/platform/rate-limit`).

import * as OTPAuth from "otpauth"
import { qrcode } from "qrcode"
import { type Clock, systemClock } from "@ts-libs/platform/universal/time"

/** Digits in a code. */
export const TOTP_DIGITS = 6
/** Seconds per time step. */
export const TOTP_PERIOD_SECONDS = 30
/** Steps accepted on either side of the current one, to absorb clock drift. */
export const TOTP_WINDOW = 1

const ALGORITHM = "SHA1"
const SECRET_BYTES = 20
/** RFC 4226 section 4: the shared secret MUST be at least 128 bits. */
const MIN_SECRET_BYTES = 16
const BASE32 = /^[A-Z2-7]+=*$/
const CODE = /^[0-9]{6}$/

/** How the account appears in the authenticator app. */
export interface TotpAccount {
  /** The service name, for example the product's name. */
  issuer: string
  /** The account within the service, for example the user's email address. */
  label: string
}

/** What a user needs to add the account to an authenticator app. */
export interface TotpEnrolment {
  /** The `otpauth://totp/…` URI, for apps that accept a link. */
  uri: string
  /** The URI as an SVG QR code, for apps that scan one. */
  qrCodeSvg: string
}

/** Options for {@link verifyTotp}. */
export interface TotpVerifyOptions {
  /**
   * The step returned by the last successful verification for this secret, or `null` if there has
   * been none. A code for this step or an earlier one is refused.
   */
  lastAcceptedStep: number | null
  /** Time source. Defaults to the host clock. */
  clock?: Clock
}

/** A new random secret: 20 bytes, base32 without padding (32 characters). Store it per user. */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: SECRET_BYTES }).base32
}

/**
 * The enrolment link and QR code for a secret.
 *
 * @throws {TypeError} When the issuer or label is empty or contains `:`, which the key URI format
 *     uses to separate them, or when the secret is not valid base32 of at least 16 bytes.
 */
export function totpEnrolment(secret: string, account: TotpAccount): TotpEnrolment {
  const issuer = requireAccountPart("issuer", account.issuer)
  const label = requireAccountPart("label", account.label)
  const totp = new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: decodeSecret(secret),
  })
  const uri = totp.toString()
  return { uri, qrCodeSvg: qrcode(uri, { output: "svg" }) }
}

/**
 * Checks a code against a secret at the current time.
 *
 * Accepts the current step and one step either side. Refuses a code that is not exactly six ASCII
 * digits, and a code whose step is not later than `lastAcceptedStep`. On success the app must store
 * the returned step as the new `lastAcceptedStep` with a conditional write (only if greater than
 * the stored one), so two requests carrying the same code cannot both succeed.
 *
 * @returns The accepted time step, or `null` when the code is refused.
 * @throws {TypeError} When the secret is not valid base32 of at least 16 bytes, when
 *     `lastAcceptedStep` is neither `null` nor a non-negative safe integer, or when the clock
 *     returns a value that is not finite.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: TotpVerifyOptions,
): number | null {
  const last = options.lastAcceptedStep
  if (last !== null && !(Number.isSafeInteger(last) && last >= 0)) {
    throw new TypeError("lastAcceptedStep must be null or a non-negative integer")
  }
  const key = decodeSecret(secret)
  const timestamp = (options.clock ?? systemClock).now()
  if (!Number.isFinite(timestamp)) throw new TypeError("clock.now() must return a finite number")
  if (typeof code !== "string" || !CODE.test(code)) return null

  const delta = OTPAuth.TOTP.validate({
    token: code,
    secret: key,
    algorithm: ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp,
    window: TOTP_WINDOW,
  })
  if (delta === null) return null
  const step = OTPAuth.TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp }) + delta
  if (last !== null && step <= last) return null
  return step
}

function decodeSecret(secret: string): OTPAuth.Secret {
  if (typeof secret !== "string" || !BASE32.test(secret)) {
    throw new TypeError("secret must be upper-case base32")
  }
  let decoded: OTPAuth.Secret
  try {
    decoded = OTPAuth.Secret.fromBase32(secret)
  } catch {
    throw new TypeError("secret must be upper-case base32")
  }
  if (decoded.bytes.byteLength < MIN_SECRET_BYTES) {
    throw new TypeError(`secret must decode to at least ${MIN_SECRET_BYTES} bytes`)
  }
  return decoded
}

function requireAccountPart(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes(":")) {
    throw new TypeError(`${name} must be a non-empty string without ":"`)
  }
  return value
}
