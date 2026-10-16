import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { attemptFailureLine, type JobStep, stepsJob } from "./job-log.ts"
import type { OutboxAttemptFailure, OutboxEvent } from "./processor.ts"

const ID = "01900000-0000-7000-8000-000000000001"

/** An outbox row as the processor hands it over, on attempt `attemptCount`. */
function row(attemptCount: number, aggregateType = "job", eventKind = "mail.send"): OutboxEvent {
  return { id: ID, eventKind, aggregateType, aggregateId: ID, aggregateVersion: "1", attemptCount }
}

describe("stepsJob", () => {
  /** Three steps that note their run; the middle one throws. */
  function steps(ran: string[]): JobStep[] {
    return [
      ["first", () => Promise.resolve(void ran.push("first"))],
      ["broken", () => Promise.reject(new Error("relation notes does not exist"))],
      ["last", () => Promise.resolve(void ran.push("last"))],
    ]
  }

  it("runs the steps after one that throws, logs its name and message, then fails the job", async () => {
    const ran: string[] = []
    const logged: string[] = []

    const run = stepsJob("nightly cleanup", steps(ran), (line) => logged.push(line))(row(1))

    await expect(run).rejects.toThrow(`nightly cleanup: 1 step(s) failed: "broken"`)
    expect(ran).toEqual(["first", "last"])
    expect(logged).toEqual([
      `error: nightly cleanup step "broken" failed: relation notes does not exist`,
    ])
  })

  it("names every failed step, a thrown non-error included", async () => {
    const logged: string[] = []
    const failing: JobStep[] = [
      ["a", () => Promise.reject(new Error("lock timeout"))],
      ["b", () => Promise.reject("disk full")],
    ]

    const run = stepsJob("purge", failing, (line) => logged.push(line))(row(1))

    await expect(run).rejects.toThrow(`purge: 2 step(s) failed: "a", "b"`)
    expect(logged).toEqual([
      `error: purge step "a" failed: lock timeout`,
      `error: purge step "b" failed: disk full`,
    ])
  })

  it("logs nothing and ends normally when every step succeeds", async () => {
    const logged: string[] = []
    const ran: string[] = []
    const fine = steps(ran).filter(([name]) => name !== "broken")

    await stepsJob("nightly cleanup", fine, (line) => logged.push(line))(row(1))

    expect(ran).toEqual(["first", "last"])
    expect(logged).toEqual([])
  })
})

describe("attemptFailureLine", () => {
  /** What the processor reports for attempt `attempt` of 3 of a mail job that threw. */
  function failure(
    attempt: number,
    more: Partial<OutboxAttemptFailure> = {},
  ): OutboxAttemptFailure {
    return {
      event: row(attempt),
      error: new TypeError("no route to ann@example.com"),
      attempt,
      maxAttempts: 3,
      lastAttempt: attempt >= 3,
      stage: "publish",
      ...more,
    }
  }

  it("words a failed attempt with the row's kind, the stage and the error's name", () => {
    expect(attemptFailureLine(failure(2))).toBe(
      `warn: outbox row mail.send (job ${ID}) failed at publish, attempt 2 of 3: TypeError`,
    )
  })

  it("words the last attempt as abandoned, naming the row's kind", () => {
    expect(attemptFailureLine(failure(3))).toBe(
      `error: outbox row mail.send (job ${ID}) abandoned at publish after 3 attempts: TypeError`,
    )
  })

  it("never carries the error's message, which can quote an address", () => {
    const lines = [
      attemptFailureLine(failure(1)),
      attemptFailureLine(failure(1, { error: "ann@example.com" })),
    ]

    expect(lines.join("\n")).not.toContain("ann@example.com")
    expect(lines[1]).toContain(": string")
  })

  it("names the error an earlier attempt stored when the worker died mid-run", () => {
    const line = attemptFailureLine(
      failure(3, { stage: "lease", error: new Error("lost"), storedErrorCode: "PostgresError" }),
    )

    expect(line).toBe(
      `error: outbox row mail.send (job ${ID}) abandoned at lease after 3 attempts: PostgresError`,
    )
  })
})
