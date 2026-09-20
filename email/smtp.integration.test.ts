/**
 * The SMTP adapter against a real mail server (#74).
 *
 * The audit's line about this adapter was "no real SMTP or STARTTLS exchange has
 * ever run on Deno": `email/smtp.test.ts` injects a transport factory and never
 * opens a socket. These tests run the real nodemailer transport against Mailpit —
 * greeting, EHLO, AUTH, MAIL FROM, RCPT TO, DATA — and read the delivered message
 * back over Mailpit's HTTP API, so what is asserted is what a mail server received
 * rather than what an object looked like on the way out.
 *
 * One honest gap remains: Mailpit serves no STARTTLS without a certificate, so
 * every test here passes `requireTls: false` and the upgrade path is still
 * untested. That is a limitation of the sink, not of the adapter, and it is
 * recorded here rather than papered over. `email/smtp.test.ts` still covers the
 * configuration side of it — that `requireTLS` is set unless a caller turns it
 * off — which is the part that can be checked without a certificate.
 *
 * Isolation: every recipient carries a random suffix in the reserved `.test`
 * domain, each message is found by searching for that address, and it is deleted
 * in a `finally` — including when an assertion fails, so a failed run leaves the
 * shared mailbox as it found it.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  deleteMail,
  mailpitSettings,
  requireReachable,
  RESERVED_EMAIL_DOMAIN,
  smtpSettings,
  uniqueRecipient,
  uniqueSuffix,
  waitForMail,
} from "@integration-testing"
import { createSmtpSender } from "./smtp.ts"

/** The password the adapter is configured with; no error may ever carry it. */
const SENDER_PASSWORD = "integration-test-only"

describe("smtp transport against a real mail server", () => {
  it("delivers a message the server hands back with the same subject and body", async () => {
    const smtp = smtpSettings()
    const mailpit = mailpitSettings()
    await requireReachable(smtp.address)
    await requireReachable(mailpit.address)

    const recipient = uniqueRecipient("smtp")
    const subject = `ts-libs integration ${uniqueSuffix()}`
    const body = "Sent over a real socket by the integration tier."
    const sender = createSmtpSender({
      host: smtp.host,
      port: smtp.port,
      user: smtp.user,
      pass: smtp.pass,
      from: `ts-libs <no-reply@${RESERVED_EMAIL_DOMAIN}>`,
      requireTls: false,
    })

    const result = await sender.send({ to: recipient, subject, text: body })
    if (!result.ok) throw new Error(`SMTP send failed: ${result.error}`)

    const delivered = await waitForMail(mailpit, recipient)
    try {
      // Everything the send reported is asserted in here as well, so a failure
      // still reaches the cleanup below instead of leaving the message behind.
      assertEquals(result.accepted, [recipient])
      assertEquals(delivered.Subject, subject)
      assertEquals(delivered.To.map((address) => address.Address), [recipient])
      assertStringIncludes(delivered.Text, body)
    } finally {
      await deleteMail(mailpit, [delivered.ID])
    }
  })

  it("delivers a non-ASCII subject, several recipients and both body parts", async () => {
    // The three things a caller would notice going wrong on the wire: a subject
    // that needs RFC 2047 encoding coming back mangled, a second recipient
    // disappearing from the envelope, and a multipart/alternative message losing
    // one of its halves. None of them can be seen from the options object the
    // unit tests assert on.
    const smtp = smtpSettings()
    const mailpit = mailpitSettings()
    await requireReachable(smtp.address)
    await requireReachable(mailpit.address)

    const first = uniqueRecipient("smtp-multi")
    const second = uniqueRecipient("smtp-multi")
    const subject = `Réservation confirmée — 会議 ${uniqueSuffix()}`
    const text = "Your meeting is booked. Ihre Besprechung ist gebucht."
    const html = `<p>Your meeting is <strong>booked</strong>. 会議は予約されました。</p>`
    const sender = createSmtpSender({
      host: smtp.host,
      port: smtp.port,
      user: smtp.user,
      pass: smtp.pass,
      from: `ts-libs Bökung <no-reply@${RESERVED_EMAIL_DOMAIN}>`,
      requireTls: false,
    })

    const result = await sender.send({ to: [first, second], subject, text, html })
    if (!result.ok) throw new Error(`SMTP send failed: ${result.error}`)

    const delivered = await waitForMail(mailpit, first)
    try {
      assertEquals(result.accepted, [first, second])
      // Mailpit decodes the header it received, so an equal subject means the
      // encoding round-tripped rather than being avoided.
      assertEquals(delivered.Subject, subject)
      assertEquals(delivered.To.map((address) => address.Address).sort(), [first, second].sort())
      assertEquals(delivered.From?.Name, "ts-libs Bökung")
      assertEquals(delivered.From?.Address, `no-reply@${RESERVED_EMAIL_DOMAIN}`)
      assertStringIncludes(delivered.Text, "Ihre Besprechung ist gebucht.")
      assertStringIncludes(delivered.HTML, "<strong>booked</strong>")
      assertStringIncludes(delivered.HTML, "会議は予約されました。")
    } finally {
      await deleteMail(mailpit, [delivered.ID])
    }
  })

  it("reports a refused connection instead of hanging", async () => {
    // A port nobody is listening on, chosen by binding one and closing it again,
    // so the test cannot collide with a service that happens to be running. The
    // send has to come back as a failure: the whole point of the port returning a
    // SendResult rather than throwing is that a caller can log it and move on.
    const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 })
    const port = closed.addr as Deno.NetAddr
    closed.close()

    const sender = createSmtpSender({
      host: "127.0.0.1",
      port: port.port,
      user: "integration-test-only",
      pass: SENDER_PASSWORD,
      from: `ts-libs <no-reply@${RESERVED_EMAIL_DOMAIN}>`,
      requireTls: false,
      connectionTimeoutMs: 5_000,
    })

    const result = await sender.send({
      to: uniqueRecipient("smtp-refused"),
      subject: "never delivered",
      text: "never delivered",
    })

    assertFalse(result.ok, "a closed port must not report a successful send")
    if (result.ok) return
    assertStringIncludes(result.error, "SMTP send failed")
    assertStringIncludes(result.error, "127.0.0.1")
    assertEquals(result.accepted, [])
    // The real transport's error text has never been scrubbed by a test before.
    assertFalse(
      result.error.includes(SENDER_PASSWORD),
      `the password must not reach the error: ${result.error}`,
    )
  })

  it("gives up on a server that never answers instead of hanging", async () => {
    // 192.0.2.1 is RFC 5737 documentation space: nothing routes there, so the
    // connection either is refused by the local stack or never completes.
    // `connectionTimeoutMs` is what turns the second case into a result, and this
    // is the only test that runs it against a real socket.
    const sender = createSmtpSender({
      host: "192.0.2.1",
      port: 25,
      user: "integration-test-only",
      pass: SENDER_PASSWORD,
      from: `ts-libs <no-reply@${RESERVED_EMAIL_DOMAIN}>`,
      requireTls: false,
      connectionTimeoutMs: 1_500,
      greetingTimeoutMs: 1_500,
    })

    const result = await sender.send({
      to: uniqueRecipient("smtp-blackhole"),
      subject: "never delivered",
      text: "never delivered",
    })

    assertFalse(result.ok, "an unreachable host must not report a successful send")
    if (result.ok) return
    assertStringIncludes(result.error, "192.0.2.1")
    assert(result.error.length > 0, "the failure must say something")
    assertFalse(result.error.includes(SENDER_PASSWORD))
  })
})
