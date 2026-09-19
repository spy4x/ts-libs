/**
 * Account linking.
 *
 * The valuable part of the source system, and the part most worth a test: an
 * account is a bag of `KeyKind`-keyed credentials, so a credential for an email
 * that already exists attaches to the *same* account instead of founding a second
 * one. Keyed by `kind` + `identification`, the four handlers below cover every
 * transition:
 *
 *  - a new method that is not the anonymous key drops the anonymous key, so a
 *    guest who signs in does not keep a guest credential;
 *  - a new method carrying an email attaches the sibling methods that email should
 *    have, so an OAuth signup with an existing magic-link key ends with two keys
 *    on one account;
 *  - an account that had no email adopts the one its new method supplied.
 *
 * Replaces `roley/cqrs/eventHandlers/*.ts`. The source's handlers took the whole
 * `Auth` object and logged `console.log("MagicLink connected", { userId, email })`
 * — an email address in a log line on every successful link. Nothing here logs a
 * payload; a failure is reported as a class name and a key kind.
 *
 * The anonymous-key deletion is the step a careless refactor drops, so it has its
 * own named test and its own mutation check.
 */

import type { AuthEventContext, AuthEventHandler, MethodConnectedEvent } from "./events.ts"
import { EventKind } from "./events.ts"
import { EMAIL_PATTERN } from "./constants.ts"
import { KeyKind } from "./types.ts"
import type { IKeyManager } from "./types.ts"

/** Which sibling method a handler attaches. `connect` creates the key and a session. */
export interface LinkableProvider {
  readonly keyKind: KeyKind
  connect(userId: number, email: string): Promise<unknown>
}

/** The anonymous method, whose key a non-anonymous link must remove. */
export interface AnonymousMethod {
  disconnect(userId: number): Promise<boolean>
}

/** Dependencies shared by the linking handlers. Providers arrive after they are built. */
export interface LinkHandlerOptions {
  key: IKeyManager
  /** Sibling providers this handler attaches. Resolved lazily, at first event. */
  getProviders: () => LinkableProvider[]
  /** The anonymous provider, or `null` to leave guest credentials in place. */
  getAnonymous: () => AnonymousMethod | null
}

/**
 * A usable email address. Exported so the rule is one function, not a repeated
 * `includes('@')`: the source wrote an OAuth subject id containing an `@` into
 * `user.email` because that is all its check required.
 */
export function isEmailLike(candidate: unknown): candidate is string {
  return typeof candidate === "string" && EMAIL_PATTERN.test(candidate)
}

/** True when the event is about the account itself rather than a method attached to one. */
function isOwnMethodConnected(event: MethodConnectedEvent): boolean {
  return event.user.id === event.key.userId
}

/**
 * Attach every sibling method this account's email should also have.
 *
 * Skips the kind that just connected (it is already there) and skips a sibling
 * that already exists, because a second key of one kind for one identification
 * would make `findKeyByKindAndIdentification` ambiguous.
 */
export class LinkSiblingMethodsOnMethodConnectedHandler
  implements AuthEventHandler<MethodConnectedEvent> {
  readonly kind = EventKind.MethodConnected

  constructor(private readonly options: LinkHandlerOptions) {}

  async handle(event: MethodConnectedEvent, context: AuthEventContext): Promise<void> {
    const email = event.email ?? event.user.email
    if (!isEmailLike(email) || !isOwnMethodConnected(event)) {
      return
    }
    for (const provider of this.options.getProviders()) {
      if (provider.keyKind === event.key.kind) {
        continue
      }
      const existing = await this.options.key.findByKindAndIdentification({
        kind: provider.keyKind,
        identification: email,
      })
      if (existing) {
        continue
      }
      // A credential of this kind under a *provider-scoped* identification (an
      // OAuth2 credential) is not found by the lookup above, so check the address
      // column too before attaching a duplicate.
      const byEmail = await this.options.key.findByEmail(email)
      if (byEmail && byEmail.kind === provider.keyKind) {
        continue
      }
      // A sibling failure must not fail the authentication that succeeded: the
      // account and the credential that just authenticated both exist, and the
      // sibling is attached on the next sign-in. The bus reports it and keeps
      // going, which is why this is not wrapped in a try/catch.
      await provider.connect(event.user.id, email)
      await context.publish({
        kind: EventKind.MethodConnected,
        user: event.user,
        // The published key carries the kind just linked, so nothing downstream
        // has to re-read the account to know which method this is.
        key: { ...event.key, kind: provider.keyKind },
        email,
      })
    }
  }
}

/**
 * Drop the guest credential once the account authenticates with anything durable.
 *
 * Ordering is the point: this handler runs after the sibling links, so removing
 * the anonymous key cannot make the account look empty to them.
 */
export class DropAnonymousOnMethodConnectedHandler
  implements AuthEventHandler<MethodConnectedEvent> {
  readonly kind = EventKind.MethodConnected

  constructor(private readonly options: LinkHandlerOptions) {}

  async handle(event: MethodConnectedEvent): Promise<void> {
    if (event.key.kind === KeyKind.Anonymous) {
      return
    }
    const anonymous = this.options.getAnonymous()
    if (!anonymous) {
      return
    }
    await anonymous.disconnect(event.user.id)
  }
}

/**
 * Give an account the email its new method supplied, when it had none.
 *
 * Only fills a blank. An account that already carries an email keeps it: the
 * address on the account is what the first verified method said, and letting a
 * later method overwrite it would let one credential change where password resets
 * for the whole account land.
 */
export class UserEmailOnMethodConnectedHandler implements AuthEventHandler<MethodConnectedEvent> {
  readonly kind = EventKind.MethodConnected

  constructor(private readonly options: Pick<LinkHandlerOptions, "key">) {}

  async handle(event: MethodConnectedEvent, context: AuthEventContext): Promise<void> {
    if (event.user.email) {
      return
    }
    const email = event.email ??
      (isEmailLike(event.key.identification) ? event.key.identification : null)
    if (!email) {
      return
    }
    const keys = await this.options.key.getAll(event.user.id)
    if (keys.length === 0) {
      // Every key is gone; there is no account left to name.
      return
    }
    await context.setUserEmail(event.user.id, email)
  }
}

/**
 * Build the account-linking handler set for one auth instance.
 *
 * Subscription order is significant and asserted by a test: siblings first, the
 * anonymous drop second, the email fill last. Removing the anonymous key before
 * linking siblings would leave a transiently empty account, and it is the step a
 * careless refactor drops, so it gets its own named test.
 */
export function createLinkHandlers(options: LinkHandlerOptions): AuthEventHandler[] {
  return [
    new LinkSiblingMethodsOnMethodConnectedHandler(options),
    new DropAnonymousOnMethodConnectedHandler(options),
    new UserEmailOnMethodConnectedHandler(options),
  ]
}
