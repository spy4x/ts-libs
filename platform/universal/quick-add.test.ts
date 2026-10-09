import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { parseQuickAdd, QuickAddPriority, QuickAddSpanKind, quickAddWords } from "./quick-add.ts"

/** A Tuesday, noon UTC. */
const NOON = new Date("2026-03-10T12:00:00Z")
const UTC = { now: NOON, timeZone: "UTC" }

describe("parseQuickAdd tokens", () => {
  it("reads the example line from the issue", () => {
    const line = "Call Anna @phone #work tomorrow 3pm !high"
    const result = parseQuickAdd(line, UTC)
    expect(result.title).toBe("Call Anna")
    expect(result.contexts).toEqual(["phone"])
    expect(result.tags).toEqual(["work"])
    expect(result.due).toEqual({ date: "2026-03-11", time: "15:00" })
    expect(result.priority).toBe(QuickAddPriority.High)
  })

  it("marks every token with its kind and exact text", () => {
    const line = "Call @phone #work tomorrow at 3pm !1"
    const { spans } = parseQuickAdd(line, UTC)
    expect(spans.map((s) => [s.kind, s.text])).toEqual([
      [QuickAddSpanKind.Context, "@phone"],
      [QuickAddSpanKind.Tag, "#work"],
      [QuickAddSpanKind.Date, "tomorrow"],
      [QuickAddSpanKind.Time, "at 3pm"],
      [QuickAddSpanKind.Priority, "!1"],
    ])
    for (const s of spans) expect(line.slice(s.start, s.end)).toBe(s.text)
  })

  it("reads a nested context as one name", () => {
    expect(parseQuickAdd("x @work/meetings", UTC).contexts).toEqual(["work/meetings"])
  })

  it("lists a repeated tag once but marks both", () => {
    const result = parseQuickAdd("#a b #a", UTC)
    expect(result.tags).toEqual(["a"])
    expect(result.spans.length).toBe(2)
  })

  it("lists a repeated context once but marks both", () => {
    const result = parseQuickAdd("@a/b x @a/b", UTC)
    expect(result.contexts).toEqual(["a/b"])
    expect(result.spans.length).toBe(2)
  })

  it("treats tags and contexts that differ only in case as one, keeping the first spelling", () => {
    const result = parseQuickAdd("#Work #work @Home @home", UTC)
    expect(result.tags).toEqual(["Work"])
    expect(result.contexts).toEqual(["Home"])
  })

  it("returns no due and no priority when the line has none", () => {
    const result = parseQuickAdd("buy milk", UTC)
    expect(result).toEqual({ title: "buy milk", tags: [], contexts: [], spans: [] })
  })

  it("ignores a token inside a word", () => {
    const line = "mail me@example.com about C#, a#b and wow!high"
    const result = parseQuickAdd(line, UTC)
    expect(result.title).toBe(line)
    expect(result.spans).toEqual([])
  })

  it("does not treat a token followed by punctuation as a token", () => {
    expect(parseQuickAdd("ship #work, tomorrow.", UTC).tags).toEqual([])
  })
})

describe("parseQuickAdd priority", () => {
  const cases: [string, QuickAddPriority][] = [
    ["!high", QuickAddPriority.High],
    ["!HIGH", QuickAddPriority.High],
    ["!medium", QuickAddPriority.Medium],
    ["!low", QuickAddPriority.Low],
    ["!1", QuickAddPriority.High],
    ["!2", QuickAddPriority.Medium],
    ["!3", QuickAddPriority.Low],
  ]
  it("reads !high, !medium, !low and !1 to !3, in any case", () => {
    for (const [token, expected] of cases) {
      expect(parseQuickAdd(`t ${token}`, UTC).priority).toBe(expected)
    }
  })

  it("keeps !4 and !urgent in the title", () => {
    const result = parseQuickAdd("t !4 !urgent", UTC)
    expect(result.priority).toBeUndefined()
    expect(result.title).toBe("t !4 !urgent")
  })

  it("lets the first priority win and keeps the second in the title", () => {
    const result = parseQuickAdd("t !low !high", UTC)
    expect(result.priority).toBe(QuickAddPriority.Low)
    expect(result.title).toBe("t !high")
  })
})

describe("parseQuickAdd dates", () => {
  const cases: [string, string][] = [
    ["today", "2026-03-10"],
    ["Tomorrow", "2026-03-11"],
    ["friday", "2026-03-13"],
    ["monday", "2026-03-16"],
    ["tuesday", "2026-03-17"],
    ["in 3 days", "2026-03-13"],
    ["in 1 day", "2026-03-11"],
    ["in 2 weeks", "2026-03-24"],
    ["2026-12-31", "2026-12-31"],
  ]
  it("reads today, tomorrow, weekdays, 'in N days', 'in N weeks' and ISO dates", () => {
    for (const [phrase, date] of cases) {
      const result = parseQuickAdd(`t ${phrase}`, UTC)
      expect(result.due).toEqual({ date })
      expect(result.title).toBe("t")
      expect(result.spans.map((s) => s.text)).toEqual([phrase])
    }
  })

  it("keeps an impossible ISO date in the title", () => {
    const result = parseQuickAdd("t 2026-02-30", UTC)
    expect(result.due).toBeUndefined()
    expect(result.title).toBe("t 2026-02-30")
  })

  it("keeps a bare 'in' that is not followed by a count and a unit", () => {
    const result = parseQuickAdd("stay in bed in 3 hours", UTC)
    expect(result.due).toBeUndefined()
    expect(result.title).toBe("stay in bed in 3 hours")
  })

  it("lets the first date win and keeps the second in the title", () => {
    const result = parseQuickAdd("today tomorrow", UTC)
    expect(result.due).toEqual({ date: "2026-03-10" })
    expect(result.title).toBe("tomorrow")
  })

  it("reads 'tomorrow' in the person's time zone late in the evening", () => {
    // 20:00 UTC on the 10th is already 03:00 on the 11th in Ho Chi Minh City.
    const now = new Date("2026-03-10T20:00:00Z")
    const utc = parseQuickAdd("t tomorrow", { now, timeZone: "UTC" })
    const hcm = parseQuickAdd("t tomorrow", { now, timeZone: "Asia/Ho_Chi_Minh" })
    expect(utc.due).toEqual({ date: "2026-03-11" })
    expect(hcm.due).toEqual({ date: "2026-03-12" })
  })

  it("reads 'tomorrow' behind UTC when the zone is still on the previous day", () => {
    const now = new Date("2026-03-10T03:00:00Z")
    const result = parseQuickAdd("t tomorrow", { now, timeZone: "America/Los_Angeles" })
    expect(result.due).toEqual({ date: "2026-03-10" })
  })

  it("reads a weekday in the person's time zone", () => {
    // Tuesday 20:00 UTC is already Wednesday in Ho Chi Minh City.
    const now = new Date("2026-03-10T20:00:00Z")
    const result = parseQuickAdd("t wednesday", { now, timeZone: "Asia/Ho_Chi_Minh" })
    expect(result.due).toEqual({ date: "2026-03-18" })
  })

  it("counts days across a daylight-saving change", () => {
    // 23:30 on 7 March in New York; the clocks go forward on the 8th, a 23-hour day.
    // Adding 2 x 24 hours to this instant would land on the 10th.
    const now = new Date("2026-03-08T04:30:00Z")
    const result = parseQuickAdd("t in 2 days", { now, timeZone: "America/New_York" })
    expect(result.due).toEqual({ date: "2026-03-09" })
  })

  it("throws on an unknown time zone", () => {
    expect(() => parseQuickAdd("t", { now: NOON, timeZone: "Mars/Base" })).toThrow()
  })
})

describe("parseQuickAdd times", () => {
  const cases: [string, string][] = [
    ["3pm", "15:00"],
    ["3:30PM", "15:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["9am", "09:00"],
    ["15:45", "15:45"],
    ["0:05", "00:05"],
    ["at 7pm", "19:00"],
  ]
  it("reads 12-hour and 24-hour times, with or without 'at'", () => {
    for (const [phrase, time] of cases) {
      const result = parseQuickAdd(`t ${phrase}`, UTC)
      expect(result.due).toEqual({ date: "2026-03-10", time })
      expect(result.title).toBe("t")
    }
  })

  it("keeps impossible times in the title", () => {
    const result = parseQuickAdd("t 13pm 25:00 12:60 0pm", UTC)
    expect(result.due).toBeUndefined()
    expect(result.title).toBe("t 13pm 25:00 12:60 0pm")
  })

  it("keeps 'at' when no time follows", () => {
    expect(parseQuickAdd("look at me", UTC).title).toBe("look at me")
  })

  it("puts a time on the typed date", () => {
    expect(parseQuickAdd("t 2026-05-01 9:15", UTC).due).toEqual({
      date: "2026-05-01",
      time: "09:15",
    })
  })
})

describe("parseQuickAdd escaping", () => {
  it("keeps an escaped tag in the title without the backslash", () => {
    const result = parseQuickAdd(String.raw`Room \#1`, UTC)
    expect(result.title).toBe("Room #1")
    expect(result.tags).toEqual([])
    expect(result.spans).toEqual([])
  })

  it("keeps an escaped context, priority, date word and time", () => {
    const result = parseQuickAdd(String.raw`\@home \!high \tomorrow \3pm \in`, UTC)
    expect(result.title).toBe("@home !high tomorrow 3pm in")
    expect(result.due).toBeUndefined()
    expect(result.priority).toBeUndefined()
  })

  it("leaves a backslash that guards nothing", () => {
    expect(parseQuickAdd(String.raw`C:\temp \n`, UTC).title).toBe(String.raw`C:\temp \n`)
  })
})

describe("parseQuickAdd text", () => {
  it("returns Vietnamese, Cyrillic and emoji text untouched", () => {
    const line = "Gọi chị Hạnh 📞 купить хлеб #việc @дом/кухня 🎉 tomorrow"
    const result = parseQuickAdd(line, UTC)
    expect(result.title).toBe("Gọi chị Hạnh 📞 купить хлеб 🎉")
    expect(result.tags).toEqual(["việc"])
    expect(result.contexts).toEqual(["дом/кухня"])
    for (const s of result.spans) expect(line.slice(s.start, s.end)).toBe(s.text)
  })

  it("gives span offsets in UTF-16 units after an emoji", () => {
    const line = "🎉 #x"
    const [tag] = parseQuickAdd(line, UTC).spans
    expect(tag).toEqual({ kind: QuickAddSpanKind.Tag, start: 3, end: 5, text: "#x" })
  })

  it("collapses the gaps tokens leave into single spaces", () => {
    expect(parseQuickAdd("  a   #t   b  ", UTC).title).toBe("a b")
  })

  it("returns an empty title for an empty line", () => {
    expect(parseQuickAdd("", UTC)).toEqual({ title: "", tags: [], contexts: [], spans: [] })
  })

  it("falls back to English for a locale with no table", () => {
    for (const locale of ["vi-VN", "en-GB", "EN", "constructor", "__proto__", "toString"]) {
      const result = parseQuickAdd("Call mom monday", { ...UTC, locale })
      expect(result.title).toBe("Call mom")
      expect(result.priority).toBeUndefined()
      expect(result.due).toEqual({ date: "2026-03-16" })
    }
  })

  it("reads tokens with the table of the locale's language", () => {
    quickAddWords.xx = { ...quickAddWords.en, tomorrow: "morgen" }
    try {
      const german = parseQuickAdd("t morgen", { ...UTC, locale: "xx-YY" })
      expect(german.due).toEqual({ date: "2026-03-11" })
      expect(parseQuickAdd("t morgen", UTC).due).toBeUndefined()
      expect(parseQuickAdd("t tomorrow", { ...UTC, locale: "xx" }).due).toBeUndefined()
    } finally {
      delete quickAddWords.xx
    }
  })
})
