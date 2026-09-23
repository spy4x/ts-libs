/**
 * Input checks shared by both `AuthStore` implementations, so the memory store refuses what Postgres
 * refuses: the same lengths, NUL, and strings that are not well-formed UTF-16. One difference
 * remains: a `Date` before year 1 or after year 9999 is refused by Postgres as out of range and
 * accepted by the memory store. Internal: not an entry point of the package.
 *
 * The limits match the `CHECK` constraints in `AUTH_POSTGRES_SCHEMA`.
 */

import { type } from "arktype"
import { validate } from "@ts-libs/validation"
import { type NewAuthKey, normalizeEmail } from "./model.ts"
import type { AttemptChallengeInput, IssueChallengeInput } from "./store.ts"

/** Longest `method` and challenge `purpose`, in characters. */
export const MAX_METHOD_LENGTH = 64
/** Longest key `subject` and challenge `subject`, in characters. */
export const MAX_SUBJECT_LENGTH = 255
/** Longest stored key secret or challenge hash, in characters. */
export const MAX_SECRET_LENGTH = 1024
/** Largest id either store accepts: the top of a Postgres `integer`. */
export const MAX_ID = 2_147_483_647

const validDate = type("Date").narrow((value, ctx) =>
  !Number.isNaN(value.getTime()) || ctx.mustBe("a valid Date")
)
/**
 * A string of 1 to `max` characters that Postgres stores as given: no NUL (a `text` value cannot
 * hold it) and no lone surrogate (the driver's UTF-8 encoding turns it into U+FFFD).
 */
function storeText(max: number) {
  return type(`0 < string <= ${max}`).narrow((value, ctx) =>
    isStoreText(value) || ctx.mustBe("free of NUL characters and lone surrogates")
  )
}

const method = storeText(MAX_METHOD_LENGTH)
const subject = storeText(MAX_SUBJECT_LENGTH)
const secret = storeText(MAX_SECRET_LENGTH)

const newAuthKey = type({
  method,
  subject,
  email: type("string").or("null"),
  secret: secret.or("null"),
  provenAt: validDate.or("null"),
}).narrow((key, ctx) => {
  if (key.email !== null && normalizeEmail(key.email) !== key.email) {
    return ctx.reject({ path: ["email"], expected: "a normalised address (see normalizeEmail)" })
  }
  if (key.provenAt !== null && key.email === null) {
    return ctx.reject({ path: ["provenAt"], expected: "null for a key with no email" })
  }
  return true
})

const issueChallengeInput = type({
  purpose: method,
  subject,
  secretHash: secret,
  expiresAt: validDate,
  now: validDate,
})

const attemptChallengeInput = type({
  purpose: method,
  subject,
  secretHash: secret,
  maxAttempts: type("number.integer").narrow((value, ctx) =>
    (value >= 1 && value <= MAX_ID) || ctx.mustBe(`an integer from 1 to ${MAX_ID}`)
  ),
  now: validDate,
})

/**
 * True for a string Postgres stores and compares as given: `text` cannot hold NUL, and a lone
 * surrogate would reach the database as U+FFFD.
 */
export function isStoreText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000") && value.isWellFormed()
}

/** True for an id either store could have assigned: an integer from 1 to {@link MAX_ID}. */
export function isStoreId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ID
}

/**
 * The key, with only the five {@link NewAuthKey} fields.
 *
 * @throws {TypeError} When a field is missing or out of range, `email` is not already normalised,
 *     or `provenAt` is set on a key with no email.
 */
export function checkNewKey(value: NewAuthKey): NewAuthKey {
  const { error, data } = validate(newAuthKey, value)
  if (error) throw new TypeError(`invalid new auth key: ${error.description}`)
  return {
    method: data.method,
    subject: data.subject,
    email: data.email,
    secret: data.secret,
    provenAt: data.provenAt,
  }
}

/** @throws {TypeError} When `secret` is not a string of 1 to {@link MAX_SECRET_LENGTH} characters. */
export function checkSecret(value: string): string {
  const { error, data } = validate(secret, value)
  if (error) throw new TypeError(`invalid key secret: ${error.description}`)
  return data
}

/** @throws {TypeError} When the value is not a valid `Date`; `name` goes into the message. */
export function checkDate(value: Date, name: string): Date {
  const { error, data } = validate(validDate, value)
  if (error) throw new TypeError(`invalid ${name}: ${error.description}`)
  return data
}

/** @throws {TypeError} When a field is missing or out of range. */
export function checkIssueChallenge(value: IssueChallengeInput): IssueChallengeInput {
  const { error, data } = validate(issueChallengeInput, value)
  if (error) throw new TypeError(`invalid challenge: ${error.description}`)
  return data
}

/** @throws {TypeError} When a field is missing or out of range. */
export function checkAttemptChallenge(value: AttemptChallengeInput): AttemptChallengeInput {
  const { error, data } = validate(attemptChallengeInput, value)
  if (error) throw new TypeError(`invalid challenge guess: ${error.description}`)
  return data
}
