/**
 * One issue's record in a {@link SendLog}: who was meant to get it and who already did.
 *
 * Recipients are kept as `SubscriptionCrypto.sentMark` values, keyed hashes of the issue and the
 * address, never addresses.
 */
export interface SendLogEntry {
  /** The id the app gave the issue, such as a post slug. */
  issue: string
  subject: string
  /** When the send was claimed, before the first mail went out. */
  startedAt: Date
  /**
   * Marks of everyone on the list when the first run started: the people the issue is meant for. A
   * later run mails only their missing members, so a subscriber who joined afterwards never gets an
   * old issue.
   */
  audience?: string[]
  /**
   * Marks of everyone the relay accepted. Absent on an entry written before recipients were
   * recorded: such an issue counts as sent and is never mailed again.
   */
  recipients?: string[]
  /** How many mails the relay accepted in total. */
  sent?: number
  /** How many mails failed in the latest run. */
  failed?: number
  /** Set by a run that finished with no failure; the issue is then closed. */
  completedAt?: Date
}

/** The input of {@link SendLog.start}. */
export interface StartSendInput {
  issue: string
  subject: string
  /** The marks of everyone on the list now, under the current secret. */
  audience: readonly string[]
  at: Date
}

/** The input of {@link SendLog.finish}. */
export interface FinishSendInput {
  issue: string
  /** How many mails failed in this run. Zero closes the issue. */
  failed: number
  at: Date
}

/** A held send lock. */
export interface SendLock {
  /** Frees the lock. Safe to call twice. */
  release(): Promise<void>
}

/**
 * Where a send remembers what it did, so a repeated run mails nobody twice and a rerun after a
 * partial failure mails only the people it missed. Each method is one intent, so an adapter can do
 * it atomically: a Postgres log in one statement and `pg_try_advisory_lock` for the lock, a file
 * log under its lock. `describeSendLogContract` in `send-log-contract.test.ts` pins every rule.
 */
export interface SendLog {
  /**
   * Takes the send lock for `issue`, or answers `undefined` at once when another run holds it; it
   * never waits. A crashed holder frees it. An adapter may lock coarser than the issue (the file
   * log locks its whole file), so hold it only while sending, and never rely on two issues sending
   * in parallel.
   */
  lock(issue: string): Promise<SendLock | undefined>
  /** The entry of `issue`, or `undefined` when it was never started. */
  find(issue: string): Promise<SendLogEntry | undefined>
  /**
   * Opens `issue` and returns its entry. The first call stores `subject`, `at` and `audience`; a
   * later call changes nothing and returns what is stored, except that an entry that has recipients
   * but no audience (written before audiences were recorded) gets `audience`. An entry with no
   * recipients (a legacy one) is returned as it is.
   */
  start(input: StartSendInput): Promise<SendLogEntry>
  /** Adds `mark` to the recipients of `issue`. Adding a mark twice stores it once. Throws when
   * `issue` was never started. */
  record(issue: string, mark: string): Promise<void>
  /** Stores how the run ended: `sent` becomes the number of recipients, `failed` the given count,
   * and `completedAt` is set when none failed. Throws when `issue` was never started. */
  finish(input: FinishSendInput): Promise<void>
}
