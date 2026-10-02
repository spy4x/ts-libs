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

// Webhook: pass the raw bytes, never a parsed body.
const raw = new Uint8Array(await request.arrayBuffer())
const parsed = await billing.parseEvent(raw, request.headers)
if (!parsed.ok) return new Response(null, { status: 400 })
if (parsed.event?.type === BillingEventType.PaymentSucceeded) {
  // parsed.event.payment.amount is an integer in the smallest unit: format it with formatMoney.
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
  reason; a body that is signed but unreadable is `malformed_payload`. A verified event of a type
  not listed below is `{ ok: true, event: null }`: answer it with a 2xx.
- **Duplicates.** A delivery Stripe sends twice inside the window passes twice. Record `event.id`
  and skip an ID you have seen, as Stripe's documentation advises.
- **Money** is an integer in the ISO 4217 smallest unit, ready for `formatMoney`. Stripe writes ISK
  and UGX with two decimals although ISO gives them none; their amounts are divided by 100.
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
