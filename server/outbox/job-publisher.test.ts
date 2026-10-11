import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { type JobHandler, JobPublisher } from "./job-publisher.ts"
import type { OutboxEvent, OutboxPublisher } from "./processor.ts"

function event(aggregateType: string, eventKind: string): OutboxEvent {
  return {
    id: "0190a000-0000-7000-8000-000000000001",
    eventKind,
    aggregateType,
    aggregateId: "00000000-0000-4000-8000-000000000000",
    aggregateVersion: "1",
    attemptCount: 1,
  }
}

/** A fallback publisher that records what it was given. */
function recorder(): OutboxPublisher & { seen: OutboxEvent[] } {
  const seen: OutboxEvent[] = []
  return { seen, publish: (e) => Promise.resolve(void seen.push(e)) }
}

Deno.test("runs the handler of a job's kind and keeps the job from the fallback", async () => {
  const ran: string[] = []
  const fallback = recorder()
  const publisher = new JobPublisher({
    aggregateType: "job",
    handlers: {
      "outbox.cleanup": (e) => Promise.resolve(void ran.push(`cleanup ${e.aggregateId}`)),
      "report.send": () => Promise.resolve(void ran.push("report")),
    },
    fallback,
  })

  await publisher.publish(event("job", "outbox.cleanup"))

  assertEquals(ran, ["cleanup 00000000-0000-4000-8000-000000000000"])
  assertEquals(fallback.seen, [])
})

Deno.test("passes a row of another aggregate type to the fallback, even one with a job's kind", async () => {
  const ran: string[] = []
  const fallback = recorder()
  const publisher = new JobPublisher({
    aggregateType: "job",
    handlers: { "outbox.cleanup": () => Promise.resolve(void ran.push("cleanup")) },
    fallback,
  })
  const change = event("group", "outbox.cleanup")

  await publisher.publish(change)

  assertEquals(fallback.seen, [change])
  assertEquals(ran, [])
})

Deno.test("throws for a job with no handler instead of passing it on", async () => {
  const fallback = recorder()
  const publisher = new JobPublisher({ aggregateType: "job", handlers: {}, fallback })

  await assertRejects(
    () => publisher.publish(event("job", "report.send")),
    RangeError,
    "no handler for job report.send",
  )
  assertEquals(fallback.seen, [])
})

Deno.test("a job named like a built-in object member has no handler", async () => {
  const publisher = new JobPublisher({ aggregateType: "job", handlers: {}, fallback: recorder() })

  for (const kind of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    await assertRejects(() => publisher.publish(event("job", kind)), RangeError, "no handler")
  }
})

Deno.test("a failing handler and a failing fallback reject the publish", async () => {
  const publisher = new JobPublisher({
    aggregateType: "job",
    handlers: { "report.send": () => Promise.reject(new Error("mail is down")) },
    fallback: { publish: () => Promise.reject(new Error("bus is down")) },
  })

  await assertRejects(() => publisher.publish(event("job", "report.send")), Error, "mail is down")
  await assertRejects(() => publisher.publish(event("group", "changed")), Error, "bus is down")
})

Deno.test("refuses a handler that is not a function when it is built", () => {
  assertThrows(
    () =>
      new JobPublisher({
        aggregateType: "job",
        handlers: { "report.send": "later" as unknown as JobHandler },
        fallback: recorder(),
      }),
    TypeError,
    "report.send",
  )
})
