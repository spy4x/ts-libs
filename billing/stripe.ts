/**
 * Stripe adapter for {@link BillingProvider}, over Stripe's REST API with `fetch`. No Stripe SDK:
 * three calls (Checkout Sessions, Billing Portal Sessions, webhook events) do not justify a large
 * npm dependency.
 *
 * - **API version.** Every request sends {@link STRIPE_API_VERSION}. A webhook payload follows the
 *   version of the webhook endpoint, not of the request, so set the endpoint in Stripe's dashboard
 *   to the same version.
 * - **Webhooks.** `Stripe-Signature` is checked by `verifyWebhookRequest` from
 *   `@spy4x/integrations/webhooks`, constant-time, with a five-minute window. The body is parsed
 *   only after the signature passes. A delivery that arrives twice inside the window passes twice:
 *   record {@link BillingEvent.id} and skip one you have seen, as Stripe's documentation says.
 * - **Secrets** come in as options and are never read from the environment, logged or put in an
 *   error message.
 *
 * Events handled, one {@link BillingEventType} each: `customer.subscription.created`,
 * `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and
 * `invoice.payment_failed`. Every other verified event parses to `null`.
 *
 * @module
 */

import { type } from "arktype"
import type { Result } from "@spy4x/platform/universal/result"
import { readBoundedJson } from "@spy4x/net/bounded-body"
import { type CombinedSignatureHeader, verifyWebhookRequest } from "@spy4x/integrations/webhooks"
import {
  type BillingError,
  type BillingEvent,
  BillingEventType,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type ParseEventResult,
  type PlanRef,
  type PortalSession,
  type Subscription,
  SubscriptionStatus,
} from "./provider.ts"

/** The Stripe API version every request is pinned to. Change it here, and only here. */
export const STRIPE_API_VERSION = "2026-09-30.endive"

/** Stripe's `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>][,v0=<hex>]` header layout. */
export const STRIPE_SIGNATURE_HEADER: CombinedSignatureHeader = {
  name: "Stripe-Signature",
  pairSeparator: ",",
  timestampKey: "t",
  signatureKey: "v1",
}

/** Options for {@link createStripeBilling}. */
export interface StripeBillingOptions {
  /** Secret API key (`sk_…` or a restricted `rk_…`). Required. */
  secretKey: string
  /** The webhook endpoint's signing secret (`whsec_…`). Required. */
  webhookSecret: string
  /** The app's plans and their Stripe price IDs. At least one; no plan or price twice. */
  plans: readonly PlanRef[]
  /** Defaults to `globalThis.fetch`. Called with `redirect: "manual"` and a timeout signal. */
  fetch?: typeof fetch
  /** Per-request timeout. Default 10 000 ms. */
  requestTimeoutMs?: number
  /** Millisecond clock for the webhook window. Defaults to `Date.now`. */
  clock?: () => number
  /**
   * Accepted webhook age and future skew, in seconds. Default 300, as Stripe's libraries use. Must
   * be a finite number above 0, or `createStripeBilling` throws.
   */
  toleranceSeconds?: number
}

const API = "https://api.stripe.com/v1"
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024
/** Metadata key that carries {@link CheckoutRequest.reference} onto the subscription. */
const REFERENCE_KEY = "reference"

/**
 * Currencies Stripe writes with no decimals ("Supported currencies", "Zero-decimal currencies").
 * Every other currency is two-decimal unless {@link STRIPE_THREE_DECIMAL} names it.
 */
const STRIPE_ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/**
 * Stripe's special cases: zero-decimal currencies it still writes with two decimals, always ending
 * in `00`, so `500` is 5 ISK. Checked before {@link STRIPE_ZERO_DECIMAL}, which lists UGX too.
 */
const STRIPE_TWO_DECIMAL_SPECIAL = new Set(["ISK", "UGX"])

/** Currencies Stripe writes with three decimals. */
const STRIPE_THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"])

/**
 * How many decimals Stripe's amount in `currency` carries. Not always the `Intl` count: Stripe
 * writes RSD or AFN with two decimals where `Intl` gives none, and ISK and UGX with two where ISO
 * 4217 and `Intl` give none.
 */
const stripeDecimals = (currency: string): number => {
  if (STRIPE_TWO_DECIMAL_SPECIAL.has(currency)) return 2
  if (STRIPE_ZERO_DECIMAL.has(currency)) return 0
  if (STRIPE_THREE_DECIMAL.has(currency)) return 3
  return 2
}

const checkoutRequestSchema = type({
  planId: "string > 0",
  successUrl: "string.url",
  cancelUrl: "string.url",
  "customerId?": "string > 0",
  "customerEmail?": "string.email",
  "reference?": "0 < string <= 200",
  "quantity?": "number.integer > 0",
  "trialDays?": "number.integer > 0",
  "idempotencyKey?": "0 < string <= 255",
})

const portalRequestSchema = type({
  customerId: "string > 0",
  returnUrl: "string.url",
})

const sessionResponseSchema = type({
  id: "string > 0",
  url: type("string.url").narrow((url, ctx) =>
    url.startsWith("https://") || ctx.mustBe("an https URL")
  ),
})

const eventSchema = type({
  id: "string > 0",
  type: "string > 0",
  created: "number.integer >= 0",
  data: { object: "object" },
})

const stripeSubscriptionSchema = type({
  id: "string > 0",
  customer: "string > 0",
  status: "string",
  cancel_at_period_end: "boolean",
  trial_end: "number.integer | null",
  "metadata?": "Record<string, string> | null",
  items: {
    data: type({
      price: { id: "string > 0" },
      "current_period_end?": "number.integer | null",
    }).array(),
  },
})

const stripeInvoiceSchema = type({
  id: "string > 0",
  customer: "string | null",
  currency: "string == 3",
  amount_paid: "number.integer >= 0",
  amount_due: "number.integer >= 0",
  "parent?": type({
    type: "string",
    "subscription_details?": type({ subscription: "string > 0" }).or("null"),
  }).or("null"),
})

/** Stripe's subscription statuses, each mapped to one {@link SubscriptionStatus}. */
const STATUS = new Map<string, SubscriptionStatus>(Object.entries({
  trialing: SubscriptionStatus.Trialing,
  active: SubscriptionStatus.Active,
  past_due: SubscriptionStatus.PastDue,
  // Retries are exhausted but the subscription is kept open: the customer still owes money.
  unpaid: SubscriptionStatus.PastDue,
  canceled: SubscriptionStatus.Canceled,
  // The first payment never arrived and Stripe ended the subscription for good.
  incomplete_expired: SubscriptionStatus.Canceled,
  incomplete: SubscriptionStatus.Incomplete,
  paused: SubscriptionStatus.Paused,
}))

const SUBSCRIPTION_EVENTS = new Map<string, BillingEventType>(Object.entries({
  "customer.subscription.created": BillingEventType.SubscriptionCreated,
  "customer.subscription.updated": BillingEventType.SubscriptionUpdated,
  "customer.subscription.deleted": BillingEventType.SubscriptionCanceled,
}))

const PAYMENT_EVENTS = new Map<string, BillingEventType>(Object.entries({
  "invoice.paid": BillingEventType.PaymentSucceeded,
  "invoice.payment_failed": BillingEventType.PaymentFailed,
}))

const fromSeconds = (seconds: number | null | undefined): Date | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000)

/** Rejects the plan list a provider cannot work with, at construction rather than at checkout. */
const checkedPlans = (plans: readonly PlanRef[]): readonly PlanRef[] => {
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error("createStripeBilling: plans must list at least one plan")
  }
  const planIds = new Set<string>()
  const priceIds = new Set<string>()
  for (const plan of plans) {
    if (typeof plan?.planId !== "string" || plan.planId === "") {
      throw new Error("createStripeBilling: every plan needs a planId")
    }
    if (typeof plan.priceId !== "string" || plan.priceId === "") {
      throw new Error(`createStripeBilling: plan ${plan.planId} needs a priceId`)
    }
    if (planIds.has(plan.planId)) {
      throw new Error(`createStripeBilling: plan ${plan.planId} is listed twice`)
    }
    if (priceIds.has(plan.priceId)) {
      throw new Error(`createStripeBilling: price ${plan.priceId} is mapped to two plans`)
    }
    planIds.add(plan.planId)
    priceIds.add(plan.priceId)
  }
  return plans.map((plan) => ({ planId: plan.planId, priceId: plan.priceId }))
}

const requireSecret = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`createStripeBilling: ${name} is required`)
  }
  return value
}

/** Builds the Checkout Session form body, in a fixed order so a test can compare it exactly. */
const checkoutForm = (request: CheckoutRequest, priceId: string): URLSearchParams => {
  const form = new URLSearchParams()
  form.set("mode", "subscription")
  form.set("line_items[0][price]", priceId)
  form.set("line_items[0][quantity]", String(request.quantity ?? 1))
  form.set("success_url", request.successUrl)
  form.set("cancel_url", request.cancelUrl)
  if (request.customerId !== undefined) form.set("customer", request.customerId)
  if (request.customerEmail !== undefined) form.set("customer_email", request.customerEmail)
  if (request.reference !== undefined) {
    form.set("client_reference_id", request.reference)
    form.set(`subscription_data[metadata][${REFERENCE_KEY}]`, request.reference)
  }
  if (request.trialDays !== undefined) {
    form.set("subscription_data[trial_period_days]", String(request.trialDays))
  }
  return form
}

/**
 * A Stripe {@link BillingProvider}.
 *
 * Throws when `secretKey` or `webhookSecret` is missing or blank, or when `plans` is empty, lacks
 * an ID or maps a plan or a price twice: each is a configuration error to catch at start-up, not on
 * a customer's checkout. Every other failure is a returned result.
 */
export function createStripeBilling(options: StripeBillingOptions): BillingProvider {
  const secretKey = requireSecret(options?.secretKey, "secretKey")
  const webhookSecret = requireSecret(options.webhookSecret, "webhookSecret")
  const plans = checkedPlans(options.plans)
  const doFetch = options.fetch ?? globalThis.fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("createStripeBilling: requestTimeoutMs must be a positive number")
  }
  const toleranceSeconds = options.toleranceSeconds
  if (
    toleranceSeconds !== undefined && (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0)
  ) {
    throw new Error("createStripeBilling: toleranceSeconds must be a positive finite number")
  }

  const priceForPlan = new Map(plans.map((plan) => [plan.planId, plan.priceId]))
  const planForPrice = new Map(plans.map((plan) => [plan.priceId, plan.planId]))

  /** The error, with any copy of the secret key cut out before it can reach a log. */
  const failure = (
    code: BillingError["code"],
    message: string,
    status: number | null = null,
  ): { ok: false; error: BillingError } => ({
    ok: false,
    error: { code, message: message.replaceAll(secretKey, "<REDACTED:STRIPE_KEY>"), status },
  })

  /** POSTs a form to Stripe and returns the `{ id, url }` every session endpoint answers. */
  const postSession = async (
    path: string,
    form: URLSearchParams,
    idempotencyKey: string | undefined,
  ): Promise<Result<{ id: string; url: string }, BillingError>> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    }
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey
    let response: Response
    try {
      response = await doFetch(`${API}${path}`, {
        method: "POST",
        headers,
        body: form.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError"
      return failure(
        "network_error",
        timedOut
          ? `Stripe did not answer within ${requestTimeoutMs} ms`
          : `request to Stripe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    let body: unknown
    try {
      body = await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: 5_000 })
    } catch {
      body = undefined
      await response.body?.cancel().catch(() => undefined)
    }
    if (!response.ok) {
      const stripeMessage = (body as { error?: { message?: unknown } } | undefined)?.error?.message
      return failure(
        "provider_error",
        typeof stripeMessage === "string"
          ? `Stripe answered ${response.status}: ${stripeMessage}`
          : `Stripe answered ${response.status}`,
        response.status,
      )
    }
    const session = sessionResponseSchema(body)
    if (session instanceof type.errors) {
      return failure("malformed_response", `Stripe's answer has no session: ${session.summary}`)
    }
    return { ok: true, value: { id: session.id, url: session.url } }
  }

  /** Maps a verified Stripe subscription object, or explains why it cannot. */
  const toSubscription = (object: object): Result<Subscription, string> => {
    const stripe = stripeSubscriptionSchema(object)
    if (stripe instanceof type.errors) return { ok: false, error: stripe.summary }
    const status = STATUS.get(stripe.status)
    if (status === undefined) {
      return { ok: false, error: `unknown subscription status ${JSON.stringify(stripe.status)}` }
    }
    const items = stripe.items.data
    const item = items.find((candidate) => planForPrice.has(candidate.price.id)) ?? items[0]
    const priceId = item?.price.id ?? null
    const reference = stripe.metadata?.[REFERENCE_KEY]
    return {
      ok: true,
      value: {
        id: stripe.id,
        customerId: stripe.customer,
        status,
        planId: priceId === null ? null : planForPrice.get(priceId) ?? null,
        priceId,
        currentPeriodEnd: fromSeconds(item?.current_period_end),
        cancelAtPeriodEnd: stripe.cancel_at_period_end,
        trialEnd: fromSeconds(stripe.trial_end),
        reference: typeof reference === "string" && reference !== "" ? reference : null,
      },
    }
  }

  return {
    async createCheckout(request) {
      const checked = checkoutRequestSchema(request)
      if (checked instanceof type.errors) {
        return failure("invalid_request", `checkout request: ${checked.summary}`)
      }
      if (checked.customerId !== undefined && checked.customerEmail !== undefined) {
        return failure("invalid_request", "checkout request: pass customerId or customerEmail")
      }
      const priceId = priceForPlan.get(checked.planId)
      if (priceId === undefined) {
        return failure("unknown_plan", `plan ${JSON.stringify(checked.planId)} is not configured`)
      }
      const result = await postSession(
        "/checkout/sessions",
        checkoutForm(checked, priceId),
        checked.idempotencyKey,
      )
      return result.ok ? { ok: true, value: result.value satisfies CheckoutSession } : result
    },

    async createPortalSession(request) {
      const checked = portalRequestSchema(request)
      if (checked instanceof type.errors) {
        return failure("invalid_request", `portal request: ${checked.summary}`)
      }
      const form = new URLSearchParams()
      form.set("customer", checked.customerId)
      form.set("return_url", checked.returnUrl)
      const result = await postSession("/billing_portal/sessions", form, undefined)
      return result.ok ? { ok: true, value: result.value satisfies PortalSession } : result
    },

    async parseEvent(rawBody, headers): Promise<ParseEventResult> {
      // Nothing reads the body before this line: an unverified payload is never parsed.
      const verified = await verifyWebhookRequest(rawBody, headers, {
        secret: webhookSecret,
        combinedHeader: STRIPE_SIGNATURE_HEADER,
        clock: options.clock,
        toleranceSeconds,
      })
      if (!verified.ok) return verified

      const malformed = (message: string): ParseEventResult => ({
        ok: false,
        reason: "malformed_payload",
        message,
      })
      let json: unknown
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.body))
      } catch {
        return malformed("event body is not JSON")
      }
      const event = eventSchema(json)
      if (event instanceof type.errors) return malformed(`event: ${event.summary}`)
      const occurredAt = new Date(event.created * 1000)

      const subscriptionType = SUBSCRIPTION_EVENTS.get(event.type)
      if (subscriptionType !== undefined) {
        const subscription = toSubscription(event.data.object)
        if (!subscription.ok) return malformed(`${event.type}: ${subscription.error}`)
        const parsed: BillingEvent = {
          id: event.id,
          type: subscriptionType as
            | BillingEventType.SubscriptionCreated
            | BillingEventType.SubscriptionUpdated
            | BillingEventType.SubscriptionCanceled,
          occurredAt,
          subscription: subscription.value,
        }
        return { ok: true, event: parsed }
      }

      const paymentType = PAYMENT_EVENTS.get(event.type)
      if (paymentType !== undefined) {
        const invoice = stripeInvoiceSchema(event.data.object)
        if (invoice instanceof type.errors) return malformed(`${event.type}: ${invoice.summary}`)
        const currency = invoice.currency.toUpperCase()
        const amount = paymentType === BillingEventType.PaymentSucceeded
          ? invoice.amount_paid
          : invoice.amount_due
        const parent = invoice.parent
        const subscriptionId = parent?.type === "subscription_details"
          ? parent.subscription_details?.subscription ?? null
          : null
        const parsed: BillingEvent = {
          id: event.id,
          type: paymentType as BillingEventType.PaymentSucceeded | BillingEventType.PaymentFailed,
          occurredAt,
          payment: {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            subscriptionId,
            amount,
            currency,
            decimals: stripeDecimals(currency),
          },
        }
        return { ok: true, event: parsed }
      }

      return { ok: true, event: null }
    },
  }
}
