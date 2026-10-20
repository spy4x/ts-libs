import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { fakeFs } from "../../platform/server/_fake-fs.ts"
import { createFileSendLog } from "./file-send-log.ts"
import { describeSendLogContract } from "./send-log-contract.test.ts"

const PATH = "/data/newsletter-log.json"

/** The site's log file format, with fake data: a legacy entry, an open one and a closed one. */
const SITE_LOG = await Deno.readTextFile(
  new URL(import.meta.resolve("../__fixtures__/newsletter-log.json")),
)

describeSendLogContract("createFileSendLog", () => {
  const fs = fakeFs({ "/data/.keep": "" })
  return Promise.resolve({
    log: createFileSendLog({ path: PATH, fs }),
    close: () => Promise.resolve(),
  })
})

describe("createFileSendLog", () => {
  it("reads the site's newsletter-log.json unchanged", async () => {
    const log = createFileSendLog({ path: PATH, fs: fakeFs({ [PATH]: SITE_LOG }) })
    expect(await log.find("first-post")).toEqual({
      issue: "first-post",
      subject: "New article: First post",
      startedAt: new Date("2026-09-25T10:00:00.000Z"),
      sent: 2,
      failed: 0,
    })
    const open = await log.find("second-post")
    expect(open?.audience).toEqual(["a1", "b2", "c3"])
    expect(open?.recipients).toEqual(["a1"])
    expect(open?.completedAt).toBeUndefined()
    expect((await log.find("third-post"))?.completedAt).toEqual(
      new Date("2026-09-27T10:01:00.000Z"),
    )
  })

  it("writes back every other entry as the site had it, and the new mark in the site's format", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG })
    const log = createFileSendLog({ path: PATH, fs })
    await log.record("second-post", "b2")
    await log.finish({ issue: "second-post", failed: 1, at: new Date() })
    const expected = JSON.parse(SITE_LOG)
    expected[1].recipients = ["a1", "b2"]
    expected[1].sent = 2
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual(expected)
    expect(fs.files.has(`${PATH}.journal`)).toBe(false)
  })

  it("records each recipient with one append and never rewrites the log for it", async () => {
    const fs = fakeFs({ "/data/.keep": "" })
    const log = createFileSendLog({ path: PATH, fs })
    await log.start({ issue: "p", subject: "S", audience: [], at: new Date() })
    const before = fs.calls.length
    for (let i = 0; i < 50; i++) await log.record("p", `m${i}`)
    const calls = fs.calls.slice(before)
    expect(calls.filter((c) => c.op === "appendText").length).toBe(50)
    expect(calls.filter((c) => c.op !== "appendText" && c.op !== "readText").length).toBe(0)
    expect(calls.filter((c) => c.op === "readText").length).toBeLessThanOrEqual(2)
  })

  it("keeps every recorded recipient when a run dies before it finishes", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG })
    await createFileSendLog({ path: PATH, fs }).record("second-post", "b2")
    // A new process, as after a crash: it reads the file and the journal the dead one left.
    const log = createFileSendLog({ path: PATH, fs })
    expect((await log.find("second-post"))?.recipients).toEqual(["a1", "b2"])
  })

  it("ignores a journal line a crash cut short", async () => {
    const fs = fakeFs({
      [PATH]: SITE_LOG,
      [`${PATH}.journal`]: `{"slug":"second-post","mark":"b2"}\n{"slug":"second-po`,
    })
    const log = createFileSendLog({ path: PATH, fs })
    expect((await log.find("second-post"))?.recipients).toEqual(["a1", "b2"])
  })

  it("drops a torn journal line before the next run appends, so its finish succeeds", async () => {
    const fs = fakeFs({
      [PATH]: SITE_LOG,
      [`${PATH}.journal`]: `{"slug":"second-post","mark":"b2"}\n{"slug":"second-po`,
    })
    const log = createFileSendLog({ path: PATH, fs })
    await log.start({ issue: "second-post", subject: "S", audience: [], at: new Date() })
    await log.record("second-post", "c3")
    await log.finish({ issue: "second-post", failed: 0, at: new Date() })
    expect(JSON.parse(fs.files.get(PATH)!)[1].recipients).toEqual(["a1", "b2", "c3"])
    expect(fs.files.has(`${PATH}.journal`)).toBe(false)
  })

  it("refuses to read a journal with a complete line that is not a mark", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG, [`${PATH}.journal`]: `nonsense\n` })
    const log = createFileSendLog({ path: PATH, fs })
    await expect(log.find("second-post")).rejects.toThrow("Fix it by hand")
  })

  it("leaves a legacy entry untouched when its issue starts again", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG })
    const log = createFileSendLog({ path: PATH, fs })
    const entry = await log.start({
      issue: "first-post",
      subject: "x",
      audience: ["z"],
      at: new Date(),
    })
    expect(entry.recipients).toBeUndefined()
    expect(entry.audience).toBeUndefined()
    expect(fs.files.get(PATH)).toBe(SITE_LOG)
  })

  it("gives an entry with recipients but no audience the current audience", async () => {
    const before = [{
      slug: "p",
      subject: "S",
      startedAt: "2026-01-01T00:00:00.000Z",
      recipients: ["a1"],
    }]
    const fs = fakeFs({ [PATH]: JSON.stringify(before) })
    const log = createFileSendLog({ path: PATH, fs })
    const entry = await log.start({
      issue: "p",
      subject: "S",
      audience: ["a1", "b2"],
      at: new Date(),
    })
    expect(entry.audience).toEqual(["a1", "b2"])
    expect(JSON.parse(fs.files.get(PATH)!)[0].audience).toEqual(["a1", "b2"])
  })

  it("keeps every recipient when many are recorded at once", async () => {
    const fs = fakeFs({ "/data/.keep": "" })
    const log = createFileSendLog({ path: PATH, fs })
    await log.start({ issue: "p", subject: "S", audience: [], at: new Date() })
    const marks = Array.from({ length: 25 }, (_, i) => `m${i}`)
    await Promise.all(marks.map((mark) => log.record("p", mark)))
    expect((await log.find("p"))?.recipients?.toSorted()).toEqual(marks.toSorted())
  })

  it("never overwrites a log that does not parse", async () => {
    const fs = fakeFs({ [PATH]: `[{"slug": "p", ` })
    const log = createFileSendLog({ path: PATH, fs })
    await expect(log.start({ issue: "p", subject: "S", audience: [], at: new Date() })).rejects
      .toThrow("Fix it by hand")
    await expect(log.find("p")).rejects.toThrow("Fix it by hand")
    expect(fs.files.get(PATH)).toBe(`[{"slug": "p", `)
    expect(fs.files.get(`${PATH}.invalid`)).toBe(`[{"slug": "p", `)
  })

  it("never overwrites a log that is not an array", async () => {
    const fs = fakeFs({ [PATH]: `{"slug": "p"}` })
    const log = createFileSendLog({ path: PATH, fs })
    await expect(log.record("p", "a1")).rejects.toThrow("not a JSON array")
    expect(fs.files.get(PATH)).toBe(`{"slug": "p"}`)
    expect(fs.files.get(`${PATH}.invalid`)).toBe(`{"slug": "p"}`)
  })

  it("leaves the old log and no temp file when a write fails", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG })
    const log = createFileSendLog({ path: PATH, fs })
    fs.failRenames.add(`${PATH}.${Deno.pid}.1.tmp`)
    await log.record("second-post", "b2")
    await expect(log.finish({ issue: "second-post", failed: 0, at: new Date() })).rejects
      .toThrow()
    expect(fs.files.get(PATH)).toBe(SITE_LOG)
    expect([...fs.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([])
    // The journal survives the failed write, and the queue keeps going after it.
    expect((await log.find("second-post"))?.recipients).toEqual(["a1", "b2"])
    await log.record("second-post", "c3")
    expect((await log.find("second-post"))?.recipients).toEqual(["a1", "b2", "c3"])
  })

  it("locks through <path>.lock, so a second log object on the same file is refused", async () => {
    const fs = fakeFs({ "/data/.keep": "" })
    const one = createFileSendLog({ path: PATH, fs })
    const two = createFileSendLog({ path: PATH, fs })
    const held = await one.lock("p")
    expect(fs.locks.has(`${PATH}.lock`)).toBe(true)
    expect(await two.lock("p")).toBeUndefined()
    await held?.release()
    expect(fs.locks.has(`${PATH}.lock`)).toBe(false)
  })

  it("keeps the first damaged copy when the file is damaged again", async () => {
    const fs = fakeFs({ [PATH]: `first damage` })
    const log = createFileSendLog({ path: PATH, fs })
    await expect(log.find("p")).rejects.toThrow("kept in")
    fs.files.set(PATH, `second damage`)
    await expect(log.find("p")).rejects.toThrow("earlier copy is already kept")
    expect(fs.files.get(`${PATH}.invalid`)).toBe(`first damage`)
    expect(fs.files.get(PATH)).toBe(`second damage`)
  })
})
