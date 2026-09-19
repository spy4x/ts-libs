# @ts-libs/email

Email primitives: an SMTP transport behind a small `EmailSender` port, and a pure
RFC 6376 DKIM verifier. The root entry point `"."` re-exports both halves
(`mod.ts`); the subpaths are `./address`, `./html`, `./message`, `./sender`,
`./smtp` and `./dkim-verify`.

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
- **Inbound mail.** Receiving mail is not planned; DKIM verification lives in the
  `./dkim-verify` subpath of this package, not here.

## DKIM verification

```ts
import { fetchDkimPublicKey, verifyDkim } from "@ts-libs/email"

// Key supplied by the caller — no permissions needed.
const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
const offline = await verifyDkim(rawMessage, key ?? undefined)

// Key fetched from DNS by the default resolver — needs --allow-net.
const live = await verifyDkim(rawMessage)
if (!live.valid) console.warn(live.reason)
```

## What this verifies

Given a raw RFC 5322 message and a DKIM public key, `verifyDkim` answers one
question: **does this message's `DKIM-Signature` verify against this key?**

- Signature-header parsing (`parseDkimSignature`), including folded values.
- `simple` and `relaxed` canonicalization, for headers and for bodies
  (`canonicalizeHeader`, `canonicalizeBody`).
- The body hash (`bh=`), computed over the canonicalized body truncated to the
  `l=` bound when one is present, as RFC 6376 §3.7 step 1 requires.
- `rsa-sha256` (RSASSA-PKCS1-v1_5) and `ed25519-sha256`, the latter signing
  `SHA-256` of the canonical input as RFC 8463 §3 requires.
- `parseDkimPublicKey` from a DNS TXT record, including revoked keys (`p=`).
- Expiry (`x=`) against an injectable clock.
- The header/body boundary, which RFC 5322 §2.2 puts at the **first** empty line.
  A body whose first line begins with SP or HTAB is body, not a folded header —
  reading it as a header left those octets outside the body hash entirely.
- The DKIM-Signature field **name the message actually spells**. §3.7 step 2
  hashes "the DKIM-Signature header field that exists", and under `simple`
  canonicalization the name's case is part of the signed bytes.

The signature input follows §3.7 step 2 exactly: every header named in `h=`, in
the order `h=` declares (so repeated fields are consumed from the bottom of the
header block upwards, §5.4.2), then the `DKIM-Signature` field with its `b=`
value deleted and **without a trailing CRLF**. Nothing follows that field — the
body hash the signer covered is the `bh=` tag inside it. Names in `h=` that match
no header in the message contribute nothing, as §3.5 allows.

Correctness is checked against implementations other than this one: RFC 8463's
Appendix A.3 Ed25519 example, RFC 6376's example message signed with a known key,
eighteen messages built with dkimpy 1.1.8's canonicalizers plus OpenSSL, and five
signed by an OpenSSL-only script whose canonicalizer is written from the RFC text
(`openssl-*`: the §2.2 boundary cases and a lower-case field name). Every one is
confirmed by `openssl dgst -sha256 -verify` against the §3.7 reconstruction. See
`fixtures/SOURCES.md`, which also records what these vectors are _not_.

## What this does not do

- **It does not fetch the key for you** unless you inject a resolver or accept
  the default one. The default is `Deno.resolveDns(name, "TXT")`, which needs
  `--allow-net`. Everything in this package's own test suite runs through an
  injected resolver and therefore needs no permissions.
- **No DMARC, SPF, ARC or DKIM alignment.** A verified signature is not an
  authorized sender. DMARC needs `d=`/`i=` alignment against the visible `From:`
  field, which is a policy decision rather than a cryptographic one, and this
  package never inspects `From:` for that purpose.
- **No deliverability policy.** It does not decide what to do with a message
  that fails: no quarantine, no scoring, no reporting. That belongs in the
  caller.
- **No replay, freshness or `Received`-chain protection.** A valid signature
  stays valid unless `x=` says otherwise. `t=` is parsed but not enforced beyond
  what the signature already binds.
- **No signature generation.** Verification only; there is no signer here.

## Injected resolver contract

```ts
interface DnsTxtResolver {
  resolveTxt: (name: string) => Promise<string[][]>
}

interface DkimVerifyOptions {
  now?: bigint
  resolver?: DnsTxtResolver
}
```

- The queried name is `` `${selector}._domainkey.${domain}` ``.
- The shape is one array of strings per TXT record. RFC 6376 §3.6.2.2 requires a
  record's strings to be concatenated with no separator, and
  `fetchDkimPublicKey` does that before parsing.
- An empty answer throws `DkimParseError` rather than reporting a revoked key,
  so a broken resolver cannot be mistaken for a revoked key. A resolver
  rejection propagates out of `fetchDkimPublicKey` and becomes
  `result.reason` in `verifyDkim`.
- `p=` present but empty is a revoked key: `fetchDkimPublicKey` returns `null`
  and `verifyDkim` reports `"DKIM key revoked (p= is empty)"`.
- `publicKey` wins over `resolver` in `verifyDkim`: pass a key and no lookup
  happens at all.

`verifyDkim` returns a result for every message-shaped failure — missing header,
bad grammar, expiry, body mismatch, unverifiable signature. Only a throwing
injected resolver escapes it.

## Decisions a reviewer should weigh

- **Errors are results, not exceptions.** A malformed message does not throw, so
  a caller cannot lose a diagnosis to a `catch`. `reason` distinguishes the
  cases and `parsed` is populated whenever the header parsed at all.
- **`l=` truncates the canonicalized body before hashing it.** §3.7 step 1 says
  the body is "truncated to the length specified in the l= tag", so a signature
  over 18 octets is only reproducible by hashing 18 octets. A bound _longer_ than
  the body it accompanies is **accepted**, although §3.5 says the signer "MUST
  NOT" use one: that MUST binds the signer, and verifier-side a bound can only
  ever _reduce_ the octets covered, never extend them, so accepting one cannot
  admit a message a shorter bound would have rejected (`dkimpy-l25` is `l=25`
  over an 18-octet body, and appending a single byte to it still fails). It is
  inside the signed field, so an attacker cannot add or enlarge it. Rejecting
  instead would convert a harmless signer tag into a false rejection.
- **An unsigned `From:` verifies, and that check is the caller's.** §5.4 requires
  a _signer_ to list `From:` in `h=`, while §6.1.1 and §6.1.2 add no verifier
  check that it did — so `verifyDkim` accepts a signature whose `h=` never names
  `From:`, and a `From:`-less message too (malformed per RFC 5322, but malformed
  is not unverified). Domain policy is where that belongs: read
  `result.parsed.signedHeaders` and require `"from"` before trusting a verdict.
- **The DKIM-Signature field name comes from the message.** §3.7 step 2 hashes
  "the DKIM-Signature header field that exists", and `simple` preserves the
  name's case (§3.4.1), so the name is signed bytes: renaming the field to
  `dkim-signature:` fails a simple signature, and a signer that emitted the
  lower-case name verifies. Hashing a literal `"DKIM-Signature"` — as an earlier
  revision did — verified a renamed field against bytes the message no longer
  contained and rejected the lower-case signer. `relaxed` lower-cases the name
  (§3.4.2), so there the case carries no information and a renamed field still
  verifies.
- **`h=` must NOT list `dkim-signature`.** §3.5 forbids it, and §3.7 adds that
  field to the header hash as its own unconditional step. Requiring it — as an
  earlier revision of this file did — rejects every standard signer, RFC 6376's
  own examples included.
- **Tags after `b=` are verified, not refused.** §3.7 deletes only the _value_ of
  `b=`, so everything after it stays inside the signed bytes. A signature ending
  `…; b=SIG; x=1800000000` is valid and its `x=` is authenticated, and appending
  `; x=9999999999` or `; i=@attacker.invalid` to a genuine message changes the
  hashed field and fails. An earlier revision truncated the field at `b=` and
  claimed the tag was unprotected; that reasoning was wrong in both directions,
  and it rejected conformant mail.
- **A repeated tag is rejected.** §3.2 forbids duplicates. Silently keeping the
  last one let an attacker append `; b=<their own signature>` and win.
- **An unknown tag is ignored.** §3.5 allows extensions; real signatures carry
  them (`r=`, `dt=`).
- **Unfolding deletes the line ending, it does not turn it into a space.**
  §3.4.2 unfolds by removing the CRLF and then compressing the WSP that followed
  it, so `one<CRLF><HTAB>two` canonicalizes to `one two` and `a<LF>b` to `ab`.
  A bare LF inside a value is not a line ending (RFC 5322 §2.3): `simple` keeps
  it byte for byte, `relaxed` deletes it as part of unfolding. A **non-trailing**
  lone CR likewise survives both modes: §3.4.2 unfolds CRLF only, and the relaxed
  path trims the ends of the value, not its interior. That trim **is**
  `String.trim()` (`canonicalizeHeader`), so a _trailing_ lone CR is kept by
  `simple` and stripped by `relaxed` — a leading or trailing CR is whitespace to
  `trim()`, an interior one is not. (An earlier revision of this file claimed the
  relaxed path avoided `trim()` to preserve a lone CR; it does not, and the tests
  pin the interior-CR expectation rather than that rationale.) Body handling still
  normalises bare LF to CRLF, because mailbox storage rewrites line endings and
  nothing else references the body's original bytes.
- **Both RSA key shapes import.** §3.6.1 says the `p=` tag holds a bare PKCS#1
  `RSAPublicKey`, which is what real selector records publish, but RFC 6376's own
  example record publishes a complete SubjectPublicKeyInfo. The envelope is
  detected, not guessed. `DkimPublicKey.keyBytes` therefore holds whatever the
  record carried — SPKI bytes for an SPKI `p=` — rather than a normalised form.
- **`b=` need not be the last tag, in either mode.** §3.7 step 2 deletes only the
  _value_ of `b=`, bounded by the value's parsed offsets, so the deletion is
  byte-exact wherever the tag sits; a field ending `…; b=SIG; x=1800000000`
  verifies under `simple` as well as `relaxed` and its `x=` is authenticated
  (`dkimpy-unsigned-trailing-tag`). An earlier revision refused that shape, on the
  false premise that a non-final `b=` could not be emptied without rebuilding the
  header.

## What the suite does not cover

- **No real mail.** Every fixture is synthetic. A message from a production
  signer would test more, and none is available offline.
- **The printed §3.5 signature is not reproduced.** Its private key is
  unpublished, so the RFC's actual signature cannot be verified by anyone; what
  is tested is the RFC's example message signed with a known key.
- **Negative coverage is a matrix, not a proof.** Tampering is tested across both
  modes and both algorithms (body, signed header, signature byte, removed header,
  wrong key), which is stronger than one case per path but still finite.

## Zero dependencies

This package imports nothing. Web Crypto and platform primitives only, on
purpose: the verifier cannot drift out of step with a crypto dependency, and it
needs no supply-chain review. If a change here looks like it needs `@std/*` or
npm, that is a design question, not an import to add.
