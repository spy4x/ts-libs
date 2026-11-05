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
 *
 * ```ts
 * interface EmailSender {
 *   send(message: EmailMessage): Promise<SendResult>
 * }
 * ```
 *
 * - **`send` never throws for a message-shaped problem.** A bad recipient, an empty
 *   recipient list, a missing body and a header-injecting subject all come back as a
 *   failed `SendResult` carrying the reason, before any transport is touched.
 * - **Constructing a sender throws on a bad configuration** — an empty `host`,
 *   `pass` or `from`, an out-of-range port, a malformed `from` mailbox. A
 *   configuration error is a deploy-time bug, not a per-message outcome.
 * - **A partial send is never success.** If the server refuses one of three
 *   recipients, the result is `ok: false` with `accepted` and `rejected` listed, so
 *   the caller can see exactly who got the mail.
 * - **Recipient syntax is all-or-nothing.** One unparsable entry fails the whole
 *   message; the valid subset is never mailed quietly.
 * - **Duplicates are deduplicated** case-insensitively before sending and reported
 *   in `duplicates`.
 * - **`replyTo` is optional and validated exactly like `to`.** Both are parsed by the
 *   same function, so a display name is accepted and sent as a structured mailbox, a
 *   control character is refused, and one bad entry fails the whole message. The
 *   error names the field (`replyTo: …` or `to: …`). A string or a list renders as one
 *   `Reply-To` header; an empty list is refused (omit the field instead), and an
 *   omitted `replyTo` renders no header. Check a visitor-supplied address with
 *   `parseAddress` first and leave it out when that throws, so a typo in a contact
 *   form costs the reply route rather than the whole mail.
 * - **`listUnsubscribe` adds the mailing-list headers.** `{ url, mailto?, oneClick? }`
 *   sends `List-Unsubscribe: <url>, <mailto:…>` and, with `oneClick: true`,
 *   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so Gmail and Apple
 *   Mail show their own Unsubscribe button. `url` must be absolute `https:` and `mailto`
 *   a bare address; a control character, whitespace, `<` or `>` in either, or `oneClick`
 *   without `url`, fails the message with an error starting `listUnsubscribe:`. The
 *   mail server's DKIM signature must cover `List-Unsubscribe` and `List-Unsubscribe-Post`,
 *   or a forwarder can swap the link.
 * - **Credentials are redacted.** Every string that leaves through `error` has the
 *   password, the `user:pass` pair and every base64 SASL blob they can form replaced
 *   with `<REDACTED:CREDENTIAL>`. That is not a fixed list of encodings: after the
 *   exact forms are replaced, every base64-like run in the message is decoded —
 *   padding restored, base64url normalized, percent-encoding undone — and replaced
 *   when it obviously contains the credentials. The AUTH **PLAIN** payload is
 *   `base64("\0" + user + "\0" + pass)`, which nodemailer prefers over LOGIN, and it
 *   is the case a LOGIN-only form list misses: `base64(pass)` sits inside it only
 *   when `len(user) ≡ 1 (mod 3)`.
 * - **Attachments cannot read files or fetch URLs.** The transport is configured
 *   with nodemailer's `disableFileAccess` and `disableUrlAccess`, so an attachment
 *   carrying a `path` or an `href` is refused rather than read — the caller's option
 *   object cannot reach either.
 *
 * @module
 */

import { type MessageAddresses, parseMessageAddresses } from "./message-addresses.ts"
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
 * It logs the envelope, the subject, an attachment count and a body preview, never
 * the whole message, so bodies and recipients stay out of the log, and has no
 * credential in scope to log.
 */
export function createConsoleSender(options: ConsoleSenderOptions = {}): EmailSender {
  const log = options.log ?? ((line: string) => console.log(line))
  const previewChars = options.previewChars ?? 500

  return {
    send(message: EmailMessage): Promise<SendResult> {
      let parsed: MessageAddresses
      try {
        assertSendableMessage(message)
        parsed = parseMessageAddresses(message)
      } catch (error) {
        return Promise.resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          accepted: [],
          rejected: [],
          duplicates: [],
        })
      }

      const { recipients, replyTo } = parsed
      const addresses = recipients.addresses.map((address) => address.address)
      const body = message.text ?? stripTags(message.html ?? "")

      const replyToPart = replyTo === undefined
        ? ""
        : ` replyTo=${replyTo.addresses.map((address) => address.address).join(",")}`

      log(
        `[email:console] to=${addresses.join(",")}${replyToPart} ` +
          `subject=${JSON.stringify(message.subject)} ` +
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
