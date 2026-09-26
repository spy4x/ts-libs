// Behaviour tests for the dev/console adapter — the port implementation that
// needs no mail server, no socket and no permission.

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert"
import { createConsoleSender, type SendFailure, type SendResult } from "./sender.ts"

/** Narrow a result to a failure, failing loudly when the send unexpectedly succeeded. */
function failure(result: SendResult): SendFailure {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`)
  return result
}

/** Capture every line the adapter writes. */
function makeSink(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

Deno.test("reports the accepted recipient list without sending anything", async () => {
  const sink = makeSink()
  const result = await createConsoleSender({ log: sink.log }).send({
    to: "guest@example.com",
    subject: "Booking confirmed",
    text: "Hello",
  })

  assertEquals(
    result,
    {
      ok: true,
      accepted: ["guest@example.com"],
      duplicates: [],
    } satisfies SendResult,
  )
})

Deno.test("logs a summary line and a body preview", () => {
  const sink = makeSink()
  const sender = createConsoleSender({ log: sink.log })

  return sender.send({ to: ["a@example.com", "b@example.com"], subject: "Hi", text: "Body text" })
    .then(() => {
      assertEquals(sink.lines.length, 2)
      assertEquals(
        sink.lines[0],
        `[email:console] to=a@example.com,b@example.com subject="Hi" text=9B attachments=0`,
      )
      assertEquals(sink.lines[1], "Body text")
    })
})

Deno.test("logs the replyTo addresses when the message has them", async () => {
  const sink = makeSink()
  await createConsoleSender({ log: sink.log }).send({
    to: "a@example.com",
    replyTo: ["Anton <hello@example.com>", "owner@example.com"],
    subject: "Hi",
    text: "Body text",
  })

  assertEquals(
    sink.lines[0],
    `[email:console] to=a@example.com replyTo=hello@example.com,owner@example.com ` +
      `subject="Hi" text=9B attachments=0`,
  )
})

Deno.test("returns a failure naming replyTo for a CRLF in it instead of logging", async () => {
  const sink = makeSink()
  const result = await createConsoleSender({ log: sink.log }).send({
    to: "a@example.com",
    replyTo: "Support\r\nBcc: victim@example.com <support@example.com>",
    subject: "Hi",
    text: "Body",
  })

  const failed = failure(result)
  assertStringIncludes(failed.error, "replyTo: ")
  assertStringIncludes(failed.error, "control character")
  assertEquals(sink.lines, [])
})

Deno.test("truncates a long body and says how much was cut", async () => {
  const sink = makeSink()
  await createConsoleSender({ log: sink.log, previewChars: 4 }).send({
    to: "a@example.com",
    subject: "Hi",
    text: "0123456789",
  })

  assertEquals(sink.lines[1], "0123… (6 more characters)")
})

Deno.test("renders an html-only message as text in the preview", async () => {
  const sink = makeSink()
  await createConsoleSender({ log: sink.log }).send({
    to: "a@example.com",
    subject: "Hi",
    html: "<html><head><style>p{color:red}</style></head><body><p>Hello there</p></body></html>",
  })

  assertStringIncludes(sink.lines[1], "Hello there")
  assertFalse(sink.lines[1].includes("<p>"))
})

Deno.test("returns a failure for an invalid recipient instead of throwing", async () => {
  const result = await createConsoleSender({ log: () => {} }).send({
    to: ["good@example.com", "not an address"],
    subject: "Hi",
    text: "Body",
  })

  const failed = failure(result)
  assertEquals(failed.accepted, [])
  assertEquals(failed.rejected, [])
  assertStringIncludes(failed.error, "Invalid email address")
})

Deno.test("returns a failure for a message with no body", async () => {
  const result = await createConsoleSender({ log: () => {} }).send({
    to: "a@example.com",
    subject: "Hi",
  })

  assertStringIncludes(failure(result).error, "needs a text body")
})

Deno.test("returns a failure for a message with no recipients", async () => {
  const result = await createConsoleSender({ log: () => {} }).send({
    to: [],
    subject: "Hi",
    text: "Body",
  })

  assertStringIncludes(failure(result).error, "recipient")
})

Deno.test("reports a duplicate recipient rather than logging it twice", async () => {
  const sink = makeSink()
  const result = await createConsoleSender({ log: sink.log }).send({
    to: ["a@example.com", "A@example.com"],
    subject: "Hi",
    text: "Body",
  })

  assertEquals(result.duplicates, ["A@example.com"])
  assertEquals(result.accepted, ["a@example.com"])
  assertStringIncludes(sink.lines[0], "to=a@example.com ")
})
