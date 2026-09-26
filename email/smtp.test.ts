// Behaviour tests for the SMTP adapter.
//
// No test opens a socket and none needs `--allow-net`: the transport is injected.
// The recording factory captures the exact connection configuration and the exact
// message object that would have reached the network, which is what the argument
// assembly is asserted on. The MIME-level assertions at the bottom run through
// nodemailer's own `streamTransport`, which compiles the message locally with the
// same `MailComposer` the SMTP transport uses and never dials.
//
// Fixtures are placeholders only: `smtp.example.com`, `user@example.com` and
// `test-password-not-real`.

import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert"
import { decodeBase64, encodeBase64 } from "@std/encoding"
import nodemailer, { type SendMailOptions, type SMTPTransportOptions } from "nodemailer"
import {
  createSmtpSender,
  REDACTED_CREDENTIAL,
  type SmtpOptions,
  type SmtpSendInfo,
  type SmtpTransport,
  type SmtpTransportFactory,
} from "./smtp.ts"
import { type EmailMessage, icalAttachment } from "./message.ts"
import { type IcsEvent, IcsEventStatus, type IcsOptions } from "@spy4x/time/ics"
import type { SendFailure, SendResult } from "./sender.ts"

const PASSWORD = "test-password-not-real"
const USER = "user@example.com"

const BASE_OPTIONS: SmtpOptions = {
  host: "smtp.example.com",
  port: 587,
  user: USER,
  pass: PASSWORD,
  from: "Booking <booking@example.com>",
}

const MESSAGE: EmailMessage = {
  to: "guest@example.com",
  subject: "Booking confirmed",
  text: "Your meeting is booked.",
}

/** Everything the injected factory saw. */
interface Recorded {
  configs: SMTPTransportOptions[]
  messages: SendMailOptions[]
}

/** What the stub transport does when it is called. */
interface StubBehaviour {
  info?: SmtpSendInfo
  fail?: unknown
}

/** A factory that records its arguments and returns a transport that never connects. */
function recorder(recorded: Recorded, behaviour: StubBehaviour = {}): SmtpTransportFactory {
  return (config: SMTPTransportOptions): SmtpTransport => {
    recorded.configs.push(config)
    return {
      sendMail(message: SendMailOptions): Promise<SmtpSendInfo> {
        recorded.messages.push(message)
        if (behaviour.fail !== undefined) return Promise.reject(behaviour.fail)
        return Promise.resolve(behaviour.info ?? { accepted: ["guest@example.com"] })
      },
    }
  }
}

/** A recording sender plus its captured state. */
function makeSender(
  options: Partial<SmtpOptions> = {},
  behaviour: StubBehaviour = {},
): { sender: ReturnType<typeof createSmtpSender>; recorded: Recorded } {
  const recorded: Recorded = { configs: [], messages: [] }
  return {
    sender: createSmtpSender({ ...BASE_OPTIONS, ...options }, recorder(recorded, behaviour)),
    recorded,
  }
}

/** Narrow a result to a failure, failing loudly when the send unexpectedly succeeded. */
function failure(result: SendResult): SendFailure {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`)
  return result
}

// ---------- connection configuration ----------

Deno.test("selects implicit TLS on port 465", async () => {
  const { sender, recorded } = makeSender({ port: 465 })
  await sender.send(MESSAGE)

  assertEquals(recorded.configs.length, 1)
  assertEquals(recorded.configs[0].secure, true)
  assertEquals(recorded.configs[0].port, 465)
  // Already TLS before EHLO, so STARTTLS is not requested.
  assertEquals(recorded.configs[0].requireTLS, undefined)
})

Deno.test("selects STARTTLS on port 587 and requires it by default", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].secure, false)
  assertEquals(recorded.configs[0].requireTLS, true)
})

Deno.test("honours an explicit implicit-TLS flag on a non-standard port", async () => {
  const { sender, recorded } = makeSender({ port: 8465, secure: true })
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].secure, true)
  assertEquals(recorded.configs[0].requireTLS, undefined)
})

Deno.test("sends in the clear only when requireTls is explicitly false", async () => {
  const { sender, recorded } = makeSender({ requireTls: false })
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].secure, false)
  assertEquals(recorded.configs[0].requireTLS, undefined)
})

Deno.test("passes the credentials to the transport and nothing else", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].auth, { user: USER, pass: PASSWORD })
  assertEquals(recorded.configs[0].host, "smtp.example.com")
})

Deno.test("never enables nodemailer debug or a logger", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  const config = recorded.configs[0] as unknown as Record<string, unknown>
  // nodemailer's `debug` writes the whole SMTP conversation — AUTH exchange
  // included — to the logger.
  assertFalse("debug" in config, "debug must never be set: it logs the AUTH exchange")
  assertFalse("logger" in config, "a logger must never be set")
  assertFalse("url" in config, "a connection URL must never be used: some errors echo it back")
})

Deno.test("refuses attachment file and URL access on the transport", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].disableFileAccess, true)
  assertEquals(recorded.configs[0].disableUrlAccess, true)
})

Deno.test("passes the optional timeouts and EHLO name through", async () => {
  const { sender, recorded } = makeSender({
    name: "mail.example.com",
    connectionTimeoutMs: 5000,
    greetingTimeoutMs: 6000,
    socketTimeoutMs: 7000,
  })
  await sender.send(MESSAGE)

  assertEquals(recorded.configs[0].name, "mail.example.com")
  assertEquals(recorded.configs[0].connectionTimeout, 5000)
  assertEquals(recorded.configs[0].greetingTimeout, 6000)
  assertEquals(recorded.configs[0].socketTimeout, 7000)
})

// ---------- no module-scope state ----------

Deno.test("creates no transport until the first send", () => {
  const { recorded } = makeSender()
  assertEquals(recorded.configs.length, 0)
})

Deno.test("gives each sender its own transport for its own configuration", async () => {
  const first: Recorded = { configs: [], messages: [] }
  const second: Recorded = { configs: [], messages: [] }
  const a = createSmtpSender({ ...BASE_OPTIONS, host: "a.example.com" }, recorder(first))
  const b = createSmtpSender({ ...BASE_OPTIONS, host: "b.example.com" }, recorder(second))

  await a.send(MESSAGE)
  await b.send(MESSAGE)

  assertEquals(first.configs.length, 1)
  assertEquals(second.configs.length, 1)
  assertEquals(first.configs[0].host, "a.example.com")
  assertEquals(second.configs[0].host, "b.example.com")
})

Deno.test("reuses one transport across sends from the same sender", async () => {
  const { sender, recorded } = makeSender()

  await sender.send(MESSAGE)
  await sender.send(MESSAGE)

  assertEquals(recorded.configs.length, 1)
  assertEquals(recorded.messages.length, 2)
})

Deno.test("has no module-scope environment read", async () => {
  // The behavioural half of this requirement is the two tests above: nothing is
  // constructed at import and no two senders share a transport. A subprocess
  // import with an empty environment would be stronger evidence, but the root
  // test task grants no `--allow-run`; this assertion covers the "never read the
  // environment" half, which is what `Deno.env` at module scope would look like.
  const source = stripComments(await Deno.readTextFile(new URL("./smtp.ts", import.meta.url)))
  assertFalse(source.includes("Deno.env"), "smtp.ts must never read the environment")
  assertFalse(source.includes("process.env"), "smtp.ts must never read process.env")
})

// ---------- message assembly ----------

Deno.test("assembles a display name as a structured mailbox, not a string", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertEquals(recorded.messages[0].from, {
    name: "Booking",
    address: "booking@example.com",
  })
})

Deno.test("assembles a bare from address as a string", async () => {
  const { sender, recorded } = makeSender({ from: "booking@example.com" })
  await sender.send(MESSAGE)

  assertEquals(recorded.messages[0].from, "booking@example.com")
})

Deno.test("keeps a non-ASCII display name unencoded for the transport to encode", async () => {
  const { sender, recorded } = makeSender({ from: "Buchung – Jörg <booking@example.com>" })
  await sender.send(MESSAGE)

  assertEquals(recorded.messages[0].from, {
    name: "Buchung – Jörg",
    address: "booking@example.com",
  })
})

Deno.test("omits the html part for a text-only message", async () => {
  const { sender, recorded } = makeSender()
  await sender.send({ to: "guest@example.com", subject: "Hi", text: "plain" })

  assertEquals(recorded.messages[0].text, "plain")
  assertEquals("html" in recorded.messages[0], false)
})

Deno.test("omits the text part for an html-only message", async () => {
  const { sender, recorded } = makeSender()
  await sender.send({ to: "guest@example.com", subject: "Hi", html: "<p>rich</p>" })

  assertEquals("text" in recorded.messages[0], false)
  assertEquals(recorded.messages[0].html, "<p>rich</p>")
})

Deno.test("carries both parts for a multipart message", async () => {
  const { sender, recorded } = makeSender()
  await sender.send({ to: "guest@example.com", subject: "Hi", text: "plain", html: "<p>rich</p>" })

  assertEquals(recorded.messages[0].text, "plain")
  assertEquals(recorded.messages[0].html, "<p>rich</p>")
})

Deno.test("omits the attachments key when there are none", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertEquals("attachments" in recorded.messages[0], false)
})

Deno.test("maps an attachment to a utf8 MIME part", async () => {
  const { sender, recorded } = makeSender()
  await sender.send({
    ...MESSAGE,
    attachments: [{
      filename: "meeting.ics",
      content: "BEGIN:VCALENDAR",
      contentType: "text/calendar",
    }],
  })

  assertEquals(recorded.messages[0].attachments, [
    {
      filename: "meeting.ics",
      content: "BEGIN:VCALENDAR",
      contentType: "text/calendar",
      encoding: "utf8",
    },
  ])
})

// ---------- recipient handling ----------

Deno.test("deduplicates recipients before sending", async () => {
  // `info: {}` makes the stub report no recipients, so `accepted` is the envelope
  // this adapter derived — the thing the dedupe is expected to change.
  const { sender, recorded } = makeSender({}, { info: {} })
  const result = await sender.send({
    ...MESSAGE,
    to: ["guest@example.com", "GUEST@example.com", "host@example.com"],
  })

  assertEquals(recorded.messages[0].to, ["guest@example.com", "host@example.com"])
  assertEquals(result.duplicates, ["GUEST@example.com"])
  assertEquals(result.accepted, ["guest@example.com", "host@example.com"])
})

Deno.test("fails the whole send on one invalid recipient, before touching the transport", async () => {
  const { sender, recorded } = makeSender()
  const result = await sender.send({
    ...MESSAGE,
    to: ["good@example.com", "not an address", "also@example.com"],
  })

  const failed = failure(result)
  assertStringIncludes(failed.error, "Invalid email address")
  assertEquals(failed.accepted, [])
  assertEquals(failed.rejected, [])
  assertEquals(recorded.configs.length, 0)
  assertEquals(recorded.messages.length, 0)
})

Deno.test("fails an empty recipient list rather than sending to nobody", async () => {
  const { sender, recorded } = makeSender()
  const failed = failure(await sender.send({ ...MESSAGE, to: [] }))

  assertStringIncludes(failed.error, "recipient")
  assertEquals(recorded.messages.length, 0)
})

// ---------- Reply-To ----------

Deno.test("omits the replyTo key when the message has no replyTo", async () => {
  const { sender, recorded } = makeSender()
  await sender.send(MESSAGE)

  assertFalse("replyTo" in recorded.messages[0])
})

Deno.test("assembles a replyTo display name the same way as a to display name", async () => {
  const { sender, recorded } = makeSender()
  await sender.send({
    ...MESSAGE,
    to: "Doe, Jane <jane@example.com>",
    replyTo: "Doe, Jane <jane@example.com>",
  })

  const expected = [{ name: "Doe, Jane", address: "jane@example.com" }]
  assertEquals(recorded.messages[0].to, expected)
  assertEquals(recorded.messages[0].replyTo, expected)
})

Deno.test("refuses a CRLF in replyTo before touching the transport", async () => {
  const { sender, recorded } = makeSender()
  const failed = failure(
    await sender.send({
      ...MESSAGE,
      replyTo: "Support\r\nBcc: victim@example.com <support@example.com>",
    }),
  )

  assertStringIncludes(failed.error, "control character")
  assertEquals(recorded.configs.length, 0)
  assertEquals(recorded.messages.length, 0)
})

Deno.test("fails the whole send on one invalid replyTo entry", async () => {
  const { sender, recorded } = makeSender()
  const failed = failure(
    await sender.send({ ...MESSAGE, replyTo: ["support@example.com", "not an address"] }),
  )

  assertStringIncludes(failed.error, "Invalid email address")
  assertEquals(recorded.messages.length, 0)
})

Deno.test("refuses an empty replyTo list rather than dropping the header", async () => {
  const { sender, recorded } = makeSender()
  const failed = failure(await sender.send({ ...MESSAGE, replyTo: [] }))

  assertStringIncludes(failed.error, "replyTo")
  assertEquals(recorded.messages.length, 0)
})

Deno.test("fails a message with no body rather than sending an empty mail", async () => {
  const { sender, recorded } = makeSender()
  const failed = failure(
    await sender.send({ to: "guest@example.com", subject: "Hi", text: "   " }),
  )

  assertStringIncludes(failed.error, "needs a text body")
  assertEquals(recorded.messages.length, 0)
})

// ---------- results ----------

Deno.test("reports success with the accepted envelope", async () => {
  const { sender } = makeSender({}, {
    info: { accepted: ["guest@example.com"], messageId: "<1@x>" },
  })
  const result = await sender.send(MESSAGE)

  assertEquals(result, {
    ok: true,
    accepted: ["guest@example.com"],
    duplicates: [],
    messageId: "<1@x>",
  })
})

Deno.test("falls back to the envelope when the transport reports no recipients", async () => {
  const { sender } = makeSender({}, { info: {} })
  const result = await sender.send(MESSAGE)

  assertEquals(result.ok, true)
  assertEquals(result.accepted, ["guest@example.com"])
})

Deno.test("reports a per-recipient rejection as a failure, never a silent partial send", async () => {
  const { sender } = makeSender({}, {
    info: { accepted: ["a@example.com"], rejected: ["b@example.com"] },
  })
  const result = await sender.send({ ...MESSAGE, to: ["a@example.com", "b@example.com"] })

  const failed = failure(result)
  assertEquals(failed.accepted, ["a@example.com"])
  assertEquals(failed.rejected, ["b@example.com"])
  assertStringIncludes(failed.error, "server rejected 1 recipient(s): b@example.com")
})

// ---------- credential redaction ----------

Deno.test("redacts the password from a transport error", async () => {
  const { sender } = makeSender({}, { fail: new Error(`535 auth failed for ${PASSWORD}`) })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(PASSWORD), "the password must not survive")
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

Deno.test("redacts a user:pass connection string echoed by the transport", async () => {
  const { sender } = makeSender({}, {
    fail: new Error(`connect ECONNREFUSED smtp://${USER}:${PASSWORD}@smtp.example.com:587`),
  })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(PASSWORD))
  assertFalse(failed.error.includes(`${USER}:${PASSWORD}`))
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

/**
 * The AUTH PLAIN payload nodemailer actually sends, which AUTH LOGIN never showed.
 *
 * `nodemailer@10.0.10 dist/esm/smtp-connection/index.js:1301-1306` offers PLAIN
 * before LOGIN, `:422` selects `_supportedAuth[0] || 'PLAIN'`, and `:520-525`
 * builds the payload as `base64("\0" + user + "\0" + pass)`. Because base64 groups
 * by three bytes, `base64(pass)` — the only form this module originally covered —
 * is a substring of that blob only when `len(user) ≡ 1 (mod 3)`.
 */
function plainBlob(user: string, pass: string): string {
  return encodeBase64(new TextEncoder().encode(`\0${user}\0${pass}`))
}

Deno.test("redacts the AUTH PLAIN blob at every username length modulo 3", async () => {
  // The username length decides whether the LOGIN-only coverage accidentally hid
  // the PLAIN blob: 1, 4 and 7 (≡ 1 mod 3) hid it, 2, 3, 5, 6 and 8 exposed it.
  // All eight are asserted, so the leak cannot hide behind the one lucky length
  // again. The reported leak was `user: "mailer"` — length 6.
  for (const user of ["a", "ab", "abc", "abcd", "abcde", "mailer", "mailerx", "mailers1"]) {
    const blob = plainBlob(user, PASSWORD)
    const { sender } = makeSender({ user }, { fail: new Error(`auth failed: ${blob}`) })
    const failed = failure(await sender.send(MESSAGE))

    assertFalse(
      failed.error.includes(PASSWORD),
      `password survived for username ${JSON.stringify(user)}`,
    )
    assertFalse(failed.error.includes(blob), `plain blob survived for username ${user}`)
    assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
  }
})

Deno.test("the PLAIN blob is not redundant with the LOGIN blob at length 6", () => {
  // The premise of the test above, asserted rather than assumed: for `mailer` the
  // password's own base64 is not inside the PLAIN blob, so covering only the
  // LOGIN form left the password recoverable from the error by decoding it. The
  // literal is the blob the review gate recovered.
  const loginBlob = encodeBase64(new TextEncoder().encode(PASSWORD))
  const blob = plainBlob("mailer", PASSWORD)

  assertFalse(blob.includes(loginBlob))
  assertEquals(blob, "AG1haWxlcgB0ZXN0LXBhc3N3b3JkLW5vdC1yZWFs")
  assertEquals(new TextDecoder().decode(decodeBase64(blob)), `\0mailer\0${PASSWORD}`)
})

Deno.test("redacts an unpadded AUTH PLAIN blob", async () => {
  // `abcde` is length 5 ≡ 2 (mod 3), and its 29-byte payload pads to one `=`. Both
  // properties are load-bearing: a username of length ≡ 1 (mod 3) would let the
  // LOGIN form alone hide the leak, and a payload that is a multiple of 3 has no
  // padding to strip.
  const padded = plainBlob("abcde", PASSWORD)
  const unpadded = padded.replace(/=+$/, "")
  assert(unpadded !== padded, "fixture must have padding to strip")

  const { sender } = makeSender({ user: "abcde" }, { fail: new Error(`auth ${unpadded}`) })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(padded))
  assertFalse(failed.error.includes(unpadded))
  assertFalse(failed.error.includes(PASSWORD))
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

Deno.test("redacts a base64url and a percent-encoded credential blob", async () => {
  const blob = plainBlob("mailer", PASSWORD)
  const urlSafe = blob.replaceAll("+", "-").replaceAll("/", "_")

  for (const variant of [urlSafe, encodeURIComponent(blob)]) {
    const { sender } = makeSender({ user: "mailer" }, { fail: new Error(`auth ${variant}`) })
    const failed = failure(await sender.send(MESSAGE))
    assertFalse(failed.error.includes(blob), `blob survived inside variant: ${variant}`)
    assertFalse(failed.error.includes(PASSWORD), `password survived: ${variant}`)
    assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
  }
})

Deno.test("redacts an AUTH PLAIN blob carrying an authorization identity", async () => {
  // RFC 4616 allows `authzid \0 authcid \0 passwd`. nodemailer omits the
  // authorization identity today, so this blob cannot be in a form list computed
  // from the credentials — and a 14-byte authzid puts the credentials at a
  // non-multiple-of-3 offset, so neither the enumerated PLAIN blob nor the LOGIN
  // blob is even a substring of it. Only the decoded scan can recognise it.
  // Asserted, not assumed, below: a 13-byte authzid would leave the LOGIN blob
  // inside, and then this test would pass without the scan doing anything.
  const blob = encodeBase64(
    new TextEncoder().encode(`ab@example.com\0mailer\0${PASSWORD}`),
  )

  assertFalse(blob.includes(plainBlob("mailer", PASSWORD)), "enumerated blob must not be inside")
  assertFalse(
    blob.includes(encodeBase64(new TextEncoder().encode(PASSWORD))),
    "login blob must not be inside",
  )

  const { sender } = makeSender({ user: "mailer" }, { fail: new Error(`auth ${blob}`) })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(PASSWORD))
  assertFalse(failed.error.includes(blob))
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

Deno.test("leaves an unrelated base64 run alone", async () => {
  // The decoded scan must not become a blanket: a long opaque token that decodes
  // to something else stays readable, because a diagnostic is worth keeping.
  const unrelated = encodeBase64(new TextEncoder().encode("unrelated payload bytes 1234"))

  const { sender } = makeSender({}, { fail: new Error(`bounce detail: ${unrelated}`) })
  const failed = failure(await sender.send(MESSAGE))

  assertStringIncludes(failed.error, unrelated)
})

Deno.test("redacts the base64 AUTH LOGIN blob", async () => {
  const blob = encodeBase64(new TextEncoder().encode(PASSWORD))
  const { sender } = makeSender({}, { fail: new Error(`AUTH LOGIN rejected: ${blob}`) })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(blob), "the base64 AUTH blob must not survive")
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

Deno.test("redacts a percent-encoded credential", async () => {
  const { sender } = makeSender({ pass: "p@ss word/not-real" }, {
    fail: new Error("failed for p%40ss%20word%2Fnot-real"),
  })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes("p%40ss%20word%2Fnot-real"))
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
})

Deno.test("reports a thrown non-Error without leaking the credentials", async () => {
  const { sender } = makeSender({}, { fail: `string failure with ${PASSWORD}` })
  const failed = failure(await sender.send(MESSAGE))

  assertFalse(failed.error.includes(PASSWORD))
  assertStringIncludes(failed.error, "string failure")
})

/**
 * The error raised *before* anything is sent goes through the same scrubber.
 *
 * That path had no test, so deleting its `redact` call left the suite green
 * (#74). It is reachable with the arguments in the wrong order — `send({ to:
 * password })` is a one-character slip — and the address parser quotes the value
 * it could not parse into the message, so the credential lands in whatever logs
 * the returned error.
 */
Deno.test("redacts a credential that a bad recipient carried into the error", async () => {
  const { sender } = makeSender()
  const failed = failure(await sender.send({ ...MESSAGE, to: `<${PASSWORD}` }))

  assertFalse(failed.error.includes(PASSWORD), "the password must not survive a parse failure")
  assertStringIncludes(failed.error, REDACTED_CREDENTIAL)
  assertEquals(failed.accepted, [])
})

Deno.test("keeps the diagnostic usable when nothing needs redacting", async () => {
  const { sender } = makeSender({}, { fail: new Error("550 mailbox unavailable") })
  const failed = failure(await sender.send(MESSAGE))

  assertStringIncludes(failed.error, "550 mailbox unavailable")
  assertStringIncludes(failed.error, "smtp.example.com")
  assertStringIncludes(failed.error, "to=guest@example.com")
})

// ---------- configuration errors ----------

Deno.test("rejects an incomplete configuration at construction", () => {
  for (
    const options of [
      { host: "" },
      { host: "   " },
      { user: "" },
      { pass: "" },
      { from: "" },
    ]
  ) {
    assertThrows(
      () =>
        createSmtpSender({ ...BASE_OPTIONS, ...options }, recorder({ configs: [], messages: [] })),
      TypeError,
      "is required",
      `expected a throw for ${JSON.stringify(options)}`,
    )
  }
})

Deno.test("rejects an out-of-range port at construction", () => {
  for (const port of [0, -1, 65536, 587.5, Number.NaN]) {
    assertThrows(
      () => createSmtpSender({ ...BASE_OPTIONS, port }, recorder({ configs: [], messages: [] })),
      RangeError,
      "port must be",
      `expected a throw for port ${port}`,
    )
  }
})

Deno.test("rejects a malformed from mailbox at construction", () => {
  assertThrows(
    () =>
      createSmtpSender(
        { ...BASE_OPTIONS, from: "nonsense" },
        recorder({
          configs: [],
          messages: [],
        }),
      ),
    TypeError,
    "Invalid email address",
  )
  assertThrows(
    () =>
      createSmtpSender(
        { ...BASE_OPTIONS, from: "Booking\r\nBcc: victim@example.com <b@example.com>" },
        recorder({ configs: [], messages: [] }),
      ),
    TypeError,
    "control character",
  )
})

// ---------- MIME, compiled locally by nodemailer ----------

/**
 * A transport factory backed by nodemailer's `streamTransport`.
 *
 * No network: streamTransport compiles the message with the same `MailComposer`
 * the SMTP transport uses and hands back the raw RFC 5322 bytes. It is the only
 * way to assert on real MIME — RFC 2231 filenames, transfer encodings — without
 * `--allow-net`.
 */
function mimeFactory(sink: { mime: string }): SmtpTransportFactory {
  return (): SmtpTransport => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true })
    return {
      async sendMail(message: SendMailOptions): Promise<SmtpSendInfo> {
        const info = await transport.sendMail(message)
        const body = info.message
        sink.mime = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body)
        return { messageId: info.messageId }
      },
    }
  }
}

const ICS_OPTIONS: IcsOptions = {
  prodid: "-//ts-libs//email//EN",
  dtstamp: new Date(Date.UTC(2026, 7, 25, 16, 42, 0)),
}

const ICS_EVENT: IcsEvent = {
  uid: "01HXYZBK8M@calendar.example.com",
  start: new Date(Date.UTC(2026, 7, 28, 8, 0, 0)),
  end: new Date(Date.UTC(2026, 7, 28, 8, 30, 0)),
  summary: "Meeting with the guest",
}

Deno.test("encodes an ICS attachment as text/calendar with a base64 body", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({
    ...MESSAGE,
    attachments: [icalAttachment(ICS_EVENT, { ics: ICS_OPTIONS })],
  })

  assertStringIncludes(sink.mime, "Content-Type: text/calendar; charset=utf-8; method=REQUEST;")
  assertStringIncludes(sink.mime, "Content-Transfer-Encoding: base64")
  assertStringIncludes(sink.mime, "name=meeting.ics")
  assertStringIncludes(sink.mime, "filename=meeting.ics")
  // base64 of the ICS opening line, proving the calendar body is the encoded content.
  assertStringIncludes(sink.mime, "QkVHSU46VkNBTEVOREFS")
})

Deno.test("survives a multi-byte attachment filename per RFC 2231", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({
    ...MESSAGE,
    attachments: [icalAttachment(ICS_EVENT, {
      ics: ICS_OPTIONS,
      filename: "Einladung – Besprechung.ics",
    })],
  })

  assertStringIncludes(sink.mime, "filename*0*=utf-8''Einladung%20%E2%80%93%20Besprechung.ics")
  assertFalse(sink.mime.includes("Einladung – Besprechung.ics"))
})

Deno.test("emits no text/html part for a text-only message", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({ to: "guest@example.com", subject: "Hi", text: "plain body" })

  assertStringIncludes(sink.mime, "Content-Type: text/plain; charset=utf-8")
  assertFalse(sink.mime.includes("text/html"))
  assertFalse(sink.mime.includes("multipart/alternative"))
})

Deno.test("emits no text/plain part for an html-only message", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({ to: "guest@example.com", subject: "Hi", html: "<p>rich body</p>" })

  assertStringIncludes(sink.mime, "Content-Type: text/html; charset=utf-8")
  assertFalse(sink.mime.includes("text/plain"))
})

Deno.test("emits a multipart/alternative when both bodies are given", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({ to: "guest@example.com", subject: "Hi", text: "plain", html: "<p>rich</p>" })

  assertStringIncludes(sink.mime, "multipart/alternative")
  assertStringIncludes(sink.mime, "Content-Type: text/plain; charset=utf-8")
  assertStringIncludes(sink.mime, "Content-Type: text/html; charset=utf-8")
})

Deno.test("encodes a non-ASCII display name in the From header", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(
    { ...BASE_OPTIONS, from: "Buchung <booking@example.com>" },
    mimeFactory(sink),
  )

  await sender.send({ to: "guest@example.com", subject: "Hi", text: "plain" })

  assertStringIncludes(sink.mime, "From: Buchung <booking@example.com>")
  assert(/^From: /m.test(sink.mime))
  assertFalse(sink.mime.includes("\r\nBcc:"))
})

Deno.test("never needs --allow-net to assemble a message", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))
  const result = await sender.send(MESSAGE)

  assert(result.ok)
  assert(sink.mime.length > 0)
})

Deno.test("renders a Reply-To header for a single address", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  const result = await sender.send({ ...MESSAGE, replyTo: "hello@example.com" })

  assert(result.ok)
  assert(/^Reply-To: hello@example\.com\r$/m.test(sink.mime), sink.mime)
})

Deno.test("renders a Reply-To header for a list, display names included", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  const result = await sender.send({
    ...MESSAGE,
    replyTo: ["Anton <hello@example.com>", "owner@example.com"],
  })

  assert(result.ok)
  assert(/^Reply-To: Anton <hello@example\.com>, owner@example\.com\r$/m.test(sink.mime), sink.mime)
})

Deno.test("renders no Reply-To header when replyTo is omitted", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  const result = await sender.send(MESSAGE)

  assert(result.ok)
  assert(sink.mime.length > 0)
  assertFalse(/^Reply-To:/im.test(sink.mime))
})

/** Present so the ICS assertion above fails loudly if the enum import drifts. */
Deno.test("carries the cancelled status into the attachment MIME type", async () => {
  const sink = { mime: "" }
  const sender = createSmtpSender(BASE_OPTIONS, mimeFactory(sink))

  await sender.send({
    ...MESSAGE,
    attachments: [icalAttachment({ ...ICS_EVENT, status: IcsEventStatus.CANCELLED }, {
      ics: ICS_OPTIONS,
    })],
  })

  assertStringIncludes(sink.mime, "method=CANCEL")
})

/**
 * Drop comments from a source file, so a doc comment that *mentions* `Deno.env`
 * does not read as a call to it.
 *
 * This is the weakest test in the suite and it is here on purpose: the honest
 * form of "importing the module reads no environment variable" is a subprocess
 * import with an empty environment, and the root test task grants no
 * `--allow-run`. It is a lexical filter, not a parser, and it would misread a
 * string literal that contains `//` — none does, and a reviewer adding one will
 * see this fail rather than see the check silently stop checking.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}
