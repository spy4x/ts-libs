# @ts-libs/email

Email primitives. Today: an SMTP transport behind a small `EmailSender` port.

> The RFC 6376 DKIM verifier (`#8`) is a sibling PR that adds `./dkim-verify` and
> its own section here. This file is written to be **extended, not replaced** when
> it lands: the intro and the per-feature sections are independent.

```ts
import { createSmtpSender } from "@ts-libs/email/smtp"
import { escapeHtml, htmlWrap } from "@ts-libs/email/html"

const sender = createSmtpSender({
  host: "smtp.example.com",
  port: 587,
  user: "user@example.com",
  pass: "test-password-not-real",
  from: "Booking <booking@example.com>",
})

const html = htmlWrap({
  brand: "Booking",
  brandUrl: "https://book.example.com",
  body: `<p>Hi ${escapeHtml(guestName)},</p>`,
})

const result = await sender.send({
  to: ["guest@example.com", "host@example.com"],
  subject: "Booking confirmed",
  text: "Your meeting is booked.",
  html,
})

if (!result.ok) console.error(result.error, result.rejected)
```

## Why nodemailer, behind a port

The repo dependency policy is _own the small, keep the huge_ — and it names an
SMTP lib among the things to keep rather than write, because SMTP is a tarpit:
EHLO capability parsing, SASL mechanism selection, STARTTLS with a
downgrade-resistant upgrade, per-recipient `MAIL FROM`/`RCPT TO` status, MIME
assembly, RFC 2047 header encoding, RFC 2231 parameter encoding. Generic email is
a huge, well-solved problem.

The port is what keeps that choice reversible. `EmailSender` mentions nothing from
nodemailer, so a Deno-native client, an SES adapter or a fan-out decorator can
replace the transport without touching a caller. Every vendor-specific type lives
in `smtp.ts` — the injected `SmtpTransportFactory` is deliberately the only place
nodemailer's typings appear.

**Not ported from `antonshubin.com`.** That repo hand-rolls SMTP in three places
(`lead.ts`, `subscribe.ts`, `send-newsletter.ts`) and none of it came across: it
does `AUTH LOGIN` only, never parses EHLO capabilities, has no STARTTLS fallback,
never checks the `MAIL FROM`/`RCPT TO` responses, and closes with a
fire-and-forget `await read()`. It is dependency-free and it is not a starting
point.

## Exports

| Specifier                | Contents                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `@ts-libs/email/smtp`    | `createSmtpSender`, `SmtpOptions`, the transport factory seam |
| `@ts-libs/email/sender`  | `EmailSender`, `SendResult`, `createConsoleSender`            |
| `@ts-libs/email/message` | `EmailMessage`, validation, timezone framing, ICS attachment  |
| `@ts-libs/email/html`    | `escapeHtml`, `htmlWrap`                                      |
| `@ts-libs/email/address` | mailbox parsing, formatting and list deduplication            |

## The `EmailSender` port

```ts
interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>
}
```

- **`send` never throws for a message-shaped problem.** A bad recipient, an empty
  recipient list, a missing body and a header-injecting subject all come back as a
  failed `SendResult` carrying the reason, before any transport is touched.
- **Constructing a sender throws on a bad configuration** — an empty `host`,
  `pass` or `from`, an out-of-range port, a malformed `from` mailbox. A
  configuration error is a deploy-time bug, not a per-message outcome.
- **A partial send is never success.** If the server refuses one of three
  recipients, the result is `ok: false` with `accepted` and `rejected` listed, so
  the caller can see exactly who got the mail.
- **Recipient syntax is all-or-nothing.** One unparsable entry fails the whole
  message; the valid subset is never mailed quietly.
- **Duplicates are deduplicated** case-insensitively before sending and reported
  in `duplicates`.
- **Credentials are redacted.** Every string that leaves through `error` has the
  password, the `user:pass` pair and every base64 SASL blob they can form replaced
  with `<REDACTED:CREDENTIAL>`. That is not a fixed list of encodings: after the
  exact forms are replaced, every base64-like run in the message is decoded —
  padding restored, base64url normalized, percent-encoding undone — and replaced
  when it obviously contains the credentials. The AUTH **PLAIN** payload is
  `base64("\0" + user + "\0" + pass)`, which nodemailer prefers over LOGIN, and it
  is the case a LOGIN-only form list misses: `base64(pass)` sits inside it only
  when `len(user) ≡ 1 (mod 3)`.
- **Attachments cannot read files or fetch URLs.** The transport is configured
  with nodemailer's `disableFileAccess` and `disableUrlAccess`, so an attachment
  carrying a `path` or an `href` is refused rather than read — the caller's option
  object cannot reach either.

### Addresses

A mailbox is validated at the boundary, and one bad entry in a recipient list
fails the whole message rather than dropping that entry:

- An addr-spec must be a dot-atom local part at a **dotted domain**. The domain
  rule is stricter than RFC 5322 on purpose: `user@localhost` is legal and no relay
  outside a test container delivers it, so a bare-host address is nearly always a
  truncated value. Reject it loudly and the truncation is visible; accept it and it
  bounces.
- A control character is rejected outright, anywhere in a mailbox, subject or
  attachment filename/content type. `Name\r\nBcc: victim@example.com` is a
  plausible-looking display name and a forged header, so it never reaches a header.
- A display name containing a comma is accepted unquoted (`Doe, Jane <jane@example.com>`)
  and re-emitted quoted. Non-ASCII names travel to the transport as structured
  fields, so nodemailer encodes them per RFC 2047 instead of emitting mojibake.

## Configuration

| Option                | Default                | Notes                                                           |
| --------------------- | ---------------------- | --------------------------------------------------------------- |
| `host`                | —                      | Relay hostname.                                                 |
| `port`                | —                      | `465` selects implicit TLS; any other port starts in the clear. |
| `user` / `pass`       | —                      | SMTP AUTH credentials.                                          |
| `from`                | —                      | `addr@example.com` or `Name <addr@example.com>`.                |
| `secure`              | `port === 465`         | Implicit TLS before EHLO.                                       |
| `requireTls`          | `true` when not secure | Force STARTTLS; `false` allows sending in the clear.            |
| `name`                | nodemailer's           | EHLO name.                                                      |
| `connectionTimeoutMs` | nodemailer's           | TCP connect timeout.                                            |
| `greetingTimeoutMs`   | nodemailer's           | Server greeting timeout.                                        |
| `socketTimeoutMs`     | nodemailer's           | Socket inactivity timeout.                                      |

**The library never reads the environment** — no `Deno.env`, at module scope or
anywhere else. Read your configuration in the application and pass it in.

`requireTls` defaults to `true` on a non-implicit-TLS port. That is a deliberate
departure from the source, which used opportunistic STARTTLS: an opportunistic
upgrade is stripped by any on-path attacker, who then reads the AUTH exchange. A
relay that genuinely cannot do STARTTLS needs `requireTls: false`.

If your process runs the default transport factory, it needs `--allow-env`:
nodemailer's module body reads `process.env.ETHEREAL_API` while loading. This
package imports it lazily, on the first send through the default factory, so a
process that injects its own factory never loads nodemailer _through this package_
and needs no permission beyond the ones it already has. (This package's own test
suite does import nodemailer statically, to compile real MIME offline through its
`streamTransport`; that is a test-only path.)

## Transport is injectable

`createSmtpSender(options, factory?)` takes an optional `SmtpTransportFactory`. It
exists so the adapter's argument assembly can be asserted on the exact connection
configuration and the exact message object that would have reached the network,
with no socket and no `--allow-net`:

```ts
const sender = createSmtpSender(options, (config) => ({
  sendMail: (message) => {
    // assert on `config` and `message`, or forward to a real transport
    return Promise.resolve({ accepted: [] })
  },
}))
```

`createConsoleSender()` implements the port by logging instead: envelope, subject,
body preview, attachment count. Local and test flows need no mail server. Pass
`log` to capture the output somewhere else.

## HTML

`escapeHtml` escapes a **value** — `&`, `<`, `>`, `"` and `'`. `htmlWrap` takes
**pre-escaped HTML** and escapes only the fields it interpolates itself (the brand
label and its link). Escape at the interpolation:

```ts
htmlWrap({ body: `<p>${escapeHtml(name)}</p>` }) // correct
htmlWrap({ body: escapeHtml(`<p>${name}</p>`) }) // escapes the markup too
```

## Per-recipient timezone framing

`frameWallClockLong(date, time, sourceTz, recipientTz?)` turns a wall clock
written in `sourceTz` into a line the recipient can read:
`"Friday, 28 August 2026 at 04:00 (America/New_York)"`. `frameInstantLong` does the
same for an absolute instant, and the `*Short` variants drop the zone name for a
subject line. An unknown recipient zone falls back to the source zone; an unknown
_source_ zone throws `RangeError` rather than reaching `Intl`.

The zone math is `@ts-libs/time/tz` — `zonedDateTime`, `formatInstantLong`,
`formatInstantShort`, `validTimeZoneOr`, `isValidTimeZone`. Nothing here
reimplements it, and nothing reads the host `TZ`, so the same input produces the
same output on every machine.

## ICS attachments

`icalAttachment(event, { ics, filename? })` builds a `text/calendar` attachment
from `@ts-libs/time/ics` (`generateIcs`) — there is no second ICS writer here. The
MIME type's `method` parameter is read back out of the generated document, so a
`Content-Type` announcing `REQUEST` for a body that says `CANCEL` is not
expressible. Non-ASCII filenames are emitted per RFC 2231 (`filename*0*=utf-8''…`)
by the transport.

## Out of scope

- **Templates.** Guest/owner confirmation pairs, booking copy, cancellation
  wording and every other domain string stay in the application. This package owns
  the transport, the escaping, the HTML shell, timezone framing and ICS
  attachment plumbing; it does not own your words.
- **An SES adapter.** `roley`'s would drag in `@aws-sdk/client-sesv2`. The port
  makes one a small `fetch` against the SES API when a caller needs it; until
  then it is unbuilt surface.
- **Binary attachments.** `EmailAttachment.content` is UTF-8 text, which is what
  an ICS file and a rendered HTML part need. A `Uint8Array` variant is the change
  to make when a caller needs one.
- **Inbound mail.** Parsing, DKIM verification (`#8`) is separate, SMTP receipt is
  not planned.
