/**
 * The `EmailSender` port and the dev adapter that satisfies it.
 *
 * The port is the reason the nodemailer choice stays reversible: it mentions
 * nothing from nodemailer, so a Deno-native SMTP client, an SES adapter or a
 * fan-out decorator can be swapped in without touching a caller. Everything that
 * names a vendor lives on the other side of this interface, in `smtp.ts`.
 *
 * The result contract, which is a decision rather than a detail:
 *
 * - `send` never throws for a bad message. An unparsable recipient, an empty
 *   recipient list or a missing body comes back as a failed {@link SendResult}
 *   carrying the reason, before any transport is touched. A thrown exception from
 *   `send` would be indistinguishable from a transport failure at the call site.
 * - A partial send is never reported as success. A server that rejects one of
 *   three recipients yields `ok: false` with `accepted` and `rejected` listed, so
 *   the caller can see exactly who got the mail. A silent partial send is the
 *   failure mode this contract exists to prevent.
 * - Constructing a sender throws on a bad configuration, because that is a
 *   deploy-time bug, not a per-message outcome.
 */

import { parseAddresses, type ParsedRecipients } from "./address.ts"
import { assertSendableMessage, type EmailMessage } from "./message.ts"

/** Every recipient the transport saw was accepted by the server. */
export interface SendSuccess {
  ok: true
  /** Recipients the server accepted, as the transport reported them. */
  accepted: string[]
  /** Recipients dropped as duplicates before sending. */
  duplicates: string[]
  /** Transport message id, when the transport reports one. */
  messageId?: string
}

/** No mail was sent, or some recipient was refused. Never carries a credential. */
export interface SendFailure {
  ok: false
  /**
   * Human-readable cause. Credential-redacted by the SMTP transport: a password,
   * a `user:pass` pair and their base64 AUTH-LOGIN encodings are replaced with
   * `<REDACTED:CREDENTIAL>` before the string reaches this field.
   */
  error: string
  /** Recipients the server accepted. Empty for a pre-send failure. */
  accepted: string[]
  /** Recipients the server refused. Empty for a pre-send failure. */
  rejected: string[]
  /** Recipients dropped as duplicates before sending. */
  duplicates: string[]
}

/** Outcome of one send attempt. */
export type SendResult = SendSuccess | SendFailure

/** The port every transport implements, and the only thing callers depend on. */
export interface EmailSender {
  /** Attempt to deliver one message. Resolves; never rejects for a message-shaped problem. */
  send(message: EmailMessage): Promise<SendResult>
}

/** Where the dev adapter writes and how much of the body it keeps. */
export interface ConsoleSenderOptions {
  /**
   * Sink for the rendered line. Defaults to `console.log`; inject it in a test or
   * a local script that captures output somewhere else.
   */
  log?: (line: string) => void
  /** Body characters kept in the preview. Defaults to 500. */
  previewChars?: number
}

/**
 * A sender that logs instead of sending, for local runs and for tests that need a
 * port implementation without a mail server.
 *
 * Ported from `roley`'s dev branch (`console.log` of the send command), with the
 * part `roley` got wrong left behind: `roley` logged the *command object*, which
 * on a real transport carries the credentials. This one logs the envelope, the
 * subject and a body preview, and has no credential in scope to log.
 */
export function createConsoleSender(options: ConsoleSenderOptions = {}): EmailSender {
  const log = options.log ?? ((line: string) => console.log(line))
  const previewChars = options.previewChars ?? 500

  return {
    send(message: EmailMessage): Promise<SendResult> {
      let recipients: ParsedRecipients
      try {
        assertSendableMessage(message)
        recipients = parseAddresses(message.to)
      } catch (error) {
        return Promise.resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          accepted: [],
          rejected: [],
          duplicates: [],
        })
      }

      const addresses = recipients.addresses.map((address) => address.address)
      const body = message.text ?? stripTags(message.html ?? "")

      log(
        `[email:console] to=${addresses.join(",")} subject=${JSON.stringify(message.subject)} ` +
          `text=${body.length}B attachments=${message.attachments?.length ?? 0}`,
      )
      log(preview(body, previewChars))

      return Promise.resolve({
        ok: true,
        accepted: addresses,
        duplicates: recipients.duplicates,
      })
    },
  }
}

/** Truncate a body for logging, marking that it was cut. */
function preview(body: string, limit: number): string {
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}… (${body.length - limit} more characters)`
}

/**
 * A crude tag strip, for the log preview of an HTML-only message.
 *
 * Deliberately not `escapeHtml`'s inverse and not a parser: the preview is for a
 * human reading a terminal, and a value that survives a regex here is not
 * rendered anywhere. The alternative — printing raw HTML — buries the log line
 * that matters under a stylesheet.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}
