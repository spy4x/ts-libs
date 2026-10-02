// The `SendLog` contract, written once and run against every log: `memory-send-log.test.ts` and
// `file-send-log.test.ts` run it in the unit tier, the Postgres log runs it from its own test.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeSendLogContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { SendLog } from "./send-log.ts"

/** A fresh, empty log and how to dispose of it. */
export interface SendLogFixture {
  log: SendLog
  close(): Promise<void>
}

/** Opens a fresh, empty log. */
export type OpenSendLog = () => Promise<SendLogFixture>

const AT = new Date(Date.UTC(2001, 0, 1))
const LATER = new Date(Date.UTC(2001, 0, 2))

async function withLog(open: OpenSendLog, body: (log: SendLog) => Promise<void>) {
  const { log, close } = await open()
  try {
    await body(log)
  } finally {
    await close()
  }
}

function start(log: SendLog, issue = "post", audience = ["a1", "b2"]) {
  return log.start({ issue, subject: `Subject of ${issue}`, audience, at: AT })
}

/** Registers the `SendLog` contract under `describe(name)`, against logs from `open`. */
export function describeSendLogContract(name: string, open: OpenSendLog) {
  describe(`${name} holds to the send log contract`, () => {
    it("finds nothing for an issue that was never started", () =>
      withLog(open, async (log) => {
        expect(await log.find("post")).toBeUndefined()
      }))

    it("stores the subject, start time and audience when an issue starts, with no recipient yet", () =>
      withLog(open, async (log) => {
        const entry = await start(log)
        expect(entry).toEqual({
          issue: "post",
          subject: "Subject of post",
          startedAt: AT,
          audience: ["a1", "b2"],
          recipients: [],
        })
        expect(await log.find("post")).toEqual(entry)
      }))

    it("keeps the first audience and subject when an issue starts a second time", () =>
      withLog(open, async (log) => {
        await start(log)
        await log.record("post", "a1")
        const again = await log.start({
          issue: "post",
          subject: "Another subject",
          audience: ["a1", "b2", "c3"],
          at: LATER,
        })
        expect(again.subject).toBe("Subject of post")
        expect(again.startedAt).toEqual(AT)
        expect(again.audience).toEqual(["a1", "b2"])
        expect(again.recipients).toEqual(["a1"])
      }))

    it("records a recipient once however often it is recorded", () =>
      withLog(open, async (log) => {
        await start(log)
        await log.record("post", "a1")
        await log.record("post", "a1")
        await log.record("post", "b2")
        expect((await log.find("post"))?.recipients).toEqual(["a1", "b2"])
      }))

    it("keeps each issue's recipients apart", () =>
      withLog(open, async (log) => {
        await start(log, "one")
        await start(log, "two")
        await log.record("one", "a1")
        expect((await log.find("one"))?.recipients).toEqual(["a1"])
        expect((await log.find("two"))?.recipients).toEqual([])
      }))

    it("refuses to record or finish an issue that was never started", () =>
      withLog(open, async (log) => {
        await expect(log.record("post", "a1")).rejects.toThrow("never started")
        await expect(log.finish({ issue: "post", failed: 0, at: AT })).rejects.toThrow(
          "never started",
        )
      }))

    it("closes an issue when a run finishes with no failure and counts its recipients", () =>
      withLog(open, async (log) => {
        await start(log)
        await log.record("post", "a1")
        await log.record("post", "b2")
        await log.finish({ issue: "post", failed: 0, at: LATER })
        const entry = await log.find("post")
        expect(entry?.sent).toBe(2)
        expect(entry?.failed).toBe(0)
        expect(entry?.completedAt).toEqual(LATER)
      }))

    it("leaves an issue open when a run finishes with a failure", () =>
      withLog(open, async (log) => {
        await start(log)
        await log.record("post", "a1")
        await log.finish({ issue: "post", failed: 1, at: LATER })
        const entry = await log.find("post")
        expect(entry?.sent).toBe(1)
        expect(entry?.failed).toBe(1)
        expect(entry?.completedAt).toBeUndefined()
      }))

    it("hands out copies, so a caller cannot change what is stored", () =>
      withLog(open, async (log) => {
        const entry = await start(log)
        entry.recipients?.push("hacked")
        entry.audience?.push("hacked")
        entry.startedAt.setFullYear(1999)
        const stored = await log.find("post")
        expect(stored?.recipients).toEqual([])
        expect(stored?.audience).toEqual(["a1", "b2"])
        expect(stored?.startedAt).toEqual(AT)
      }))

    it("refuses a second lock on an issue while the first is held, and grants it after release", () =>
      withLog(open, async (log) => {
        const first = await log.lock("post")
        expect(first).toBeDefined()
        expect(await log.lock("post")).toBeUndefined()
        await first?.release()
        const second = await log.lock("post")
        expect(second).toBeDefined()
        await second?.release()
      }))

    it("does not let a lock released twice free the next holder's lock", () =>
      withLog(open, async (log) => {
        const first = await log.lock("post")
        await first?.release()
        const second = await log.lock("post")
        await first?.release()
        expect(await log.lock("post")).toBeUndefined()
        await second?.release()
      }))
  })
}
