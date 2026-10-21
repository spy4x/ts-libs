# @spy4x/billing

Take payments through one provider-neutral interface: start a checkout, open the customer portal,
turn a verified webhook into a provider-neutral event, and act for an operator: read and refund
the last payment, give time at no charge, and cancel now or at the period's end. Stripe is the first adapter, over its
REST API with `fetch` and no SDK. Paddle is planned behind the same interface
([spy4x/ts-libs#363](https://github.com/spy4x/ts-libs/issues/363)).

## Install

```bash
deno add jsr:@spy4x/billing
```

Runs on: server (Deno).

## Entry points

| Export         | What it is                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `.` (`mod.ts`) | `BillingProvider`, `BillingEvent`, `SubscriptionStatus`, `RefundStatus`, `PlanRef`, and the Stripe adapter |
| `./stripe`     | `createStripeBilling`, `STRIPE_API_VERSION`, `STRIPE_SIGNATURE_HEADER`                                     |

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

// Operator actions. Make one idempotency key per intended action, such as when the dialog opens
// (`uuidV7()` from `@spy4x/platform/universal/uuid`), so a double click or a retry within Stripe's
// 24-hour key window acts once.
const last = await billing.readLastPayment({ subscriptionId })
if (last.ok && last.value !== null && !last.value.refunded) {
  await billing.refundPayment({ paymentId: last.value.id, idempotencyKey })
}
await billing.setTrialEnd({ subscriptionId, trialEnd: new Date("2027-01-31"), idempotencyKey })
await billing.setCancelAtPeriodEnd({ subscriptionId, cancelAtPeriodEnd: true, idempotencyKey })
await billing.cancelNow({ subscriptionId, idempotencyKey })
```

## Contracts

- **One interface.** `BillingProvider` has `createCheckout`, `updateQuantity`,
  `createPortalSession` and `parseEvent`, and the optional operator actions below, which
  `createStripeBilling` always has (its return type is `Required<BillingProvider>`). The app names plans by its own IDs; `PlanRef` maps each
  to the provider's price. A price in no `PlanRef` comes back as `planId: null`.
- **Seats.** `updateQuantity({ subscriptionId, quantity, idempotencyKey })` sets how many seats the
  plan's item bills, for per-seat pricing. The change adds a charge or a credit for the rest of
  the current period to the next invoice; nothing is charged now (Stripe's
  `proration_behavior=create_prorations`, sent explicitly). The Stripe adapter reads the
  subscription first to find the item of a configured plan, so it makes two calls. A subscription
  that bills no configured plan is `unknown_plan`, one that bills two is `invalid_request`, and
  nothing changes.
  `Subscription.quantity` reports the seats an event's subscription bills, `null` for a metered
  price.
- **Operator actions.** Each one that changes something takes a required `idempotencyKey`, sent as
  Stripe's `Idempotency-Key`, and refuses a call without one as `invalid_request` before calling
  Stripe. Stripe keeps a key for 24 hours, so only a retry within that window gets the first call's
  answer. None of them changes what the app stores: the webhook that follows does.
  - `readLastPayment({ subscriptionId })` answers the newest payment that moved money: its
    payment intent or charge ID, invoice, amount, currency, decimals, `paidAt`, `amountRefunded`
    and `refunded` (nothing left to refund). It reads the ten newest paid invoices and skips one
    paid with 0, such as a trial's, or paid outside Stripe; with none left it answers `null`.
    The refund state comes from the charge, so a refund made in Stripe's dashboard shows. Two
    calls.
  - `refundPayment({ paymentId, idempotencyKey })` refunds in full: it sends no amount, so Stripe
    refunds everything not refunded yet. There are no partial refunds. The answer is the `Refund`
    with its real amount and a `RefundStatus`; a status Stripe adds later reads as `Pending`, never
    as a failure, because the refund exists. A retry after Stripe's 24-hour key window is refused
    by Stripe as already refunded, so on a 4xx the adapter reads the payment back and answers its
    newest refund when nothing is left to refund.
  - `setTrialEnd({ subscriptionId, trialEnd, idempotencyKey })` gives time at no charge: nothing is
    charged before `trialEnd`, and `proration_behavior=none` neither credits nor charges the paid
    time left. Stripe refuses a date in the past.
  - `setCancelAtPeriodEnd({ subscriptionId, cancelAtPeriodEnd, idempotencyKey })` schedules the end
    at the period's end with `true` and takes it back with `false`.
  - `cancelNow({ subscriptionId, idempotencyKey })` ends the subscription at once with
    `invoice_now=false&prorate=false`: no refund and no final invoice. Stripe ignores an
    idempotency key on this `DELETE` and refuses to cancel twice, so when Stripe refuses with a 4xx
    the adapter reads the subscription back and answers success if it has ended.
- **Results, not throws.** `createCheckout`, `updateQuantity`, `createPortalSession` and the
  operator actions return
  `{ ok: true, value }` or `{ ok: false, error: { code, message, status } }`. `code` is
  `unknown_plan`, `invalid_request` (nothing was changed), `provider_error`, `network_error` or
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

`PastDue` does not mean the provider is still trying. Stripe stops retrying an `unpaid`
subscription and leaves it open with no end, so an app that keeps the paid plan while a
subscription is `PastDue` must end that grace period itself after a fixed number of days.

An unknown status is refused as `malformed_payload` rather than guessed.

## Out of scope

- **Storage.** The app owns its database and records what an event says.
- **Tax and invoices.** The provider calculates tax and its portal shows invoices.
