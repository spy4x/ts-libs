/**
 * The domain events the auth flows publish and the `AuthMethodConnectedEvent`
 * that drives account linking.
 *
 * The source used an application-wide `eventBus` singleton and passed a class as
 * the registry key; nothing here does. Events are discriminated by
 * `kind: EventKind`, so a mistyped subscription is a compile error rather than a
 * listener that silently never fires — the source's `bus.on(SomeEvent, handler)`
 * shape lost the payload type at the call site.
 */

import type { Key, User } from "./types.ts"

/** The closed set of auth events. Extend deliberately; each needs a handler test. */
export enum EventKind {
  /** A user was created by a provider. */
  UserSignedUp = 1,
  /** A key was attached to a user. Carries the email that drives sibling linking. */
  MethodConnected = 2,
}

/** A newly created account and the credential that created it. */
export interface UserSignedUpEvent {
  kind: EventKind.UserSignedUp
  user: User
  key: Key
}

/**
 * A credential was attached to an account.
 *
 * `email` is the address the account should carry, when the connecting method
 * learned one. It is what the linking handlers key off: an OAuth signup whose
 * email already has a magic-link key attaches that method to the same account
 * instead of creating a second one.
 */
export interface MethodConnectedEvent {
  kind: EventKind.MethodConnected
  user: User
  key: Key
  email: string | null
  /** True when this event created the account, so a linking handler knows to greet it. */
  isNewUser?: boolean
}

/** Any event an auth flow publishes. */
export type AuthEvent = UserSignedUpEvent | MethodConnectedEvent

/** A subscriber for one event shape. Must not throw: the bus catches and reports. */
export interface AuthEventHandler<TEvent extends AuthEvent = AuthEvent> {
  readonly kind: EventKind
  handle(event: TEvent, context: AuthEventContext): Promise<void>
}

/**
 * What a handler is given in order to do its work.
 *
 * Handlers depend on this interface rather than on the `Auth` they were built
 * from, which is what keeps the `Auth` → handlers → `Auth` cycle from existing:
 * the bus, not the constructor, closes the loop.
 */
export interface AuthEventContext {
  /** Publish a further event. Used by a linking handler to record what it linked. */
  publish(event: AuthEvent): Promise<void>
  /** Replace the e-mail carried by an account whose new method supplied one. */
  setUserEmail(userId: number, email: string): Promise<void>
}

/** Reports a handler failure. The default writes no payload of any kind. */
export type EventErrorReporter = (event: AuthEvent, error: unknown) => void

const defaultReporter: EventErrorReporter = (event, error) => {
  const name = error instanceof Error ? error.name : typeof error
  console.error(`auth_event_handler_error ${EventKind[event.kind]} ${name}`)
}

/**
 * Synchronous in-process dispatch.
 *
 * Deliberately not a queue: linking must complete inside the call that produced
 * the event, so a caller never observes a user with a half-linked account. A
 * handler failure is reported and swallowed — the account exists and the
 * credential works; failing the whole signup because a sibling link failed would
 * be worse. `dispatch` returns the failures so a caller can act on them.
 */
export class AuthEventBus {
  private readonly handlers = new Map<EventKind, AuthEventHandler[]>()
  private readonly report: EventErrorReporter

  constructor(report: EventErrorReporter = defaultReporter) {
    this.report = report
  }

  /** Subscribe a handler. Returns an unsubscribe function. */
  subscribe<TEvent extends AuthEvent>(handler: AuthEventHandler<TEvent>): () => void {
    const existing = this.handlers.get(handler.kind) ?? []
    existing.push(handler as AuthEventHandler)
    this.handlers.set(handler.kind, existing)
    return () => {
      const current = this.handlers.get(handler.kind)
      if (current) {
        const index = current.indexOf(handler as AuthEventHandler)
        if (index >= 0) {
          current.splice(index, 1)
        }
      }
    }
  }

  /**
   * Deliver `event` to every handler for its kind, in subscription order.
   *
   * Handlers run sequentially, so a handler that links a sibling has finished by
   * the time the next one inspects the keys.
   */
  async dispatch(event: AuthEvent, context: AuthEventContext): Promise<unknown[]> {
    const failures: unknown[] = []
    for (const handler of this.handlers.get(event.kind) ?? []) {
      try {
        await handler.handle(event, context)
      } catch (error) {
        failures.push(error)
        this.report(event, error)
      }
    }
    return failures
  }

  /** Handler count per event kind. For tests and for a startup assertion. */
  count(kind: EventKind): number {
    return (this.handlers.get(kind) ?? []).length
  }
}
