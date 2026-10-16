/**
 * The provider-neutral half of `@spy4x/billing`: what an app calls to take a payment, and what a
 * verified webhook turns into. An adapter (Stripe today, `./stripe`) implements
 * {@link BillingProvider}; the app never sees a provider's own payload.
 *
 * Money is a whole number in the provider's unit for that currency, with its decimal count beside
 * it, ready for `formatMoney` from `@spy4x/platform/universal/money`. Nothing here stores
 * anything: the app owns its database and records what an event says.
 *
 * @module
 */

import type { Result } from "@spy4x/platform/universal/result"
import type { WebhookRejectReason } from "@spy4x/integrations/webhooks"

/** Where a subscription stands, as every provider reports it. Starts at 1, like every enum here. */
export enum SubscriptionStatus {
  /** In a free trial; nothing has been charged yet. */
  Trialing = 1,
  /** Paid up. */
  Active,
  /**
   * A payment failed or is overdue. The provider may still be retrying, or may have given up and
   * left the subscription open with no end (Stripe's `unpaid`), so an app that keeps the paid plan
   * during this status must end its own grace period after a fixed time.
   */
  PastDue,
  /** Ended. No further invoices. */
  Canceled,
  /** Created, but the first payment has not gone through yet. */
  Incomplete,
  /** Paused by the provider, for example because a trial ended without a payment method. */
  Paused,
}

/** What happened, as the discriminant of {@link BillingEvent}. */
export enum BillingEventType {
  /** A subscription was created. */
  SubscriptionCreated = 1,
  /** A subscription changed: status, plan, period or cancellation schedule. */
  SubscriptionUpdated,
  /** A subscription ended. */
  SubscriptionCanceled,
  /** An invoice was paid. */
  PaymentSucceeded,
  /** A payment attempt for an invoice failed. */
  PaymentFailed,
}

/** One of the app's plans, mapped to the provider's price that bills it. */
export interface PlanRef {
  /** The app's own plan ID, the only plan name the app ever passes in or reads back. */
  planId: string
  /** The provider's price ID for that plan, such as Stripe's `price_…`. */
  priceId: string
}

/** A subscription as an event reports it. */
export interface Subscription {
  /** The provider's subscription ID. */
  id: string
  /** The provider's customer ID. */
  customerId: string
  status: SubscriptionStatus
  /** The app's plan ID, or `null` when the subscription's price is in no {@link PlanRef}. */
  planId: string | null
  /** The provider's price ID the subscription bills, or `null` when it has no item. */
  priceId: string | null
  /** End of the period already paid for, or `null` when the provider gives none. */
  currentPeriodEnd: Date | null
  /** `true` when the subscription ends at {@link currentPeriodEnd} instead of renewing. */
  cancelAtPeriodEnd: boolean
  /** End of the trial, or `null` when there is none. */
  trialEnd: Date | null
  /**
   * Seats or units the plan's item bills, or `null` when the provider gives none (a metered price).
   */
  quantity: number | null
  /** The {@link CheckoutRequest.reference} the checkout carried, or `null`. */
  reference: string | null
}

/** A payment, successful or failed, as an event reports it. */
export interface Payment {
  /** The provider's invoice ID. */
  invoiceId: string
  /** The provider's customer ID, or `null` when the invoice has none. */
  customerId: string | null
  /** The subscription the invoice bills, or `null` for a one-off invoice. */
  subscriptionId: string | null
  /**
   * Paid amount for a success, amount due for a failure: an integer exactly as the provider writes
   * it, in units of 10^-{@link decimals}. A trial's zero-amount invoice is a success with 0.
   */
  amount: number
  /** ISO 4217 code, upper case: `"EUR"`. */
  currency: string
  /**
   * How many decimals {@link amount} carries. Not always the `Intl` count: Stripe writes RSD with
   * two where `Intl` gives none. Pass it on: `formatMoney(amount, currency, locale, { decimals })`.
   */
  decimals: number
}

/** A subscription created, changed or ended. */
export interface SubscriptionEvent {
  /** The provider's event ID. Record it to skip a delivery that arrives twice. */
  id: string
  type:
    | BillingEventType.SubscriptionCreated
    | BillingEventType.SubscriptionUpdated
    | BillingEventType.SubscriptionCanceled
  /** When the provider created the event. Not an ordering: several events share a second. */
  occurredAt: Date
  subscription: Subscription
}

/** A payment that went through or failed. */
export interface PaymentEvent {
  /** The provider's event ID. Record it to skip a delivery that arrives twice. */
  id: string
  type: BillingEventType.PaymentSucceeded | BillingEventType.PaymentFailed
  /** When the provider created the event. Not an ordering: several events share a second. */
  occurredAt: Date
  payment: Payment
}

/** A verified webhook delivery, in provider-neutral terms. Narrow it on `type`. */
export type BillingEvent = SubscriptionEvent | PaymentEvent

/** Why a delivery was refused: the signature check's reasons, or a payload it cannot read. */
export type BillingEventRejectReason = WebhookRejectReason | "malformed_payload"

/**
 * Result of {@link BillingProvider.parseEvent}. `event: null` is a verified delivery of a type this
 * package does not handle: answer it with a 2xx so the provider stops sending it.
 */
export type ParseEventResult =
  | { ok: true; event: BillingEvent | null }
  | { ok: false; reason: BillingEventRejectReason; message: string }

/** What {@link BillingProvider.createCheckout} needs to start a subscription checkout. */
export interface CheckoutRequest {
  /** The app's plan ID; it must be in the adapter's {@link PlanRef} list. */
  planId: string
  /** Absolute URL the provider sends the customer to after paying. */
  successUrl: string
  /** Absolute URL the provider sends the customer to when they go back without paying. */
  cancelUrl: string
  /** An existing provider customer to bill. Leave it out and the provider creates one. */
  customerId?: string
  /** Prefills the e-mail of a new customer. Not allowed together with {@link customerId}. */
  customerEmail?: string
  /**
   * The app's own ID for whoever is subscribing, such as its account ID. It comes back on every
   * {@link Subscription} this checkout creates, as {@link Subscription.reference}.
   */
  reference?: string
  /** Seats or units, a positive integer. Default 1. */
  quantity?: number
  /** Days of free trial, a positive integer. */
  trialDays?: number
  /**
   * Starts the trial without asking for a card; needs {@link trialDays}. The provider asks for a
   * payment method only when one is due, and a trial that ends without one cancels the
   * subscription, so it arrives as `SubscriptionCanceled` instead of a failed charge. Default
   * `false`: the customer enters a card before the trial starts.
   */
  trialWithoutPaymentMethod?: boolean
  /**
   * Makes a retried call safe: the provider returns the first call's session instead of creating
   * a second one. Use one key per intended checkout.
   */
  idempotencyKey?: string
}

/** What {@link BillingProvider.updateQuantity} needs to change how many seats a plan bills. */
export interface QuantityRequest {
  /** The provider's subscription ID, from a {@link Subscription}. */
  subscriptionId: string
  /** The new number of seats or units, a positive integer. */
  quantity: number
  /**
   * Makes a retried call safe: the provider applies the first call once. Use one key per intended
   * change, such as the subscription, the quantity and the change that asked for it.
   */
  idempotencyKey?: string
}

/** What {@link BillingProvider.readLastPayment} needs. */
export interface LastPaymentRequest {
  /** The provider's subscription ID, from a {@link Subscription}. */
  subscriptionId: string
}

/**
 * The newest payment that moved money for a subscription, read from the provider when asked rather
 * than from an event, so it shows refunds made anywhere, the provider's dashboard included.
 */
export interface PaidPayment {
  /**
   * The provider's ID of the payment itself, the one {@link BillingProvider.refundPayment} takes:
   * a Stripe payment intent (`pi_…`) or, for an older payment, a charge (`ch_…`).
   */
  id: string
  /** The provider's invoice ID the payment paid. */
  invoiceId: string
  /** The paid amount, an integer in units of 10^-{@link decimals}, never 0. */
  amount: number
  /** ISO 4217 code, upper case: `"EUR"`. */
  currency: string
  /** How many decimals {@link amount} and {@link amountRefunded} carry; see {@link Payment.decimals}. */
  decimals: number
  /** When the invoice was paid. */
  paidAt: Date
  /** How much of {@link amount} has been refunded already, in the same unit. 0 when nothing. */
  amountRefunded: number
  /** `true` when the whole {@link amount} has been refunded, so nothing is left to refund. */
  refunded: boolean
}

/** What {@link BillingProvider.refundPayment} needs to refund a payment in full. */
export interface RefundRequest {
  /** {@link PaidPayment.id}: the payment to refund. */
  paymentId: string
  /**
   * Required. Makes a retried call safe: the provider refunds once and answers every retry with the
   * same refund. Make one key per intended refund, such as when the operator opens the dialog.
   */
  idempotencyKey: string
}

/** Where a refund stands. Starts at 1, like every enum here. */
export enum RefundStatus {
  /** Accepted; the money is on its way back, or the provider waits for the bank. */
  Pending = 1,
  /** The money went back to the customer. */
  Succeeded,
  /** The refund failed or was cancelled; no money went back. */
  Failed,
}

/** A refund the provider created. */
export interface Refund {
  /** The provider's refund ID. */
  id: string
  /** The refunded payment, as {@link RefundRequest.paymentId} named it. */
  paymentId: string
  /** The refunded amount, an integer in units of 10^-{@link decimals}. */
  amount: number
  /** ISO 4217 code, upper case: `"EUR"`. */
  currency: string
  /** How many decimals {@link amount} carries; see {@link Payment.decimals}. */
  decimals: number
  status: RefundStatus
}

/** What {@link BillingProvider.setTrialEnd} needs to give a subscription time at no charge. */
export interface TrialEndRequest {
  /** The provider's subscription ID, from a {@link Subscription}. */
  subscriptionId: string
  /** The new end of the trial, in the future. Nothing is charged before it. */
  trialEnd: Date
  /** Required. Makes a retried call safe; one key per intended change. */
  idempotencyKey: string
}

/** What {@link BillingProvider.cancelNow} needs. */
export interface CancelRequest {
  /** The provider's subscription ID, from a {@link Subscription}. */
  subscriptionId: string
  /** Required. Makes a retried call safe; one key per intended cancellation. */
  idempotencyKey: string
}

/** What {@link BillingProvider.setCancelAtPeriodEnd} needs. */
export interface CancelAtPeriodEndRequest {
  /** The provider's subscription ID, from a {@link Subscription}. */
  subscriptionId: string
  /**
   * `true` ends the subscription at the end of the period already paid for instead of renewing it;
   * `false` takes such a pending cancellation back, so it renews again.
   */
  cancelAtPeriodEnd: boolean
  /** Required. Makes a retried call safe; one key per intended change. */
  idempotencyKey: string
}

/** A hosted checkout page to send the customer to. */
export interface CheckoutSession {
  /** The provider's checkout session ID. */
  id: string
  /** Where to redirect the customer. */
  url: string
}

/** What {@link BillingProvider.createPortalSession} needs. */
export interface PortalRequest {
  /** The provider's customer ID, from a {@link Subscription} or {@link Payment}. */
  customerId: string
  /** Absolute URL the portal's back link returns to. */
  returnUrl: string
}

/** A customer portal page, where the customer changes plan, card or cancels and sees invoices. */
export interface PortalSession {
  /** The provider's portal session ID. */
  id: string
  /** Where to redirect the customer. */
  url: string
}

/** Why a request to the provider failed. */
export type BillingErrorCode =
  /** The plan ID is in no {@link PlanRef}, or the subscription bills none. Nothing was changed. */
  | "unknown_plan"
  /**
   * The request failed its own checks, such as a relative URL, or the subscription it names cannot
   * take it, such as one billing two configured plans. Nothing was changed.
   */
  | "invalid_request"
  /** The provider answered with an error status. */
  | "provider_error"
  /** No answer: the connection failed or timed out. */
  | "network_error"
  /** The provider answered 2xx with a body this package cannot read. */
  | "malformed_response"

/** A failed request, safe to log: it never carries the secret key. */
export interface BillingError {
  code: BillingErrorCode
  message: string
  /** The provider's HTTP status, or `null` when there was no answer. */
  status: number | null
}

/**
 * One payment provider behind one interface. An adapter such as `createStripeBilling` builds it.
 */
export interface BillingProvider {
  /** Starts a hosted subscription checkout for one plan. */
  createCheckout(request: CheckoutRequest): Promise<Result<CheckoutSession, BillingError>>
  /**
   * Sets how many seats or units a subscription's plan bills. The change adds a charge or a credit
   * for the rest of the current period to the next invoice; nothing is charged now. The answer is
   * the subscription as it stands after the change.
   */
  updateQuantity(request: QuantityRequest): Promise<Result<Subscription, BillingError>>
  /** Opens the provider's customer portal for one customer. */
  createPortalSession(request: PortalRequest): Promise<Result<PortalSession, BillingError>>
  /**
   * Reads the newest payment that moved money for a subscription, with how much of it is refunded.
   * The answer is `null` when the subscription has no such payment yet, such as during a trial.
   * Optional: an adapter written before it existed may lack it; `createStripeBilling` has it.
   */
  readLastPayment?(
    request: LastPaymentRequest,
  ): Promise<Result<PaidPayment | null, BillingError>>
  /**
   * Refunds a payment in full, to where it came from: the whole amount not refunded yet. The
   * subscription keeps running. Optional, like {@link readLastPayment}.
   */
  refundPayment?(request: RefundRequest): Promise<Result<Refund, BillingError>>
  /**
   * Moves a subscription's trial end, which gives time at no charge: nothing is charged until
   * then, the time already paid for is neither credited nor charged, and billing starts again at
   * the new end. The answer is the subscription after the change. Optional, like
   * {@link readLastPayment}.
   */
  setTrialEnd?(request: TrialEndRequest): Promise<Result<Subscription, BillingError>>
  /**
   * Ends a subscription at once. Nothing is refunded and no final invoice is made. The answer is
   * the ended subscription. Optional, like {@link readLastPayment}.
   */
  cancelNow?(request: CancelRequest): Promise<Result<Subscription, BillingError>>
  /**
   * Schedules a subscription to end at the end of its paid period, or takes that back. The answer
   * is the subscription after the change. Optional, like {@link readLastPayment}.
   */
  setCancelAtPeriodEnd?(
    request: CancelAtPeriodEndRequest,
  ): Promise<Result<Subscription, BillingError>>
  /**
   * Verifies a webhook delivery's signature and turns it into a {@link BillingEvent}. Pass the raw
   * body bytes exactly as received: the body is parsed only after the signature passes.
   */
  parseEvent(
    rawBody: Uint8Array | ArrayBuffer,
    headers: Headers | Record<string, string>,
  ): Promise<ParseEventResult>
}
