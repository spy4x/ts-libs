/**
 * Barrel entry point for `@ts-libs/email`: the whole public surface, both halves.
 *
 * Created at merge time. Neither feature branch owned `"."` — the SMTP branch
 * shipped five subpaths and no root entry, and the DKIM branch's `"."` pointed at
 * `./dkim-verify.ts`, which privileged one half of a package that now has two.
 * The root entry belongs to the union, not to either side.
 *
 * The four `Send*` names are re-exported from `./sender.ts` only. `./smtp.ts`
 * re-exports them too, so naming both origins here would be a duplicate export.
 */

export {
  assertNoControlCharacters,
  type EmailAddress,
  formatAddress,
  isAddress,
  parseAddress,
  parseAddresses,
  type ParsedRecipients,
} from "./address.ts"

export { escapeHtml, type HtmlShellOptions, htmlWrap } from "./html.ts"

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
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  type DkimAlgorithm,
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
  sha256Base64,
  splitMessage,
  verifyDkim,
  verifyDkimSignatures,
} from "./dkim-verify.ts"
