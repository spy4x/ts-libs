/**
 * `@spy4x/billing` — one provider-neutral interface for taking payments: start a checkout, open
 * the customer portal, and turn a verified webhook into a {@link BillingEvent}. Stripe is the
 * first adapter (`./stripe`).
 *
 * @module
 */

export { BillingEventType, SubscriptionStatus } from "./provider.ts"
export type {
  BillingError,
  BillingErrorCode,
  BillingEvent,
  BillingEventRejectReason,
  BillingProvider,
  CheckoutRequest,
  CheckoutSession,
  ParseEventResult,
  Payment,
  PaymentEvent,
  PlanRef,
  PortalRequest,
  PortalSession,
  Subscription,
  SubscriptionEvent,
} from "./provider.ts"
export { createStripeBilling, STRIPE_API_VERSION, STRIPE_SIGNATURE_HEADER } from "./stripe.ts"
export type { StripeBillingOptions } from "./stripe.ts"
