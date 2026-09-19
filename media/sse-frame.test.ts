import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { formatSseFrame } from "./sse-frame.ts"

describe("formatSseFrame", () => {
  it("writes an event name and the payload", () => {
    expect(formatSseFrame({ event: "progress", data: '{"percent":50}' })).toBe(
      'event: progress\ndata: {"percent":50}\n\n',
    )
  })

  it("defaults to a data field with no event name", () => {
    expect(formatSseFrame({ data: "hello" })).toBe("data: hello\n\n")
  })

  it("splits a multi-line payload into one data field per line", () => {
    // A raw newline inside a data field would end the frame early and the
    // client would silently lose the rest of the payload.
    expect(formatSseFrame({ event: "progress", data: "one\ntwo" })).toBe(
      "event: progress\ndata: one\ndata: two\n\n",
    )
  })

  it("treats a carriage return as a line break", () => {
    expect(formatSseFrame({ data: "one\rtwo" })).toBe("data: one\ndata: two\n\n")
  })

  it("collapses a CRLF pair into a single break", () => {
    expect(formatSseFrame({ data: "one\r\ntwo" })).toBe("data: one\ndata: two\n\n")
  })

  it("includes the id and retry fields when given", () => {
    expect(formatSseFrame({ id: "42", retry: 3000, data: "x" })).toBe(
      "id: 42\nretry: 3000\ndata: x\n\n",
    )
  })

  it("terminates every frame with a blank line", () => {
    expect(formatSseFrame({ data: "" }).endsWith("\n\n")).toBe(true)
  })

  it("keeps an empty payload line so the frame stays readable", () => {
    expect(formatSseFrame({ event: "progress", data: "" })).toBe("event: progress\ndata: \n\n")
  })
})
