# @spy4x/billing

Take payments through one provider-neutral interface: start a checkout, open the customer portal,
and turn a verified webhook into a provider-neutral event. Stripe is the first adapter, over its
REST API with `fetch` and no SDK. Paddle is planned behind the same interface
([spy4x/ts-libs#363](https://github.com/spy4x/ts-libs/issues/363)).

## Install

```bash
deno add jsr:@spy4x/billing
```

Runs on: server (Deno).

## Entry points

| Export         | What it is                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------ |
| `.` (`mod.ts`) | `BillingProvider`, `BillingEvent`, `SubscriptionStatus`, `PlanRef`, and the Stripe adapter |
| `./stripe`     | `createStripeBilling`, `STRIPE_API_VERSION`, `STRIPE_SIGNATURE_HEADER`                     |

## Usage

```ts
import { BillingEventType, createStripeBilling } from "@spy4x/billing"
import { readBoundedBody } from "@spy4x/net/bounded-body"
import { formatMoney } from "@spy4x/platform/universal/money"

const billing = createStripeBilling({
  secretKey, // read from your own config; the library never reads the environment
  webhookSecret,
  plans: [{ planId: "pro", priceId: "price_…" }],
})

// Checkout: redirect the customer to `result.value.url`.
const result = await billing.createCheckout({
  planId: "pro",
  successUrl: "https://app.example.com/billing/done",
  cancelUrl: "https://app.example.com/billing",
  reference: account.id, // comes back as `subscription.reference` on every event
})

// Webhook: pass the raw bytes, never a parsed body. Stripe's events are small; cap the read.
// (`readBoundedBody` throws PayloadTooLargeError past the cap: answer it with a 413.)
const raw = await readBoundedBody(request, { maxBytes: 512 * 1024 })
const parsed = await billing.parseEvent(raw, request.headers)
if (!parsed.ok && parsed.reason !== "malformed_payload") {
  return new Response(null, { status: 400 }) // not signed by Stripe with this secret: refuse it
}
if (!parsed.ok) {
  // Signed by Stripe, but in a shape this package cannot read, most often because the webhook
  // endpoint uses another API version. Log it and answer 2xx: a 4xx makes Stripe retry for days.
  console.error(parsed.message)
  return new Response(null, { status: 200 })
}
if (parsed.event?.type === BillingEventType.PaymentSucceeded) {
  const { amount, currency, decimals } = parsed.event.payment
  formatMoney(amount, currency, "en", { decimals })
}
return new Response(null, { status: 200 })
```

## Contracts

- **One interface.** `BillingProvider` has `createCheckout`, `createPortalSession` and
  `parseEvent`. The app names plans by its own IDs; `PlanRef` maps each to the provider's price.
  A price in no `PlanRef` comes back as `planId: null`.
- **Results, not throws.** `createCheckout` and `createPortalSession` return
  `{ ok: true, value }` or `{ ok: false, error: { code, message, status } }`. `code` is
  `unknown_plan`, `invalid_request` (nothing was sent), `provider_error`, `network_error` or
  `malformed_response`. The secret key is cut out of every message. Only `createStripeBilling`
  throws, on a missing secret or a broken plan list, so a misconfiguration fails at start-up.
- **Webhooks.** `parseEvent` checks `Stripe-Signature` with `verifyWebhookRequest` from
  `@spy4x/integrations/webhooks` (constant-time, five-minute window) before it reads the body. A
  tampered, expired, replayed-after-the-window or unsigned delivery is refused with the verifier's
  reason: answer it with a 400. A body that is signed but unreadable is `malformed_payload`: Stripe
  did send it, so log it and answer with a 2xx, or Stripe retries it for days. A verified event of
  a type not listed below is `{ ok: true, event: null }`: answer it with a 2xx.
- **Duplicates.** A delivery Stripe sends twice inside the window passes twice. Record `event.id`
  and skip an ID you have seen, as Stripe's documentation advises.
- **Money.** `Payment.amount` is the integer Stripe sent, and `Payment.decimals` says how many
  decimals it carries. Format it with `formatMoney(amount, currency, locale, { decimals })`, never
  with `currency` alone: Stripe writes RSD, AFN and a few others with two decimals where `Intl`
  gives none, and ISK and UGX with two decimals always ending in `00`, so the ISO count
  would show 100 times the amount.
- **Trials.** A trial's first invoice is for zero, and Stripe marks it paid: it arrives as
  `PaymentSucceeded` with `amount: 0`. With `trialWithoutPaymentMethod`, checkout asks for no card
  (`payment_method_collection=if_required`), and a trial that ends without one is cancelled, so it
  arrives as `SubscriptionCanceled`.
- **API version.** Requests send `STRIPE_API_VERSION` (`2026-09-30.endive`). A webhook payload
  follows the webhook endpoint's version, so set the endpoint to the same version in Stripe.

| Stripe event                    | `BillingEventType`     |
| ------------------------------- | ---------------------- |
| `customer.subscription.created` | `SubscriptionCreated`  |
| `customer.subscription.updated` | `SubscriptionUpdated`  |
| `customer.subscription.deleted` | `SubscriptionCanceled` |
| `invoice.paid`                  | `PaymentSucceeded`     |
| `invoice.payment_failed`        | `PaymentFailed`        |

| Stripe status                    | `SubscriptionStatus` |
| -------------------------------- | -------------------- |
| `trialing`                       | `Trialing`           |
| `active`                         | `Active`             |
| `past_due`, `unpaid`             | `PastDue`            |
| `canceled`, `incomplete_expired` | `Canceled`           |
| `incomplete`                     | `Incomplete`         |
| `paused`                         | `Paused`             |

An unknown status is refused as `malformed_payload` rather than guessed.

## Out of scope

- **Storage.** The app owns its database and records what an event says.
- **Tax and invoices.** The provider calculates tax and its portal shows invoices.
