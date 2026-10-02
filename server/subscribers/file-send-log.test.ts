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
    const expected = JSON.parse(SITE_LOG)
    expected[1].recipients = ["a1", "b2"]
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual(expected)
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
      .toThrow("fix it by hand")
    await expect(log.find("p")).rejects.toThrow("fix it by hand")
    expect(fs.files.get(PATH)).toBe(`[{"slug": "p", `)
  })

  it("never overwrites a log that is not an array", async () => {
    const fs = fakeFs({ [PATH]: `{"slug": "p"}` })
    const log = createFileSendLog({ path: PATH, fs })
    await expect(log.record("p", "a1")).rejects.toThrow("not a JSON array")
    expect(fs.files.get(PATH)).toBe(`{"slug": "p"}`)
  })

  it("leaves the old log and no temp file when a write fails", async () => {
    const fs = fakeFs({ [PATH]: SITE_LOG })
    const log = createFileSendLog({ path: PATH, fs })
    fs.failRenames.add(`${PATH}.${Deno.pid}.1.tmp`)
    await expect(log.record("second-post", "b2")).rejects.toThrow()
    expect(fs.files.get(PATH)).toBe(SITE_LOG)
    expect([...fs.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([])
    // The queue keeps going after a failed change.
    await log.record("second-post", "b2")
    expect((await log.find("second-post"))?.recipients).toEqual(["a1", "b2"])
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
})
