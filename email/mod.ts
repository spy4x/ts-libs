/**
 * Barrel entry point for `@spy4x/email`: the whole public surface, both halves.
 *
 * Created at merge time. Neither feature branch owned `"."` — the SMTP branch
 * shipped five subpaths and no root entry, and the DKIM branch's `"."` pointed at
 * `./dkim-verify.ts`, which privileged one half of a package that now has two.
 * The root entry belongs to the union, not to either side.
 *
 * The four `Send*` names are re-exported from `./sender.ts` only. `./smtp.ts`
 * re-exports them too, so naming both origins here would be a duplicate export.
 *
 * ```ts
 * import { createSmtpSender } from "@spy4x/email/smtp"
 * import { escapeHtml, htmlWrap } from "@spy4x/email/html"
 *
 * const sender = createSmtpSender({
 *   host: "smtp.example.com",
 *   port: 587,
 *   user: "user@example.com",
 *   pass: "test-password-not-real",
 *   from: "Booking <booking@example.com>",
 * })
 *
 * const html = htmlWrap({
 *   brand: "Booking",
 *   brandUrl: "https://book.example.com",
 *   body: `<p>Hi ${escapeHtml(guestName)},</p>`,
 * })
 *
 * const result = await sender.send({
 *   to: ["guest@example.com", "host@example.com"],
 *   subject: "Booking confirmed",
 *   text: "Your meeting is booked.",
 *   html,
 * })
 *
 * if (!result.ok) console.error(result.error, result.rejected)
 * ```
 *
 * ## Out of scope
 *
 * - **Templates.** Guest/owner confirmation pairs, booking copy, cancellation
 *   wording and every other domain string stay in the application. This package owns
 *   the transport, the escaping, the HTML shell, timezone framing and ICS
 *   attachment plumbing; it does not own your words.
 * - **An SES adapter.** The internal source's would drag in `@aws-sdk/client-sesv2`. The port
 *   makes one a small `fetch` against the SES API when a caller needs it; until
 *   then it is unbuilt surface.
 * - **Binary attachments.** `EmailAttachment.content` is UTF-8 text, which is what
 *   an ICS file and a rendered HTML part need. A `Uint8Array` variant is the change
 *   to make when a caller needs one.
 * - **Inbound mail.** Receiving mail is not planned; DKIM verification lives in the
 *   `./dkim-verify` subpath of this package, not here.
 *
 * @module
 */

export {
  assertNoControlCharacters,
  type EmailAddress,
  formatAddress,
  isAddress,
  isExampleAddress,
  parseAddress,
  parseAddresses,
  type ParsedRecipients,
} from "./address.ts"

export {
  DARK_HTML_SHELL_THEME,
  DEFAULT_HTML_SHELL_THEME,
  emailButton,
  type EmailButtonOptions,
  escapeHtml,
  type HtmlShellOptions,
  type HtmlShellTheme,
  htmlWrap,
} from "./html.ts"

export {
  assertSendableMessage,
  type EmailAttachment,
  type EmailMessage,
  frameInstantLong,
  frameInstantShort,
  frameWallClockLong,
  frameWallClockShort,
  hasBody,
  icalAttachment,
  type IcalAttachmentOptions,
  type ListUnsubscribe,
} from "./message.ts"

export {
  type ConsoleSenderOptions,
  createConsoleSender,
  type EmailSender,
  type SendFailure,
  type SendResult,
  type SendSuccess,
} from "./sender.ts"

export {
  createSmtpSender,
  REDACTED_CREDENTIAL,
  type SmtpOptions,
  type SmtpSendInfo,
  type SmtpTransport,
  type SmtpTransportFactory,
} from "./smtp.ts"

export {
  type Canonicalization,
  canonicalizeBody,
  canonicalizeHeader,
  DEFAULT_MAX_HEADER_FIELDS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DEFAULT_MAX_SIGNED_HEADER_NAMES,
  type DkimAlgorithm,
  type DkimBodyCoverage,
  type DkimKeyAlgorithm,
  DkimParseError,
  type DkimPublicKey,
  type DkimSignatureHeader,
  type DkimVerificationResult,
  type DkimVerifyOptions,
  type DnsTxtResolver,
  fetchDkimPublicKey,
  MIN_RSA_KEY_BITS,
  parseDkimPublicKey,
  parseDkimSignature,
  refuseHeaderLineEndings,
  sha256Base64,
  splitMessage,
  TRANSIT_ADDED_HEADER_NAMES,
  verifyDkim,
  verifyDkimSignatures,
} from "./dkim-verify.ts"
