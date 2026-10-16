/**
 * `@spy4x/billing` — one provider-neutral interface for taking payments: start a checkout, change
 * how many seats a subscription bills, open the customer portal, turn a verified webhook into a
 * {@link BillingEvent}, and the operator actions: read and refund the last payment, give time at
 * no charge, and cancel now or at the period's end. Stripe is the first adapter (`./stripe`).
 *
 * @module
 */

export { BillingEventType, RefundStatus, SubscriptionStatus } from "./provider.ts"
export type {
  BillingError,
  BillingErrorCode,
  BillingEvent,
  BillingEventRejectReason,
  BillingProvider,
  CancelAtPeriodEndRequest,
  CancelRequest,
  CheckoutRequest,
  CheckoutSession,
  LastPaymentRequest,
  PaidPayment,
  ParseEventResult,
  Payment,
  PaymentEvent,
  PlanRef,
  PortalRequest,
  PortalSession,
  QuantityRequest,
  Refund,
  RefundRequest,
  Subscription,
  SubscriptionEvent,
  TrialEndRequest,
} from "./provider.ts"
export { createStripeBilling, STRIPE_API_VERSION, STRIPE_SIGNATURE_HEADER } from "./stripe.ts"
export type { StripeBillingOptions } from "./stripe.ts"
