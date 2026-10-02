/**
 * Double opt-in mailing lists: signed confirm and unsubscribe links that keep the address out of
 * the URL, a store port with the replay rule, and the subscribe, confirm and unsubscribe flows. The
 * app keeps its wording, pages and routes. Ported from spy4x/antonshubin.com (#369).
 *
 * @module
 */

export {
  CONFIRM_TTL_MS,
  type ConfirmTokenResult,
  createSubscriptionCrypto,
  type SubscriptionCrypto,
  type SubscriptionCryptoOptions,
  type UnsubscribeLookup,
} from "./crypto.ts"
export type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"
export {
  type ConfirmOutcome,
  type ConfirmPreview,
  confirmSubscription,
  type FlowDeps,
  type FlowRequest,
  type MailOutcome,
  previewConfirmation,
  previewUnsubscribe,
  requestSubscription,
  type SubscribeRequestOutcome,
  type SubscriberLimits,
  type SubscriberLog,
  type SubscriberMail,
  unsubscribe,
  type UnsubscribeOutcome,
  type UnsubscribePreview,
} from "./flows.ts"
export {
  TOKEN_PAGE_HEADERS,
  UNSUBSCRIBE_FORM_MAX_BYTES,
  unsubscribeTokenFrom,
  type UnsubscribeTokenOptions,
} from "./http.ts"
