/**
 * The SMTP smoke test of the integration tier (#74).
 *
 * The audit's line about this adapter was "no real SMTP or STARTTLS exchange has
 * ever run on Deno": `email/smtp.test.ts` injects a transport factory and never
 * opens a socket. This test runs the real nodemailer transport against Mailpit —
 * greeting, EHLO, AUTH, MAIL FROM, RCPT TO, DATA — and reads the delivered message
 * back over Mailpit's HTTP API.
 *
 * One honest gap remains: Mailpit serves no STARTTLS without a certificate, so this
 * test passes `requireTls: false` and the upgrade path is still untested. That is a
 * limitation of the sink, not of the adapter, and it is recorded here rather than
 * papered over.
 *
 * Isolation: the recipient carries a random suffix in the reserved `.test` domain,
 * the message is found by searching for that address, and it is deleted in a
 * `finally`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert"
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
    assertEquals(result.accepted, [recipient])

    const delivered = await waitForMail(mailpit, recipient)
    try {
      assertEquals(delivered.Subject, subject)
      assertEquals(delivered.To.map((address) => address.Address), [recipient])
      assertStringIncludes(delivered.Text, body)
    } finally {
      await deleteMail(mailpit, [delivered.ID])
    }
  })
})
