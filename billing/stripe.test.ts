import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { BillingEventType, type ParseEventResult, SubscriptionStatus } from "./provider.ts"
import { createStripeBilling, STRIPE_API_VERSION, type StripeBillingOptions } from "./stripe.ts"

const SECRET_KEY = "sk_test_not_a_real_key_0000"
const WEBHOOK_SECRET = "whsec_not_a_real_secret_0000"
const PLANS = [
  { planId: "pro", priceId: "price_1MowQULkdIwHu7ixraBm864M" },
  { planId: "team", priceId: "price_team_0000" },
]
/** A second inside every fixture's five-minute window. */
const NOW_SECONDS = 1_800_000_000

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A `fetch` that records each call and answers with `respond`. Never touches the network. */
const fakeFetch = (respond: () => Response | Promise<Response>) => {
  const calls: RecordedCall[] = []
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(respond())
  }) as typeof fetch
  return { calls, fetcher }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const billing = (overrides: Partial<StripeBillingOptions> = {}) =>
  createStripeBilling({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    plans: PLANS,
    clock: () => NOW_SECONDS * 1000,
    ...overrides,
  })

const hmacHex = async (secret: string, message: Uint8Array<ArrayBuffer>) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message))
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** What Stripe sends: `Stripe-Signature: t=<seconds>,v1=<hmac of "<seconds>.<body>">`. */
const stripeSignature = async (
  body: Uint8Array,
  seconds = NOW_SECONDS,
  secret = WEBHOOK_SECRET,
) => {
  const prefix = new TextEncoder().encode(`${seconds}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix, 0)
  signed.set(body, prefix.length)
  return `t=${seconds},v1=${await hmacHex(secret, signed)}`
}

const fixture = (name: string) =>
  Deno.readFile(new URL(`./fixtures/stripe/${name}.json`, import.meta.url))

const signedFixture = async (name: string) => {
  const body = await fixture(name)
  return { body, headers: { "Stripe-Signature": await stripeSignature(body) } }
}

/** Edits a fixture's `data.object` and returns the re-encoded body. */
const editedFixture = async (name: string, edit: (object: Record<string, unknown>) => void) => {
  const event = JSON.parse(new TextDecoder().decode(await fixture(name)))
  edit(event.data.object)
  return new TextEncoder().encode(JSON.stringify(event))
}

const parsedEvent = (result: ParseEventResult) => {
  if (!result.ok) throw new Error(`expected an event, got ${result.reason}: ${result.message}`)
  return result.event
}

describe("createStripeBilling", () => {
  it("refuses to start without a secret key, a webhook secret or a usable plan list", () => {
    const base = { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, plans: PLANS }
    expect(() => createStripeBilling({ ...base, secretKey: " " })).toThrow("secretKey is required")
    expect(() => createStripeBilling({ ...base, webhookSecret: undefined as unknown as string }))
      .toThrow("webhookSecret is required")
    expect(() => createStripeBilling({ ...base, plans: [] })).toThrow("at least one plan")
    expect(() =>
      createStripeBilling({ ...base, plans: [PLANS[0], { ...PLANS[1], planId: "pro" }] })
    )
      .toThrow("plan pro is listed twice")
    expect(() =>
      createStripeBilling({
        ...base,
        plans: [PLANS[0], { ...PLANS[1], priceId: PLANS[0].priceId }],
      })
    ).toThrow("mapped to two plans")
  })
})

describe("createCheckout", () => {
  it("posts the exact form body, version and key to Stripe's Checkout Sessions endpoint", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" })
    )
    const result = await billing({ fetch: fetcher }).createCheckout({
      planId: "pro",
      successUrl: "https://app.example.com/billing/done",
      cancelUrl: "https://app.example.com/billing",
    })
    expect(result).toEqual({
      ok: true,
      value: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
    })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions")
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.redirect).toBe("manual")
    expect(calls[0].init.headers).toEqual({
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    })
    expect(calls[0].init.body).toBe(
      "mode=subscription" +
        "&line_items%5B0%5D%5Bprice%5D=price_1MowQULkdIwHu7ixraBm864M" +
        "&line_items%5B0%5D%5Bquantity%5D=1" +
        "&success_url=https%3A%2F%2Fapp.example.com%2Fbilling%2Fdone" +
        "&cancel_url=https%3A%2F%2Fapp.example.com%2Fbilling",
    )
  })

  it("sends the customer, reference, quantity, trial and idempotency key when given", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({ id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/cs_test_2" })
    )
    await billing({ fetch: fetcher }).createCheckout({
      planId: "team",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
      customerId: "cus_Na6dX7aXxi11N4",
      reference: "acct_42",
      quantity: 3,
      trialDays: 14,
      idempotencyKey: "checkout-acct_42-1",
    })
    expect(new URLSearchParams(String(calls[0].init.body)).toString()).toBe(
      new URLSearchParams([
        ["mode", "subscription"],
        ["line_items[0][price]", "price_team_0000"],
        ["line_items[0][quantity]", "3"],
        ["success_url", "https://app.example.com/ok"],
        ["cancel_url", "https://app.example.com/no"],
        ["customer", "cus_Na6dX7aXxi11N4"],
        ["client_reference_id", "acct_42"],
        ["subscription_data[metadata][reference]", "acct_42"],
        ["subscription_data[trial_period_days]", "14"],
      ]).toString(),
    )
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"])
      .toBe("checkout-acct_42-1")
  })

  it("sends a new customer's e-mail as customer_email", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({ id: "cs_test_3", url: "https://checkout.stripe.com/c/pay/cs_test_3" })
    )
    await billing({ fetch: fetcher }).createCheckout({
      planId: "pro",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
      customerEmail: "jenny@example.com",
    })
    expect(new URLSearchParams(String(calls[0].init.body)).get("customer_email"))
      .toBe("jenny@example.com")
  })

  it("refuses an unknown plan without calling Stripe", async () => {
    const { calls, fetcher } = fakeFetch(() => json({}))
    const result = await billing({ fetch: fetcher }).createCheckout({
      planId: "enterprise",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    })
    expect(result.ok === false && result.error.code).toBe("unknown_plan")
    expect(calls.length).toBe(0)
  })

  it("refuses a relative URL, a zero quantity, or a customer ID with an e-mail, without calling Stripe", async () => {
    const { calls, fetcher } = fakeFetch(() => json({}))
    const provider = billing({ fetch: fetcher })
    const urls = {
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    }
    const requests = [
      { planId: "pro", ...urls, successUrl: "/billing/done" },
      { planId: "pro", ...urls, quantity: 0 },
      { planId: "pro", ...urls, trialDays: 1.5 },
      { planId: "pro", ...urls, customerId: "cus_1", customerEmail: "jenny@example.com" },
    ]
    for (const request of requests) {
      const result = await provider.createCheckout(request)
      expect({ request, code: result.ok === false && result.error.code })
        .toEqual({ request, code: "invalid_request" })
    }
    expect(calls.length).toBe(0)
  })

  it("reports Stripe's error message and status, with the secret key cut out", async () => {
    const { fetcher } = fakeFetch(() =>
      json({
        error: {
          type: "invalid_request_error",
          message: `Invalid API Key provided: ${SECRET_KEY}`,
        },
      }, 401)
    )
    const result = await billing({ fetch: fetcher }).createCheckout({
      planId: "pro",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    })
    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_error",
        message: "Stripe answered 401: Invalid API Key provided: <REDACTED:STRIPE_KEY>",
        status: 401,
      },
    })
  })

  it("reports a failed connection and a timeout as network errors", async () => {
    const request = {
      planId: "pro",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    }
    const refused = await billing({
      fetch: (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch,
    }).createCheckout(request)
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "network_error",
        message: "request to Stripe failed: connection refused",
        status: null,
      },
    })
    const timedOut = await billing({
      requestTimeoutMs: 1234,
      fetch: (() => Promise.reject(new DOMException("timed out", "TimeoutError"))) as typeof fetch,
    }).createCheckout(request)
    expect(timedOut.ok === false && timedOut.error.message)
      .toBe("Stripe did not answer within 1234 ms")
  })

  it("reports a 2xx answer without a session URL as malformed", async () => {
    const { fetcher } = fakeFetch(() => json({ id: "cs_test_4", url: null }))
    const result = await billing({ fetch: fetcher }).createCheckout({
      planId: "pro",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    })
    expect(result.ok === false && result.error.code).toBe("malformed_response")
  })
})

describe("createPortalSession", () => {
  it("posts the customer and return URL to Stripe's Billing Portal Sessions endpoint", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      json({ id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" })
    )
    const result = await billing({ fetch: fetcher }).createPortalSession({
      customerId: "cus_Na6dX7aXxi11N4",
      returnUrl: "https://app.example.com/account",
    })
    expect(result).toEqual({
      ok: true,
      value: { id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" },
    })
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions")
    expect(calls[0].init.body).toBe(
      "customer=cus_Na6dX7aXxi11N4&return_url=https%3A%2F%2Fapp.example.com%2Faccount",
    )
    expect((calls[0].init.headers as Record<string, string>)["Stripe-Version"])
      .toBe(STRIPE_API_VERSION)
  })

  it("refuses a missing customer without calling Stripe", async () => {
    const { calls, fetcher } = fakeFetch(() => json({}))
    const result = await billing({ fetch: fetcher }).createPortalSession({
      customerId: "",
      returnUrl: "https://app.example.com/account",
    })
    expect(result.ok === false && result.error.code).toBe("invalid_request")
    expect(calls.length).toBe(0)
  })
})

describe("parseEvent: Stripe's recorded payloads", () => {
  const subscription = {
    id: "sub_1MowQVLkdIwHu7ixeRlqHVzs",
    customerId: "cus_Na6dX7aXxi11N4",
    planId: "pro",
    priceId: "price_1MowQULkdIwHu7ixraBm864M",
    currentPeriodEnd: new Date(1682288167 * 1000),
    trialEnd: null,
    reference: "acct_42",
  }

  it("maps customer.subscription.created to SubscriptionCreated", async () => {
    const { body, headers } = await signedFixture("customer.subscription.created")
    expect(parsedEvent(await billing().parseEvent(body, headers))).toEqual({
      id: "evt_1MowQXLkdIwHu7ixsub0001",
      type: BillingEventType.SubscriptionCreated,
      occurredAt: new Date(1679609768 * 1000),
      subscription: {
        ...subscription,
        status: SubscriptionStatus.Active,
        cancelAtPeriodEnd: false,
      },
    })
  })

  it("maps customer.subscription.updated to SubscriptionUpdated", async () => {
    const { body, headers } = await signedFixture("customer.subscription.updated")
    expect(parsedEvent(await billing().parseEvent(body, headers))).toEqual({
      id: "evt_1MowQXLkdIwHu7ixsub0002",
      type: BillingEventType.SubscriptionUpdated,
      occurredAt: new Date(1682288200 * 1000),
      subscription: {
        ...subscription,
        status: SubscriptionStatus.PastDue,
        cancelAtPeriodEnd: true,
      },
    })
  })

  it("maps customer.subscription.deleted to SubscriptionCanceled", async () => {
    const { body, headers } = await signedFixture("customer.subscription.deleted")
    expect(parsedEvent(await billing().parseEvent(body, headers))).toEqual({
      id: "evt_1MowQXLkdIwHu7ixsub0003",
      type: BillingEventType.SubscriptionCanceled,
      occurredAt: new Date(1682288300 * 1000),
      subscription: {
        ...subscription,
        status: SubscriptionStatus.Canceled,
        cancelAtPeriodEnd: false,
      },
    })
  })

  it("maps invoice.paid to PaymentSucceeded with the paid amount", async () => {
    const { body, headers } = await signedFixture("invoice.paid")
    expect(parsedEvent(await billing().parseEvent(body, headers))).toEqual({
      id: "evt_1MtHbFLkdIwHu7ixinv00001",
      type: BillingEventType.PaymentSucceeded,
      occurredAt: new Date(1680644470 * 1000),
      payment: {
        invoiceId: "in_1MtHbELkdIwHu7ixl4OzzPMv",
        customerId: "cus_Na6dX7aXxi11N4",
        subscriptionId: "sub_1MowQVLkdIwHu7ixeRlqHVzs",
        amount: 1000,
        currency: "USD",
      },
    })
  })

  it("maps invoice.payment_failed to PaymentFailed with the amount still due", async () => {
    const { body, headers } = await signedFixture("invoice.payment_failed")
    expect(parsedEvent(await billing().parseEvent(body, headers))).toEqual({
      id: "evt_1MtHbFLkdIwHu7ixinv00002",
      type: BillingEventType.PaymentFailed,
      occurredAt: new Date(1680644470 * 1000),
      payment: {
        invoiceId: "in_1MtHbELkdIwHu7ixl4OzzPMv",
        customerId: "cus_Na6dX7aXxi11N4",
        subscriptionId: "sub_1MowQVLkdIwHu7ixeRlqHVzs",
        amount: 1000,
        currency: "USD",
      },
    })
  })

  it("returns no event for a verified type it does not handle", async () => {
    const { body, headers } = await signedFixture("setup_intent.created")
    expect(await billing().parseEvent(body, headers)).toEqual({ ok: true, event: null })
  })
})

describe("parseEvent: mapping edge cases", () => {
  const parseEdited = async (name: string, edit: (object: Record<string, unknown>) => void) => {
    const body = await editedFixture(name, edit)
    return await billing().parseEvent(body, { "Stripe-Signature": await stripeSignature(body) })
  }

  it("maps every Stripe subscription status to one status", async () => {
    const expected: Record<string, SubscriptionStatus> = {
      trialing: SubscriptionStatus.Trialing,
      active: SubscriptionStatus.Active,
      past_due: SubscriptionStatus.PastDue,
      unpaid: SubscriptionStatus.PastDue,
      canceled: SubscriptionStatus.Canceled,
      incomplete_expired: SubscriptionStatus.Canceled,
      incomplete: SubscriptionStatus.Incomplete,
      paused: SubscriptionStatus.Paused,
    }
    for (const [stripeStatus, status] of Object.entries(expected)) {
      const event = parsedEvent(
        await parseEdited("customer.subscription.updated", (object) => {
          object.status = stripeStatus
        }),
      )
      expect({
        stripeStatus,
        status: event && "subscription" in event && event.subscription.status,
      })
        .toEqual({ stripeStatus, status })
    }
  })

  it("refuses a subscription status it does not know rather than guessing", async () => {
    const result = await parseEdited("customer.subscription.updated", (object) => {
      object.status = "frozen"
    })
    expect(result).toEqual({
      ok: false,
      reason: "malformed_payload",
      message: `customer.subscription.updated: unknown subscription status "frozen"`,
    })
  })

  it("reports a price in no plan as planId null, keeping the price ID", async () => {
    const event = parsedEvent(
      await parseEdited("customer.subscription.created", (object) => {
        const items = object.items as { data: { price: { id: string } }[] }
        items.data[0].price.id = "price_unmapped"
      }),
    )
    expect(event && "subscription" in event && event.subscription).toMatchObject({
      planId: null,
      priceId: "price_unmapped",
    })
  })

  it("reports a subscription without a reference as reference null", async () => {
    const event = parsedEvent(
      await parseEdited("customer.subscription.created", (object) => {
        object.metadata = {}
      }),
    )
    expect(event && "subscription" in event && event.subscription.reference).toBe(null)
  })

  it("converts ISK, which Stripe writes with two decimals, to whole krónur", async () => {
    const event = parsedEvent(
      await parseEdited("invoice.paid", (object) => {
        object.currency = "isk"
        object.amount_paid = 50000
      }),
    )
    expect(event && "payment" in event && event.payment).toMatchObject({
      amount: 500,
      currency: "ISK",
    })
  })

  it("keeps a two-decimal currency's amount as Stripe sends it", async () => {
    const event = parsedEvent(
      await parseEdited("invoice.paid", (object) => {
        object.currency = "eur"
        object.amount_paid = 1999
      }),
    )
    expect(event && "payment" in event && event.payment).toMatchObject({
      amount: 1999,
      currency: "EUR",
    })
  })

  it("reports a one-off invoice with no subscription parent as subscriptionId null", async () => {
    const event = parsedEvent(
      await parseEdited("invoice.paid", (object) => {
        object.parent = null
      }),
    )
    expect(event && "payment" in event && event.payment.subscriptionId).toBe(null)
  })

  it("refuses an event whose object lacks a field it maps", async () => {
    const result = await parseEdited("invoice.paid", (object) => {
      delete object.amount_paid
    })
    expect(result.ok === false && result.reason).toBe("malformed_payload")
  })
})

describe("parseEvent: signature", () => {
  it("rejects a tampered body", async () => {
    const { body, headers } = await signedFixture("invoice.paid")
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(body).replace(`"amount_paid": 1000`, `"amount_paid": 1`),
    )
    expect(tampered.length).not.toBe(body.length)
    const result = await billing().parseEvent(tampered, headers)
    expect(result.ok === false && result.reason).toBe("signature_mismatch")
  })

  it("rejects an expired delivery, older than five minutes", async () => {
    const body = await fixture("invoice.paid")
    const headers = { "Stripe-Signature": await stripeSignature(body, NOW_SECONDS - 301) }
    const result = await billing().parseEvent(body, headers)
    expect(result.ok === false && result.reason).toBe("stale_timestamp")
  })

  it("rejects a replayed delivery once the window has passed", async () => {
    const { body, headers } = await signedFixture("invoice.paid")
    const later = billing({ clock: () => (NOW_SECONDS + 3600) * 1000 })
    const result = await later.parseEvent(body, headers)
    expect(result.ok === false && result.reason).toBe("stale_timestamp")
  })

  it("rejects a delivery signed with another endpoint's secret, or with no signature", async () => {
    const body = await fixture("invoice.paid")
    const other = { "Stripe-Signature": await stripeSignature(body, NOW_SECONDS, "whsec_other") }
    const wrong = await billing().parseEvent(body, other)
    expect(wrong.ok === false && wrong.reason).toBe("signature_mismatch")
    const missing = await billing().parseEvent(body, {})
    expect(missing.ok === false && missing.reason).toBe("missing_signature")
  })

  it("checks the signature before reading the body", async () => {
    // Not JSON at all: with a bad signature the answer is the signature's, so
    // the body was never parsed; with a good one it is the payload's.
    const garbage = new TextEncoder().encode("not json")
    const unsigned = await billing().parseEvent(garbage, {
      "Stripe-Signature": `t=${NOW_SECONDS},v1=${"0".repeat(64)}`,
    })
    expect(unsigned.ok === false && unsigned.reason).toBe("signature_mismatch")
    const signed = await billing().parseEvent(garbage, {
      "Stripe-Signature": await stripeSignature(garbage),
    })
    expect(signed).toEqual({
      ok: false,
      reason: "malformed_payload",
      message: "event body is not JSON",
    })
  })
})
