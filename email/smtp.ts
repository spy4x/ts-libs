/**
 * The SMTP adapter: `npm:nodemailer` behind the {@link EmailSender} port.
 *
 * Why nodemailer rather than a hand-rolled client is recorded in the README and
 * the PR body; the short version is the repo's dependency policy ("own the small,
 * keep the huge … also an SMTP lib") and that SMTP is a tarpit: EHLO capability
 * parsing, SASL mechanism selection, STARTTLS with a downgrade-resistant upgrade,
 * MAIL FROM/RCPT TO per-recipient status, MIME assembly, RFC 2047 header encoding
 * and RFC 2231 filename encoding. `antonshubin.com` hand-rolls four of those badly
 * in three places, and none of that code came across.
 *
 * Three port-time decisions worth reading before changing anything here:
 *
 * 1. **Nothing is created at module scope.** No `Deno.env`, no transporter, no
 *    connection. A transport belongs to the sender that was constructed from a
 *    configuration, it is built on the first send and memoised *in that sender's
 *    closure*, and two senders never share one. `mig` cached a single module-level
 *    `transporter` keyed to nothing, which made a second configuration silently
 *    reuse the first one's connection and made every test order-dependent.
 * 2. **nodemailer is imported lazily**, on the first send through the default
 *    factory. Its ESM entry reads `process.env.ETHEREAL_API` while loading, so a
 *    static import would make the bare import of this module require `--allow-env`.
 *    With the dynamic import, a caller that injects a factory never loads it, and
 *    nothing here reads the environment.
 * 3. **Credentials are redacted, not just unlogged.** `debug` and `logger` are
 *    never set — nodemailer's `debug` passes the whole SMTP conversation,
 *    AUTH exchange included, to the logger — and every string that leaves this
 *    module through `error` is scrubbed of the password, the `user:pass` pair,
 *    and their base64 AUTH-LOGIN encodings.
 */

import type { SendMailOptions, SMTPTransportOptions } from "nodemailer"
import { encodeBase64 } from "@std/encoding"
import {
  type EmailAddress,
  parseAddress,
  parseAddresses,
  type ParsedRecipients,
} from "./address.ts"
import { assertSendableMessage, type EmailMessage, hasBody } from "./message.ts"
import type { EmailSender, SendResult } from "./sender.ts"

export type { EmailSender, SendFailure, SendResult, SendSuccess } from "./sender.ts"

/** Placeholder that replaces a credential in any string this module reports. */
export const REDACTED_CREDENTIAL = "<REDACTED:CREDENTIAL>"

/** Connection settings. Explicit by design: this library never reads the environment. */
export interface SmtpOptions {
  /** Relay hostname, e.g. `smtp.example.com`. */
  host: string
  /** Relay port. `465` selects implicit TLS; every other port starts in the clear. */
  port: number
  /** SMTP AUTH username. */
  user: string
  /** SMTP AUTH password. Never logged, never returned in a result. */
  pass: string
  /** `From` mailbox: a bare address, or `Name <addr>` / `"Name" <addr>` for a display name. */
  from: string
  /**
   * Implicit TLS. Defaults to `true` for port 465 and `false` otherwise, which is
   * the only port where implicit TLS is deployed. Set it explicitly for a relay on
   * a non-standard implicit-TLS port.
   */
  secure?: boolean
  /**
   * Require STARTTLS on a non-implicit-TLS connection. Defaults to `true`.
   *
   * This is a deliberate departure from `mig`, which used nodemailer's default
   * opportunistic upgrade: an opportunistic STARTTLS is stripped by any on-path
   * attacker, who then reads the AUTH exchange. A relay that genuinely cannot do
   * STARTTLS needs `requireTls: false` and an explicit decision to send in the
   * clear.
   */
  requireTls?: boolean
  /** Name announced in EHLO. Defaults to nodemailer's. */
  name?: string
  /** Milliseconds before the TCP connect is abandoned. */
  connectionTimeoutMs?: number
  /** Milliseconds to wait for the server greeting. */
  greetingTimeoutMs?: number
  /** Milliseconds of socket inactivity before the connection is dropped. */
  socketTimeoutMs?: number
}

/** The slice of a nodemailer transport this adapter calls. */
export interface SmtpTransport {
  /** Hand one already-assembled message to the transport. */
  sendMail(message: SendMailOptions): Promise<SmtpSendInfo>
}

/** The slice of a nodemailer send result this adapter reads. */
export interface SmtpSendInfo {
  /** Recipients the server accepted, when the transport reports them. */
  accepted?: readonly string[]
  /** Recipients the server refused, when the transport reports them. */
  rejected?: readonly string[]
  /** Message id the transport assigned. */
  messageId?: string
}

/**
 * Builds a transport from a connection configuration.
 *
 * The injection point that makes this adapter testable without a socket. The
 * default one loads nodemailer and calls `createTransport`; a test passes a
 * function that records the configuration and the message and returns a stub, so
 * argument assembly is asserted on the real object that would have reached the
 * network.
 */
export type SmtpTransportFactory = (config: SMTPTransportOptions) => SmtpTransport

/**
 * Create a sender for one SMTP configuration.
 *
 * @param options Connection settings and the `from` mailbox.
 * @param factory Transport builder. Defaults to nodemailer; inject one in a test
 * (or to wrap the transport) and this module never loads nodemailer.
 * @throws {TypeError|RangeError} on an empty `host`/`user`/`pass`/`from`, an
 * out-of-range `port`, or a malformed `from` mailbox — a configuration error is a
 * deploy-time bug and fails here rather than on the first message.
 */
export function createSmtpSender(
  options: SmtpOptions,
  factory?: SmtpTransportFactory,
): EmailSender {
  const config = transportConfig(options)
  const from = parseAddress(options.from)
  const secrets = credentialForms(options)

  // Per-sender, not per-module: one transport belongs to this configuration and is
  // built on the first send, so constructing a sender opens nothing.
  let transport: Promise<SmtpTransport> | undefined

  function resolveTransport(): Promise<SmtpTransport> {
    transport ??= factory === undefined
      ? loadNodemailerTransport(config)
      : Promise.resolve(factory(config))
    return transport
  }

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      let recipients: ParsedRecipients
      try {
        assertSendableMessage(message)
        recipients = parseAddresses(message.to)
      } catch (error) {
        // Nothing was sent and nothing will be: a bad recipient list fails the
        // whole message rather than quietly dropping the entry that did not parse.
        return {
          ok: false,
          error: redact(describeError(error), secrets),
          accepted: [],
          rejected: [],
          duplicates: [],
        }
      }

      const envelope = recipients.addresses.map((address) => address.address)

      try {
        const info = await (await resolveTransport()).sendMail(
          mailOptions(message, from, recipients.addresses),
        )
        const accepted = info.accepted === undefined ? envelope : [...info.accepted]
        const rejected = info.rejected === undefined ? [] : [...info.rejected]

        // A partial send is a failure. Reporting the accepted subset as success
        // would hide the recipients who never got the mail.
        if (rejected.length > 0) {
          return {
            ok: false,
            accepted,
            rejected,
            duplicates: recipients.duplicates,
            error: redact(
              `SMTP send failed (${options.host}, to=${envelope.join(",")}): server rejected ` +
                `${rejected.length} recipient(s): ${rejected.join(", ")}`,
              secrets,
            ),
          }
        }

        return {
          ok: true,
          accepted,
          duplicates: recipients.duplicates,
          messageId: info.messageId,
        }
      } catch (error) {
        return {
          ok: false,
          accepted: [],
          rejected: [],
          duplicates: recipients.duplicates,
          error: redact(
            `SMTP send failed (${options.host}, to=${envelope.join(",")}): ${describeError(error)}`,
            secrets,
          ),
        }
      }
    },
  }
}

/**
 * Assemble the nodemailer connection configuration.
 *
 * `debug` and `logger` are absent on purpose and must stay absent: `debug: true`
 * writes the full SMTP conversation to the logger, and that conversation contains
 * the base64 AUTH-LOGIN exchange — a transporter with `debug` on leaks the
 * password to whatever collects stdout.
 *
 * `disableFileAccess` and `disableUrlAccess` are set because nodemailer will read
 * `path` and fetch `href` for an attachment. {@link EmailMessage} has neither
 * field, but an option object is only a type at compile time, so the transport is
 * told to refuse both rather than trusting the shape of what it is handed.
 *
 * @throws {TypeError|RangeError} on a missing or out-of-range setting.
 */
function transportConfig(options: SmtpOptions): SMTPTransportOptions {
  requireSetting(options.host, "host")
  requireSetting(options.user, "user")
  requireSetting(options.pass, "pass")
  requireSetting(options.from, "from")
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new RangeError(`SmtpOptions.port must be 1–65535, got ${options.port}`)
  }

  const secure = options.secure ?? options.port === 465
  const config: SMTPTransportOptions = {
    host: options.host,
    port: options.port,
    secure,
    auth: { user: options.user, pass: options.pass },
    disableFileAccess: true,
    disableUrlAccess: true,
  }

  // Only meaningful on a plaintext port: with `secure: true` the connection is
  // already TLS before EHLO.
  if (!secure && (options.requireTls ?? true)) config.requireTLS = true
  if (options.name !== undefined) config.name = options.name
  if (options.connectionTimeoutMs !== undefined) {
    config.connectionTimeout = options.connectionTimeoutMs
  }
  if (options.greetingTimeoutMs !== undefined) config.greetingTimeout = options.greetingTimeoutMs
  if (options.socketTimeoutMs !== undefined) config.socketTimeout = options.socketTimeoutMs

  return config
}

/**
 * Assemble the message nodemailer sends.
 *
 * The one behavioural fix carried here: `text` and `html` are each set only when
 * the caller supplied a non-blank one, and neither is derived from the other.
 * `mig` sent `html: opts.html ?? opts.text`, so a text-only message went out as
 * `multipart/alternative` whose HTML half was the plain text verbatim — meaning
 * any `<` in the body was parsed as markup, and every text-only message carried a
 * redundant second part.
 */
function mailOptions(
  message: EmailMessage,
  from: EmailAddress,
  recipients: readonly EmailAddress[],
): SendMailOptions {
  const options: SendMailOptions = {
    from: mailbox(from),
    to: recipients.map(mailbox),
    subject: message.subject,
  }

  if (hasBody(message.text)) options.text = message.text
  if (hasBody(message.html)) options.html = message.html
  if (message.attachments !== undefined && message.attachments.length > 0) {
    options.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      encoding: "utf8",
    }))
  }

  return options
}

/**
 * A parsed mailbox in the shape nodemailer's address fields accept.
 *
 * The object form, not a formatted string, is what gets a display name encoded
 * per RFC 2047 and folded correctly — formatting it here would hand nodemailer a
 * pre-encoded string it then encodes again.
 */
function mailbox(address: EmailAddress): string | { name: string; address: string } {
  return address.name === undefined
    ? address.address
    : { name: address.name, address: address.address }
}

/**
 * Every textual form of the credentials that could reach an error string.
 *
 * The connection string form and the base64 forms matter as much as the password
 * itself: nodemailer echoes a `url` option back in some errors, and an AUTH-LOGIN
 * failure surfaces the base64 blob. Longest form first, so `user:pass` is replaced
 * before the bare `pass` inside it and no fragment is left behind.
 *
 * Redaction is unconditional, with no minimum length: a one-character password
 * would mangle a diagnostic, and a diagnostic is worth less than a leaked
 * credential. Sends fail closed.
 */
function credentialForms(options: SmtpOptions): string[] {
  const forms = new Set<string>()
  for (const value of [options.pass, `${options.user}:${options.pass}`]) {
    if (value === "") continue
    forms.add(value)
    forms.add(encodeURIComponent(value))
    forms.add(encodeBase64(new TextEncoder().encode(value)))
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

/** Replace every credential form in `text` with {@link REDACTED_CREDENTIAL}. */
function redact(text: string, secrets: readonly string[]): string {
  let redacted = text
  for (const secret of secrets) redacted = redacted.replaceAll(secret, REDACTED_CREDENTIAL)
  return redacted
}

/** A message for a thrown value that may not be an `Error`. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message
  return String(error)
}

/** Reject a configuration value the transport cannot use. */
function requireSetting(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`SmtpOptions.${name} is required`)
  }
}

/**
 * Load nodemailer and build a transport, on first use.
 *
 * The dynamic import is load-bearing: nodemailer's module body reads
 * `process.env.ETHEREAL_API`, so a static import would make importing this module
 * require `--allow-env` even for a caller that injects its own factory. Loaded
 * here, it costs one module evaluation on the first real send and nothing else.
 */
async function loadNodemailerTransport(config: SMTPTransportOptions): Promise<SmtpTransport> {
  const { default: nodemailer } = await import("nodemailer")
  return nodemailer.createTransport(config)
}
