import { parseBareAddress } from "@spy4x/email/address"
import type { RateLimiter } from "@spy4x/platform/rate-limit"
import { CONFIRM_TTL_MS, type SubscriptionCrypto, unsubscribeTokenVersion } from "./crypto.ts"
import { redactAddress } from "./redact.ts"
import type { SubscriberStore } from "./store.ts"

/**
 * A mail the flows ask the app to send. The app owns every word, the layout and the sender; the
 * flows only say which mail, to whom, and with which link.
 *
 * - `confirm`: the double opt-in link, after a subscribe request.
 * - `welcome`: after the address confirmed and joined the list. `total` is the list size after
 *   adding it, absent when it could not be counted. An app that notifies its owner does it here.
 */
export type SubscriberMail =
  | { kind: "confirm"; email: string; confirmLink: string }
  | { kind: "welcome"; email: string; unsubscribeLink: string; total?: number }

/** What a mail callback may answer: nothing (it throws on failure) or a sender's result, such as
 * `@spy4x/email`'s `SendResult`. */
export type MailOutcome = void | { ok: true } | { ok: false; error: string }

/** Where the flows write. Every line is free of addresses: a relay error is redacted first. */
export interface SubscriberLog {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** Optional rate limits, any `@spy4x/platform/rate-limit` limiter. */
export interface SubscriberLimits {
  /** Keyed on {@link FlowRequest.clientKey}. Counts every subscribe request, and every unsubscribe
   * request whose version 1 token makes the flow scan the list. */
  client?: RateLimiter
  /** Keyed on the address's `subscriberKey`, so requests from many clients cannot flood one inbox
   * with confirm mails. Over the limit, the request still answers 200 and no mail goes out. */
  recipient?: RateLimiter
}

/** Everything the flows need. Built once per app; nothing in it is per request. */
export interface FlowDeps {
  crypto: SubscriptionCrypto
  store: SubscriberStore
  /** Builds the app's absolute URLs around a token. */
  links: {
    confirm(token: string): string
    unsubscribe(token: string): string
  }
  /** Sends one mail. A throw or `{ ok: false }` is logged with the address redacted; it never
   * changes a flow's answer, because the answer is given before the mail goes out. */
  sendMail(mail: SubscriberMail): Promise<MailOutcome>
  /** Defaults to `console`. */
  log?: SubscriberLog
  limits?: SubscriberLimits
  /** Clock in Unix milliseconds, for `subscribedAt` and unsubscribe records. Defaults to
   * `Date.now`. */
  now?: () => number
}

/** What the app knows about the request. */
export interface FlowRequest {
  /** The client's rate-limit key: the IP the app derived behind its own proxies, or its bucket. */
  clientKey?: string
}

/**
 * The answer to a subscribe request. `mails` settles when the confirm mail was handed over or
 * failed; it never rejects. A route answers at once; a test awaits it.
 *
 * 200 is the same for a new address, a listed one and one over the recipient limit, so the answer
 * reveals nothing about the list. 400: not a bare address. 429: over the client limit. 500: the
 * link could not be built or a limiter failed.
 */
export interface SubscribeRequestOutcome {
  status: 200 | 400 | 429 | 500
  /** Set with 429: how long until the client may try again. */
  retryAfterMs?: number
  mails: Promise<void>
}

/** What a confirm link leads to, before anything is stored. */
export type ConfirmPreview =
  | { state: "confirm"; email: string }
  | { state: "expired" | "invalid" }

/** What confirming led to. A link issued before the address last unsubscribed is `"invalid"`. */
export type ConfirmOutcome =
  | { state: "confirmed"; email: string; mails: Promise<void> }
  | { state: "expired" | "invalid" | "error" }

/** What an unsubscribe link leads to, before anything is removed. */
export type UnsubscribePreview =
  | { state: "confirm"; email: string }
  | { state: "not-recognised" | "error" }
  | { state: "limited"; retryAfterMs: number }

/** What unsubscribing led to. */
export type UnsubscribeOutcome =
  | { state: "done" | "not-recognised" | "error" }
  | { state: "limited"; retryAfterMs: number }

const TAG = "[subscribers]"
const settled = Promise.resolve()

/**
 * Mails a confirm link to the address in `field` (a form's raw email field). Nothing is read from
 * or written to the store, so a listed address and a new one cost the same and get the same
 * answer. Only a bare address passes (`parseBareAddress`), lowercased.
 */
export async function requestSubscription(
  field: unknown,
  deps: FlowDeps,
  request: FlowRequest = {},
): Promise<SubscribeRequestOutcome> {
  const log = deps.log ?? console
  try {
    const client = await checkLimit(deps.limits?.client, request.clientKey)
    if (client !== 0) return { status: 429, retryAfterMs: client, mails: settled }
  } catch (error) {
    log.error(`${TAG} client rate limit failed:`, describe(error))
    return { status: 500, mails: settled }
  }

  const email = parseBareAddress(field)
  if (email === null) return { status: 400, mails: settled }

  let confirmLink: string
  try {
    const key = await deps.crypto.subscriberKey(email)
    if (await checkLimit(deps.limits?.recipient, key) !== 0) {
      log.warn(`${TAG} recipient limit reached, confirm mail not sent: key ${key.slice(0, 8)}`)
      return { status: 200, mails: settled }
    }
    confirmLink = deps.links.confirm(await deps.crypto.confirmToken(email))
  } catch (error) {
    log.error(`${TAG} cannot build the confirm link:`, describe(error, email))
    return { status: 500, mails: settled }
  }
  const mails = send(deps, { kind: "confirm", email, confirmLink }, log)
  return { status: 200, mails }
}

/** Checks a confirm token without storing anything: the page a link opens shows this and asks for
 * a click, so a mail scanner that follows links subscribes no one. */
export async function previewConfirmation(token: string, deps: FlowDeps): Promise<ConfirmPreview> {
  const checked = await deps.crypto.verifyConfirmToken(token)
  return checked.ok ? { state: "confirm", email: checked.email } : { state: checked.reason }
}

/**
 * Adds the address a confirm token carries, then asks for the welcome mail. Confirming again (a
 * reload, a double click) changes nothing and sends nothing. The unsubscribe link is built before
 * anything is stored, so no address is stored without one that works.
 */
export async function confirmSubscription(token: string, deps: FlowDeps): Promise<ConfirmOutcome> {
  const log = deps.log ?? console
  const checked = await deps.crypto.verifyConfirmToken(token)
  if (!checked.ok) return { state: checked.reason }
  const { email, issuedAt } = checked

  let unsubscribeLink: string
  let result: Awaited<ReturnType<SubscriberStore["add"]>>
  try {
    unsubscribeLink = deps.links.unsubscribe(await deps.crypto.unsubscribeToken(email))
    result = await deps.store.add({
      email,
      key: await deps.crypto.subscriberKey(email),
      mark: await deps.crypto.unsubscribeMark(email),
      issuedAt,
      at: new Date((deps.now ?? Date.now)()),
    })
  } catch (error) {
    log.error(`${TAG} cannot save the subscriber:`, describe(error, email))
    return { state: "error" }
  }
  if (result === "replay") return { state: "invalid" }
  if (result === "known") return { state: "confirmed", email, mails: settled }

  let total: number | undefined
  try {
    total = await deps.store.count()
  } catch (error) {
    log.error(`${TAG} cannot count the subscribers:`, describe(error, email))
  }
  const mails = send(deps, {
    kind: "welcome",
    email,
    unsubscribeLink,
    ...(total === undefined ? {} : { total }),
  }, log)
  return { state: "confirmed", email, mails }
}

/** Finds whom an unsubscribe token names without removing anything: the page a link opens shows
 * this and asks for a click. A one-click POST (RFC 8058) goes straight to {@link unsubscribe}. */
export async function previewUnsubscribe(
  token: string,
  deps: FlowDeps,
  request: FlowRequest = {},
): Promise<UnsubscribePreview> {
  const log = deps.log ?? console
  try {
    const limited = await limitScan(token, deps, request)
    if (limited !== 0) return { state: "limited", retryAfterMs: limited }
    const subscriber = await deps.crypto.verifyUnsubscribeToken(token, deps.store)
    return subscriber ? { state: "confirm", email: subscriber.email } : { state: "not-recognised" }
  } catch (error) {
    log.error(`${TAG} cannot check the unsubscribe link:`, describe(error))
    return { state: "error" }
  }
}

/**
 * Removes the address an unsubscribe token names and records the unsubscribe, so a confirm link
 * issued earlier cannot bring it back. A token whose address is already gone is `"not-recognised"`,
 * the same answer as a forged one.
 */
export async function unsubscribe(
  token: string,
  deps: FlowDeps,
  request: FlowRequest = {},
): Promise<UnsubscribeOutcome> {
  const log = deps.log ?? console
  let email: string | undefined
  try {
    const limited = await limitScan(token, deps, request)
    if (limited !== 0) return { state: "limited", retryAfterMs: limited }
    const subscriber = await deps.crypto.verifyUnsubscribeToken(token, deps.store)
    if (subscriber === undefined) return { state: "not-recognised" }
    email = subscriber.email
    const at = (deps.now ?? Date.now)()
    await deps.store.remove({
      email,
      mark: await deps.crypto.unsubscribeMark(email),
      at: new Date(at),
      pruneBefore: new Date(at - CONFIRM_TTL_MS),
    })
    return { state: "done" }
  } catch (error) {
    log.error(`${TAG} cannot unsubscribe:`, describe(error, email))
    return { state: "error" }
  }
}

/** 0 when `key` may go on (or there is no limiter or key), else the wait in milliseconds. */
async function checkLimit(limiter: RateLimiter | undefined, key: string | undefined) {
  if (limiter === undefined || key === undefined) return 0
  const decision = await limiter.check(key)
  return decision.allowed ? 0 : Math.max(1, decision.retryAfterMs)
}

/** The client limit, applied only to a version 1 unsubscribe token: the one that scans the list. */
function limitScan(token: string, deps: FlowDeps, request: FlowRequest): Promise<number> {
  if (unsubscribeTokenVersion(token) !== 1) return Promise.resolve(0)
  return checkLimit(deps.limits?.client, request.clientKey)
}

/** Hands one mail to the app and logs a failure with the address redacted. Never rejects. */
async function send(deps: FlowDeps, mail: SubscriberMail, log: SubscriberLog): Promise<void> {
  try {
    const outcome = await deps.sendMail(mail)
    if (outcome && outcome.ok === false) {
      log.error(`${TAG} ${mail.kind} mail failed:`, redactAddress(outcome.error, mail.email))
    }
  } catch (error) {
    log.error(`${TAG} ${mail.kind} mail failed:`, describe(error, mail.email))
  }
}

/** An error as one line of text, with `email` redacted. Never the error object: its stack and
 * fields are not redacted. */
function describe(error: unknown, email?: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return email === undefined ? text : redactAddress(text, email)
}
