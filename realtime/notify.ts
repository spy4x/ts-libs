/**
 * One aggregate-keyed notify adapter, replacing nineteen per-handler files.
 *
 * Financy carried `websocket-notify-on-*` handlers — 530 lines across 19 files, each one a copy of
 * the same `event → onModelChange(model, [entity], CREATED)` shape. The aggregate is the only thing
 * that differed, so the aggregate is the key: a host registers one {@link RecipientResolver} per
 * aggregate and the transport stays out of the domain.
 *
 * Two failure modes from the source are designed out here, not fixed afterwards:
 *
 * - **Unknown aggregate fails closed.** `getUsersForModel` ended in a `default:` clause that returned
 *   `Array.from(userBySocket.values())` — an unknown model broadcast to *every connected user*, which
 *   is a data leak the first time an aggregate is renamed or misspelled. Here an aggregate with no
 *   resolver produces zero recipients and never touches the fan-out.
 * - **A throwing resolver does not become a broadcast.** `sendToRelevantUsers` wrapped its lookup in
 *   `try { … } catch { websockets.sendToAll(message) }`, so a database error turned a scoped
 *   notification into a global one. Here a resolver that throws produces
 *   {@link NotifyStatus.Failed}, zero recipients and an `onError` callback. There is no code path in
 *   this module that can reach a broadcast: {@link UserFanout} only offers `sendToUsers`.
 */

import { createHint, type ServerMessage } from "./codec.ts"

/** A committed, group-scoped change, reduced to what a hint needs. */
export interface AggregateChange {
  groupId: string
  aggregate: string
  /** Sequence the change was committed at; 1-based. */
  sequence: number
}

/** The only fan-out capability the notify path is given: explicit recipients. */
export interface UserFanout {
  /** Deliver to the listed users' sockets. Returns the number of sockets reached. */
  sendToUsers(userIds: readonly string[], message: ServerMessage): number
}

/** Resolves the users entitled to see one change. Implementations must not fall back to everyone. */
export type RecipientResolver = (
  change: AggregateChange,
) => readonly string[] | Promise<readonly string[]>

/** What happened to one notification. */
export enum NotifyStatus {
  /** The hint reached at least one socket. */
  Sent = 1,
  /** The resolver returned nobody. Nothing was sent, and that is a normal outcome. */
  NoRecipients = 2,
  /** The aggregate has no resolver. Nothing was sent, by design. */
  UnknownAggregate = 3,
  /** The resolver threw. Nothing was sent — a failure must not widen the audience. */
  Failed = 4,
}

/** Result of one {@link AggregateNotifier.notify} call. */
export interface NotifyOutcome {
  status: NotifyStatus
  aggregate: string
  groupId: string
  sequence: number
  /** Sockets reached. Always `0` unless the status is {@link NotifyStatus.Sent}. */
  recipients: number
  /** Present when the status is {@link NotifyStatus.Failed}. */
  error?: string
}

/** Options for {@link AggregateNotifier}. */
export interface AggregateNotifierOptions {
  /** Fan-out over explicit recipients. `ConnectionRegistry` satisfies it. */
  fanout: UserFanout
  /** Resolver per aggregate. An aggregate absent from this map is unknown and fails closed. */
  resolvers?: ReadonlyMap<string, RecipientResolver>
  /** Called with an unknown aggregate, so a host can alert instead of silently not notifying. */
  onUnknownAggregate?: (change: AggregateChange) => void
  /** Called when a resolver throws. */
  onError?: (change: AggregateChange, error: Error) => void
}

/**
 * Maps a committed change to a hint, and the hint to the users entitled to see it.
 *
 * Stateless apart from the resolver map: it owns no socket, no registry index and no authorization
 * rule. Authorization belongs to the resolver, which is the host's membership lookup, and the
 * sequences belong to the commit that produced the change.
 */
export class AggregateNotifier {
  readonly #fanout: UserFanout
  readonly #resolvers: Map<string, RecipientResolver>
  readonly #onUnknownAggregate: ((change: AggregateChange) => void) | undefined
  readonly #onError:
    | ((change: AggregateChange, error: Error) => void)
    | undefined

  constructor(options: AggregateNotifierOptions) {
    this.#fanout = options.fanout
    this.#resolvers = new Map(options.resolvers ?? [])
    this.#onUnknownAggregate = options.onUnknownAggregate
    this.#onError = options.onError
  }

  /** Teach the notifier about one aggregate. Replaces an existing resolver for that aggregate. */
  register(aggregate: string, resolver: RecipientResolver): void {
    this.#resolvers.set(aggregate, resolver)
  }

  /** Aggregates that currently have a resolver, sorted. */
  aggregates(): string[] {
    return [...this.#resolvers.keys()].sort()
  }

  /** Whether an aggregate is known. A caller can check before emitting, rather than guessing. */
  knows(aggregate: string): boolean {
    return this.#resolvers.has(aggregate)
  }

  /**
   * Announce one committed change.
   *
   * Resolves recipients, deduplicates them, sends one payload-free hint, and reports what happened.
   * Never throws: a notification failure is not allowed to break the command that caused it, which
   * is also why the failure is reported back instead of swallowed.
   */
  async notify(change: AggregateChange): Promise<NotifyOutcome> {
    const resolver = this.#resolvers.get(change.aggregate)
    const base = {
      aggregate: change.aggregate,
      groupId: change.groupId,
      sequence: change.sequence,
      recipients: 0,
    }

    if (!resolver) {
      this.#onUnknownAggregate?.(change)
      return { ...base, status: NotifyStatus.UnknownAggregate }
    }

    let userIds: readonly string[]
    try {
      userIds = await resolver(change)
    } catch (error) {
      const failure = toError(error)
      this.#onError?.(change, failure)
      return { ...base, status: NotifyStatus.Failed, error: failure.message }
    }

    const recipients = [...new Set(userIds)].filter((userId) => userId.length > 0)
    if (recipients.length === 0) {
      return { ...base, status: NotifyStatus.NoRecipients }
    }

    const delivered = this.#fanout.sendToUsers(recipients, createHint(change))
    return { ...base, status: NotifyStatus.Sent, recipients: delivered }
  }
}

/** Normalize an unknown thrown value. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
