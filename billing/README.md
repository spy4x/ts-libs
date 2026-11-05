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

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/billing`](mod.ts): One provider-neutral interface for taking payments.
- [`@spy4x/billing/stripe`](stripe.ts): Stripe adapter for `BillingProvider`, over Stripe's REST API with `fetch`.
