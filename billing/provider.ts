/**
 * The provider-neutral half of `@spy4x/billing`: what an app calls to take a payment, and what a
 * verified webhook turns into. An adapter (Stripe today, `./stripe`) implements
 * {@link BillingProvider}; the app never sees a provider's own payload.
 *
 * Money is a whole number in the currency's smallest unit, the same unit `formatMoney` from
 * `@spy4x/platform/universal/money` formats. Nothing here stores anything: the app owns its
 * database and records what an event says.
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
  /** A payment failed or is overdue; the provider is still retrying or waiting. */
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
   * Paid amount for a success, amount due for a failure: an integer in the currency's smallest
   * unit, as `formatMoney` expects.
   */
  amount: number
  /** ISO 4217 code, upper case: `"EUR"`. */
  currency: string
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
   * Makes a retried call safe: the provider returns the first call's session instead of creating
   * a second one. Use one key per intended checkout.
   */
  idempotencyKey?: string
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
  /** The plan ID is in no {@link PlanRef}. Nothing was sent. */
  | "unknown_plan"
  /** The request failed its own checks, such as a relative URL. Nothing was sent. */
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

/** One payment provider behind one interface. An adapter such as `createStripeBilling` builds it. */
export interface BillingProvider {
  /** Starts a hosted subscription checkout for one plan. */
  createCheckout(request: CheckoutRequest): Promise<Result<CheckoutSession, BillingError>>
  /** Opens the provider's customer portal for one customer. */
  createPortalSession(request: PortalRequest): Promise<Result<PortalSession, BillingError>>
  /**
   * Verifies a webhook delivery's signature and turns it into a {@link BillingEvent}. Pass the raw
   * body bytes exactly as received: the body is parsed only after the signature passes.
   */
  parseEvent(
    rawBody: Uint8Array | ArrayBuffer,
    headers: Headers | Record<string, string>,
  ): Promise<ParseEventResult>
}
