/**
 * One address on a mailing list.
 *
 * `key` is the address's `SubscriptionCrypto.subscriberKey`: a version 2 unsubscribe link
 * finds the row by it. A row written before keys existed has none, and only a version 1 link,
 * which scans the list, can find it.
 */
export interface Subscriber {
  /** Trimmed and lowercased, as `parseBareAddress` returns it. */
  email: string
  key?: string
  subscribedAt: Date
}

/** What {@link SubscriberStore.add} did: stored the address, found it already there, or refused a
 * confirm link issued before the address last unsubscribed. */
export type AddSubscriberResult = "added" | "known" | "replay"

/** The input of {@link SubscriberStore.add}. */
export interface AddSubscriberInput {
  email: string
  key: string
  /** The address's `SubscriptionCrypto.unsubscribeMark`, matched against recorded
   * unsubscribes. */
  mark: string
  /** When the confirm link was issued, in Unix milliseconds. */
  issuedAt: number
  /** Stored as {@link Subscriber.subscribedAt}. */
  at: Date
}

/** The input of {@link SubscriberStore.remove}. */
export interface RemoveSubscriberInput {
  email: string
  /** The address's `SubscriptionCrypto.unsubscribeMark`, recorded with `at`. */
  mark: string
  at: Date
  /** Recorded unsubscribes older than this are dropped: no confirm link issued before it still
   * verifies, so none can be replayed. */
  pruneBefore: Date
}

/**
 * Where a mailing list lives. Each method is one intent, so an adapter can do it atomically: a
 * Postgres store in one statement or transaction, a file store under its lock.
 *
 * The replay rule lives in every adapter: `add` answers `"replay"`, and stores nothing, when the
 * address has a recorded unsubscribe at or after `issuedAt`. `remove` records that unsubscribe by
 * its mark, never by address, in the same atomic step that removes the row, and records it even
 * when the row was already gone. `describeSubscriberStoreContract` in `store-contract.test.ts`
 * pins every rule.
 */
export interface SubscriberStore {
  /** Every subscriber, oldest first. */
  list(): Promise<Subscriber[]>
  findByKey(key: string): Promise<Subscriber | undefined>
  /** Checks, in this order: the address is already listed (`"known"`), the link is a replay
   * (`"replay"`), else stores it (`"added"`). */
  add(input: AddSubscriberInput): Promise<AddSubscriberResult>
  /** Removes the address and records the unsubscribe. True when a row was removed. */
  remove(input: RemoveSubscriberInput): Promise<boolean>
  count(): Promise<number>
}
