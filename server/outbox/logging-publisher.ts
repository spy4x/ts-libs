/**
 * A publisher that only logs.
 *
 * Ported from `template/libs/server/outbox/+index.ts`'s `LoggingOutboxPublisher`: a
 * placeholder until a real transport (the realtime package, a queue) is wired up.
 * Recording the event is enough to prove the drain works end to end.
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
