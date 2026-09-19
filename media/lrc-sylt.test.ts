import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { parseLrcToSylt, SyltTimestampFormat } from "./lrc-sylt.ts"

const SHEET = [
  "[ti:Sample Song]",
  "[ar:The Artist]",
  "[al:The Album]",
  "[by:someone@example.invalid]",
  "[00:00.50]first line",
  "[00:10.123]second line",
].join("\n")

describe("parseLrcToSylt", () => {
  it("reads two fractional digits as centiseconds", () => {
    const sylt = parseLrcToSylt("[00:01.50]half way")
    expect(sylt?.content).toEqual([{ text: "half way", timeStamp: 1500 }])
  })

  it("reads three fractional digits as milliseconds", () => {
    const sylt = parseLrcToSylt("[00:01.123]precise")
    expect(sylt?.content).toEqual([{ text: "precise", timeStamp: 1123 }])
  })

  it("reads one fractional digit as a fraction of a second", () => {
    // `[00:01.5]` means 1.5 s, not 1 s and 5 ms: the digits are left-aligned.
    const sylt = parseLrcToSylt("[00:01.5]half a second later")
    expect(sylt?.content).toEqual([{ text: "half a second later", timeStamp: 1500 }])
  })

  it("reads a timestamp without a fraction as whole seconds", () => {
    const sylt = parseLrcToSylt("[00:02]two seconds in")
    expect(sylt?.content).toEqual([{ text: "two seconds in", timeStamp: 2000 }])
  })

  it("truncates a four-digit fraction to milliseconds", () => {
    const sylt = parseLrcToSylt("[00:01.1234]over-precise")
    expect(sylt?.content).toEqual([{ text: "over-precise", timeStamp: 1123 }])
  })

  it("accepts a colon in place of the decimal point", () => {
    const sylt = parseLrcToSylt("[00:01:50]colon fraction")
    expect(sylt?.content).toEqual([{ text: "colon fraction", timeStamp: 1500 }])
  })

  it("accepts single-digit minutes and seconds", () => {
    const sylt = parseLrcToSylt("[1:2.300]short form")
    expect(sylt?.content).toEqual([{ text: "short form", timeStamp: 62300 }])
  })

  it("expands every timestamp on a line that carries several", () => {
    const sylt = parseLrcToSylt("[00:01.00][00:05.00]chorus")
    expect(sylt?.content).toEqual([
      { text: "chorus", timeStamp: 1000 },
      { text: "chorus", timeStamp: 5000 },
    ])
  })

  it("skips metadata tags and keeps only the lyric lines", () => {
    const sylt = parseLrcToSylt(SHEET)
    expect(sylt?.content).toEqual([
      { text: "first line", timeStamp: 500 },
      { text: "second line", timeStamp: 10123 },
    ])
  })

  it("skips a timestamped line that carries no text", () => {
    const sylt = parseLrcToSylt("[00:01.00]\n[00:02.00]real line")
    expect(sylt?.content).toEqual([{ text: "real line", timeStamp: 2000 }])
  })

  it("skips prose that is neither a timestamp nor a tag", () => {
    const sylt = parseLrcToSylt("[00:02.00]real line\njust some prose\n[ti:tag]")
    expect(sylt?.content).toEqual([{ text: "real line", timeStamp: 2000 }])
  })

  it("strips a byte-order mark without losing the first line", () => {
    const sylt = parseLrcToSylt("\uFEFF[00:00.10]first line")
    expect(sylt?.content).toEqual([{ text: "first line", timeStamp: 100 }])
  })

  it("declares milliseconds rather than MPEG frames", () => {
    // The source passed 1, which ID3v2.4 defines as MPEG frames, while writing
    // millisecond values.
    const sylt = parseLrcToSylt(SHEET)
    expect(sylt?.timeStampFormat).toBe(SyltTimestampFormat.MILLISECONDS)
    expect(sylt?.timeStampFormat).toBe(2)
  })

  it("applies the offset tag to every entry", () => {
    const sylt = parseLrcToSylt("[offset:+500]\n[00:01.00]shifted later")
    expect(sylt?.content).toEqual([{ text: "shifted later", timeStamp: 1500 }])
  })

  it("applies a negative offset", () => {
    const sylt = parseLrcToSylt("[offset:-250]\n[00:01.00]shifted earlier")
    expect(sylt?.content).toEqual([{ text: "shifted earlier", timeStamp: 750 }])
  })

  it("clamps a negative result of an offset to zero", () => {
    const sylt = parseLrcToSylt("[offset:-9000]\n[00:01.00]pushed past the start")
    expect(sylt?.content).toEqual([{ text: "pushed past the start", timeStamp: 0 }])
  })

  it("takes the language from the la tag", () => {
    const sylt = parseLrcToSylt("[la:rus]\n[00:01.00]privet")
    expect(sylt?.language).toBe("rus")
  })

  it("defaults the language to eng", () => {
    expect(parseLrcToSylt(SHEET)?.language).toBe("eng")
  })

  it("lets the caller override the language", () => {
    const sylt = parseLrcToSylt("[la:rus]\n[00:01.00]privet", { language: "deu" })
    expect(sylt?.language).toBe("deu")
  })

  it("sorts entries by timestamp", () => {
    const sylt = parseLrcToSylt("[00:09.00]third\n[00:01.00]first\n[00:05.00]second")
    expect(sylt?.content.map((entry) => entry.text)).toEqual(["first", "second", "third"])
  })

  it("handles CRLF line endings", () => {
    const sylt = parseLrcToSylt("[ti:tag]\r\n[00:01.00]first\r\n[00:02.00]second\r\n")
    expect(sylt?.content).toEqual([
      { text: "first", timeStamp: 1000 },
      { text: "second", timeStamp: 2000 },
    ])
  })

  it("trims surrounding whitespace from the text", () => {
    const sylt = parseLrcToSylt("[00:01.00]   spaced out   ")
    expect(sylt?.content).toEqual([{ text: "spaced out", timeStamp: 1000 }])
  })

  it("returns null for a sheet with no timestamped line", () => {
    expect(parseLrcToSylt("[ti:Sample]\n[ar:Artist]")).toBe(null)
  })

  it("returns null for empty input", () => {
    expect(parseLrcToSylt("")).toBe(null)
    expect(parseLrcToSylt("\n\n")).toBe(null)
  })
})
