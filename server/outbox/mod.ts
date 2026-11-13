/**
 * `@spy4x/server/outbox` — transactional outbox drain: claim, publish, retry.
 *
 * Not the client's offline queue of writes: that is `@spy4x/realtime/outbox`.
 *
 * `OutboxProcessor`, `OutboxEvent`, `OutboxPublisher`, `OutboxRepository`, `PostgresOutboxRepository`,
 * `LoggingOutboxPublisher`, `JobPublisher`, `retryDelayMs`, `errorCodeOf`, `scheduleOutboxEvent`,
 * `ensureScheduledOutboxEvent`, `OutboxAttemptFailure`, `OutboxLeaseExpiredError`,
 * `attemptFailureLine`, `stepsJob`, `JobStep`, `OutboxKindFilter`.
 *
 * A transactional outbox: a command writes an identity-only row (aggregate, version, kind — never a
 * payload) in the same transaction as its state change, and `OutboxProcessor.drainOnce`/`run` claim
 * committed rows and hand them to a publisher, rescheduling a failing row with exponential backoff
 * without blocking the rest of the batch. Consumers use a drained row to learn that something changed
 * and pull the authoritative state, which is what keeps the outbox itself out of the correctness path.
 *
 * **Delayed and repeating jobs are the same rows with a later `available_at`.**
 * `scheduleOutboxEvent(sql | tx, { eventKind, aggregateType, aggregateId }, { at } | { inMs })` writes a
 * row that no drain claims before its time; pass the `sql.begin` transaction of the change that needs it, and a rollback takes the job with it. Like
 * every outbox row it carries no payload: the publisher reads what it needs from the aggregate.
 * Failures already back off exponentially and stop at `maxAttempts` with the last error name in
 * `last_error_code`. A repeating job lists its kind in `OutboxProcessorOptions.repeatEveryMs`; once a
 * run succeeds, `markProcessed(id, repeatInSeconds)` writes the next run in the same statement, so the
 * chain is one row at a time, never two (a redelivery of a finished run writes nothing). A chain whose
 * run gives up stops, and `ensureScheduledOutboxEvent` at start-up does not restart it while that row
 * is unprocessed: the stored error is the signal. Two options change that, see "Failed attempts and
 * given-up rows" below. Both functions write only the library's columns, so
 * any extra column in an app's `outbox_events` (the template's `group_id`) must be nullable or have a
 * default. `ensureScheduledOutboxEvent` takes an advisory lock on kind, aggregate type and aggregate
 * id inside its own transaction, so two workers starting together leave one chain; give it the pool,
 * not a transaction. The repeat interval counts from the end of a run, not from a fixed clock time.
 *
 * **Cron schedules.** A job that runs at clock times lists its kind in
 * `OutboxProcessorOptions.repeatCron` instead, with a UTC cron expression from `@spy4x/time/cron`
 * (`"0 3 * * *"`, `"@daily"`, `"0 9 * * MON-FRI"`). Once a run succeeds (or, with
 * `repeatAfterGiveUp`, is given up), the next run is written at the schedule's next minute after
 * that moment, through `markProcessed(id, { at })`. A kind in both options, or an invalid expression,
 * throws a `RangeError` at construction. Start the chain at the schedule's next time:
 *
 * ```ts
 * import { nextCronRun } from "@spy4x/time/cron"
 *
 * const NIGHTLY = "0 3 * * *"
 * const job = { eventKind: "outbox.cleanup", aggregateType: "job", aggregateId: JOB_ID }
 * await ensureScheduledOutboxEvent(sql, job, { at: nextCronRun(NIGHTLY, new Date()) })
 * new OutboxProcessor(repository, publisher, { repeatCron: { "outbox.cleanup": NIGHTLY } })
 * ```
 *
 * **Failed attempts and given-up rows.** By default a row that fails says nothing: the processor
 * stores the error name on it and retries, and after `maxAttempts` never claims it again. Three
 * options, all off by default, make that visible and recoverable:
 *
 * - `OutboxProcessorOptions.onAttemptFailed` is called for every failed attempt with
 *   `{ event, error, attempt, maxAttempts, lastAttempt, stage }`. `stage` is `publish` when the
 *   publisher threw, `markProcessed` when the publish worked and writing the "processed" mark failed
 *   (the event is then delivered again), and `lease` when the last attempt ended with no outcome;
 *   `error` is then an `OutboxLeaseExpiredError`. `lastAttempt: true` means the row is given up. The
 *   callback is called and not awaited: one that is slow or never settles holds nothing up, and what
 *   it throws or rejects with goes to `console.error`. Only a lost last attempt is reported; an
 *   earlier one that was lost is simply tried again.
 * - `OutboxProcessorOptions.repeatAfterGiveUp: true` writes the next run of a repeating job when a run
 *   is given up, one interval later (or at its next cron time), so one bad night costs one run and
 *   not the chain.
 * - `ensureScheduledOutboxEvent(sql, event, when, { replaceGivenUpAfter: maxAttempts, onReplaced })`
 *   closes a waiting row that has been tried `maxAttempts` times and starts the chain again, in the
 *   same transaction and under the same advisory lock, so two workers starting together still leave
 *   one chain. `onReplaced` gets each closed row's `id`, `attemptCount` and `lastErrorCode`.
 *
 * **With either processor option, giving up closes the row.** `PostgresOutboxRepository.giveUp` sets
 * `processed_at` and keeps the error name in `last_error_code`: a processed row with an error code is
 * one that was given up. Without the options a given-up row stays unprocessed, as before. Closing is
 * what the guarantees rest on, because every other statement already skips a processed row:
 *
 * - **Told once.** A last attempt is reported by the worker whose `giveUp` closed the row, after it
 *   closed it. A second worker, or the slow worker itself when its publish fails later, closes
 *   nothing and reports nothing.
 * - **No attempt starts afterwards.** A closed row is never claimed again, even with a higher
 *   `maxAttempts`, and `release` does not bring it back.
 * - **One next run.** With `repeatAfterGiveUp`, the give-up and the repeating `markProcessed` each
 *   need the row unprocessed, so whichever commits first writes the next run and the other writes
 *   none. The give-up also writes none while another unprocessed run of the same kind and aggregate
 *   waits.
 * - **Restart at start-up works without an option.** `ensureScheduledOutboxEvent` no longer sees the
 *   closed row as waiting and starts the chain again. `replaceGivenUpAfter` is for rows given up by
 *   a processor that runs without these options.
 *
 * A `lease` report comes from `findLost`: rows out of attempts whose lease ran out at least one more
 * lease length ago (`available_at + (available_at - claimed_at) <= now()`), so a worker that is alive
 * gets twice its lease before its row is given up under it. What the library cannot promise:
 *
 * - A worker more than twice its lease late is taken for dead. The publish it is in can still
 *   complete after the `lease` report. A row it claimed in the same batch and had not started is
 *   given up without having been tried on that attempt.
 * - A row given up before the option was set is reported once as `lease`, although its last attempt
 *   failed and was not lost. The row keeps the error name that attempt stored, and the failure
 *   carries it as `storedErrorCode`; `OutboxLeaseExpired` is stored only on a row that had none.
 * - The `lease` stage closes the row before it calls the callback. A process that dies between the
 *   two never reports that row: it stays closed with its error code, which a query for processed
 *   rows with `last_error_code IS NOT NULL` finds.
 * - A slow worker whose publish succeeds after its row was given up still marks it processed, which
 *   clears the stored error name on a non-repeating row.
 *
 * `giveUp` and `findLost` are optional members of `OutboxRepository`. A repository without them still
 * gets `onAttemptFailed` for the `publish` and `markProcessed` stages, with the given-up row left
 * unprocessed, and `repeatAfterGiveUp` refuses it at construction.
 *
 * **The row is small.** `OutboxEvent` carries only `id`, `eventKind`, `aggregateType`,
 * `aggregateId`, `aggregateVersion` and `attemptCount`. A consumer that wants to route or filter on
 * more than the aggregate identity pulls the authoritative row instead, which is the pattern the module
 * exists to enforce.
 *
 * **The retry delay reuses `@spy4x/integrations`'s backoff for its clamp.** `retryDelayMs`
 * computes the uncapped delay itself — `Math.max(1, attemptCount)` before subtracting one for the exponent, and the same `exponent >= 32 ?
 * Infinity : …` guard, which matters when `baseMs` is `0`: without it, `0 * 2 ** exponent` is `0` for a
 * merely large exponent and `NaN` once the exponent overflows `2 ** exponent` to `Infinity` — then hands
 * that number to `createExponentialBackoff`'s own `(attempt, retryAfterMs)` form so the final
 * `Math.min`/`Math.max` clamp to `[0, maxDelayMs]` is not a second copy of that logic. `retryDelayMs(0,
 * …)`, a negative attempt and a fractional attempt all return the delay for attempt 1, not a
 * shorter delay computed from a negative or fractional exponent. No jitter: one worker holds a claimed row at a time via its lease, so there is nothing to
 * de-synchronise.
 *
 * **`errorCodeOf` falls back to `"Error"` when `name` is not a string**, the same rule
 * `integrations/retry.ts`'s `readErrorName` follows. `error.name || "Error"`
 * would be truthy for any non-empty, non-zero
 * `name`, including a number, so an `Error` whose `name` was reassigned to something other than a
 * string would reach `.slice(0, 64)` on that value and throw `TypeError: name.slice is not a function` — from
 * inside `OutboxProcessor.drainOnce`'s own `catch`, which meant one poisoned event stopped the whole
 * batch and never rescheduled that event either. A non-`Error` thrown value is still reported by
 * `typeof`, which returns one of a fixed, small set of strings and cannot carry arbitrary caller text.
 *
 * **`PostgresOutboxRepository` aliases every returned column to its `OutboxEvent` field name in SQL,**
 * rather than relying on the caller's `Sql` having been created with a snake-to-camel row transform.
 * The template's own client set `transform: postgres.camel` globally, but `@spy4x/server/db`'s
 * `createSql` does not default to one — aliasing in the query itself means this repository's row shape
 * does not depend on how a caller configured their pool.
 *
 * **Lease expiry can still double-deliver, and that is inherent, not a bug this repository closes.**
 * `FOR UPDATE SKIP LOCKED` only holds for the claiming statement; what actually keeps a claimed row
 * invisible is pushing `available_at` forward by the lease. A worker that dies mid-publish releases its
 * rows once the lease elapses rather than stranding them, but if the first worker's publish was still
 * in flight when the lease ran out, a second worker can deliver the same event. A publisher that cannot
 * tolerate a duplicate needs its own idempotency key; nothing on the SQL side removes this trade. The
 * drain narrows the window: it stops a batch before an event it predicts would outlast the lease, using
 * the slowest publish seen so far. Passing `slowestPublishMs` (the slowest publish you expect) sets a
 * floor for that prediction, so a publish no slower than it is never delivered twice because of the
 * lease. A worker that crashes mid-publish, a publish slower than `slowestPublishMs`, and the first
 * event of a batch (always tried, so the rule also assumes the claim returns within the lease minus
 * `slowestPublishMs`) stay outside that rule. The value must cover the publish plus marking the row
 * processed, and must be below the lease. What
 * `FOR UPDATE SKIP LOCKED` does guarantee — that two connections claiming at the same time never both
 * receive the same row — is pinned by `never claims the same row from two connections at once`, which
 * opens an explicit transaction on one connection and claims from a second one while the first is still
 * open.
 *
 * **Slow jobs get their own lane.** One processor drains its rows one after another, so a batch of
 * slow jobs holds up every fast event behind it. Run two processors on the same table, each over
 * its own `PostgresOutboxRepository`: `new PostgresOutboxRepository(sql, { kinds: { only: slow } })`
 * and `{ kinds: { except: slow } }`. Give every kind to exactly one lane, or it is claimed by both
 * or by none.
 *
 * **The Postgres repository needs a small table.** The claim/retry/mark-processed SQL is generic
 * over any table shaped like this:
 *
 * ```sql
 * CREATE TABLE outbox_events (
 *   id                UUID PRIMARY KEY,
 *   event_kind        VARCHAR(64) NOT NULL,
 *   aggregate_type    VARCHAR(64) NOT NULL,
 *   aggregate_id      UUID NOT NULL,
 *   aggregate_version BIGINT NOT NULL,
 *   attempt_count     INT4 NOT NULL DEFAULT 0,
 *   available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   claimed_at        TIMESTAMPTZ,
 *   processed_at      TIMESTAMPTZ,
 *   last_error_code   VARCHAR(64),
 *   created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 * CREATE INDEX ON outbox_events (available_at, created_at) WHERE processed_at IS NULL;
 * ```
 *
 * `aggregate_id` only needs to be a type Postgres returns as a string through this driver — `UUID`
 * fits the template's own aggregates, but the repository never assumes it. An app may keep extra
 * columns the repository neither reads nor returns, such as the template's own `group_id` and
 * `actor_user_id`. They must be nullable or have a default, because the library inserts rows itself
 * (`scheduleOutboxEvent`, `ensureScheduledOutboxEvent` and the next run of a repeating job) and
 * writes only its own columns. Recommended but not
 * required: a unique index on `(aggregate_type, aggregate_id, aggregate_version, event_kind)`, which is
 * what makes a retried `INSERT` (after a crash between the state change and the outbox row) idempotent
 * instead of writing the event twice — the template had this index; it is not enforced here because
 * the repository reads and updates rows but never creates or migrates the table.
 *
 * **Jobs next to other rows: `JobPublisher`.** An outbox that holds both jobs and change rows needs
 * one publisher that tells them apart. `new JobPublisher({ aggregateType, handlers, fallback })` runs
 * the handler keyed by `eventKind` for a row whose `aggregateType` is the job type, and passes every
 * other row to `fallback`. A job with no handler throws a `RangeError`, so it is retried and then
 * stops with the error stored on the row, instead of vanishing into the fallback. Only the object's
 * own keys count as handlers, so a row whose kind is `toString` has none.
 *
 * ```ts
 * const publisher = new JobPublisher({
 *   aggregateType: "job",
 *   handlers: { "outbox.cleanup": () => removeOldRows(sql) },
 *   fallback: changeNotifier,
 * })
 * new OutboxProcessor(repository, publisher, { repeatEveryMs: { "outbox.cleanup": 86_400_000 } })
 * ```
 *
 * **Logging failed attempts, purging, and jobs of several steps.** `attemptFailureLine(failure)` is
 * the log line for `onAttemptFailed`: a `warn:` line for an attempt that will be retried, an `error:`
 * line for the last one, naming the row's kind, aggregate, attempt, stage and error name, never the
 * error's message (a mail or billing error can quote an address). `repository.removeProcessed(days)`
 * deletes the rows processed more than `days` days ago and returns how many; without it the table only
 * grows. `stepsJob(label, steps, log)` is a job that runs every step even when an earlier one throws,
 * logs each failure with the step's name and message, and then throws naming the failed steps so the
 * processor retries.
 *
 * ```ts
 * const processor = new OutboxProcessor(
 *   repository,
 *   new JobPublisher({
 *     aggregateType: "job",
 *     handlers: {
 *       "outbox.cleanup": stepsJob("nightly cleanup", [
 *         ["outbox", () => repository.removeProcessed(7)],
 *         ["sessions", () => removeExpiredSessions(sql)],
 *       ], log),
 *     },
 *     fallback: changeNotifier,
 *   }),
 *   { onAttemptFailed: (failure) => log(attemptFailureLine(failure)) },
 * )
 * ```
 *
 * @module
 */
export {
  type DrainResult,
  errorCodeOf,
  type LostOutboxEvent,
  type OutboxAttemptFailure,
  type OutboxEvent,
  type OutboxFailureStage,
  OutboxLeaseExpiredError,
  type OutboxNextRun,
  OutboxProcessor,
  type OutboxProcessorOptions,
  type OutboxPublisher,
  type OutboxRepository,
  retryDelayMs,
} from "./processor.ts"
export { LoggingOutboxPublisher } from "./logging-publisher.ts"
export { type JobHandler, JobPublisher, type JobPublisherOptions } from "./job-publisher.ts"
export { attemptFailureLine, type JobStep, stepsJob } from "./job-log.ts"
export {
  type OutboxKindFilter,
  PostgresOutboxRepository,
  type PostgresOutboxRepositoryOptions,
} from "./postgres-repository.ts"
export {
  type EnsureScheduledOptions,
  ensureScheduledOutboxEvent,
  type OutboxSchedule,
  type ReplacedOutboxEvent,
  type ScheduledOutboxEvent,
  scheduleOutboxEvent,
} from "./schedule.ts"
