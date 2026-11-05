/**
 * A publisher for development and smoke tests that only logs each event.
 *
 * Recording the event is enough to prove the drain works end to end. A caller
 * wiring up a real transport (the realtime package, a queue) supplies its own
 * `OutboxPublisher` instead.
 */
import type { OutboxEvent, OutboxPublisher } from "./processor.ts"

export class LoggingOutboxPublisher implements OutboxPublisher {
  publish(event: OutboxEvent): Promise<void> {
    console.log(
      `outbox ${event.eventKind} ${event.aggregateType}#${event.aggregateId}` +
        ` v${event.aggregateVersion}`,
    )
    return Promise.resolve()
  }
}
