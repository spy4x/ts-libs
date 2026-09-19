/**
 * Shared provider plumbing.
 *
 * Every provider needs three collaborators and nothing else: the credential
 * store, the account store, and a way to announce that a credential was
 * attached. Bundling them here keeps each provider's constructor to its own
 * options, and keeps the "announce a connection" call in one place so the
 * account-linking handlers cannot be bypassed by a provider that forgets.
 *
 * Nothing in this file logs. The source's connect handlers logged `{ userId,
 * email }` on every successful link, which put an email address in the log for
 * each signup; failures here are reported as a kind, never a payload.
 */

import type { MethodConnectedEvent } from "../events.ts"
import type { IKeyManager, IUserManager, SessionContext } from "../types.ts"

/** Dependencies shared by every provider. */
export interface ProviderDeps {
  user: IUserManager
  key: IKeyManager
  session: SessionContext
}

/** Publishes one method-connected event. Bound by `createAuth` to the bus. */
export type EventPublisher = (event: MethodConnectedEvent) => Promise<void>
