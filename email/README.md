# @spy4x/email

Email primitives: an SMTP transport behind a small `EmailSender` port, and a pure
RFC 6376 DKIM verifier. The root entry point `"."` re-exports both halves
(`mod.ts`); the subpaths are `./address`, `./html`, `./message`, `./sender`,
`./smtp` and `./dkim-verify`.

```ts
import { createSmtpSender } from "@spy4x/email/smtp"
import { escapeHtml, htmlWrap } from "@spy4x/email/html"

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

| Specifier              | Contents                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `@spy4x/email/smtp`    | `createSmtpSender`, `SmtpOptions`, the transport factory seam                                   |
| `@spy4x/email/sender`  | `EmailSender`, `SendResult`, `createConsoleSender`                                              |
| `@spy4x/email/message` | `EmailMessage`, validation, timezone framing, ICS attachment                                    |
| `@spy4x/email/html`    | `escapeHtml`, `htmlWrap`, `HtmlShellTheme`, `DEFAULT_HTML_SHELL_THEME`, `DARK_HTML_SHELL_THEME` |
| `@spy4x/email/address` | mailbox parsing, formatting and list deduplication                                              |

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

`brandUrl` must be an absolute `http:`, `https:` or `mailto:` URL and throws a
`TypeError` otherwise. Escaping leaves `javascript:alert(1)` a well-formed link —
the characters that need escaping are not the ones that make a scheme dangerous —
and the value comes from a caller's configuration rather than from a recipient, so
a wrong one is a bug to surface rather than input to sanitise.

`htmlWrap` defaults to a neutral light shell (`DEFAULT_HTML_SHELL_THEME`) —
white background, dark text, a plain blue link — rather than the dark navy
body with an orange link it shipped with before `theme` existed. **This is a
breaking change for any caller that already copied that dark look**, though
nothing in this repository does: pass `theme: DARK_HTML_SHELL_THEME` to keep
it exactly. `theme` accepts a partial override (`{ background: "#000000" }`
keeps the rest of the default); every colour must be a `#rgb`/`#rrggbb` hex
value or `htmlWrap` throws, because a colour lands inside a double-quoted
`style` attribute and an unvalidated one could close it early. `maxWidth`
(default `480`) is the letter column's width in pixels, and `signaturePrefix`
(default `"— Sent by"`) is the footer wording before the brand — pass `null`
to drop the footer line while keeping the header brand block.

## Per-recipient timezone framing

`frameWallClockLong(date, time, sourceTz, recipientTz?)` turns a wall clock
written in `sourceTz` into a line the recipient can read:
`"Friday, 28 August 2026 at 04:00 (America/New_York)"`. `frameInstantLong` does the
same for an absolute instant, and the `*Short` variants drop the zone name for a
subject line. An unknown recipient zone falls back to the source zone; an unknown
_source_ zone throws `RangeError` rather than reaching `Intl`.

The zone math is `@spy4x/time/tz` — `zonedDateTime`, `formatInstantLong`,
`formatInstantShort`, `validTimeZoneOr`, `isValidTimeZone`. Nothing here
reimplements it, and nothing reads the host `TZ`, so the same input produces the
same output on every machine.

## ICS attachments

`icalAttachment(event, { ics, filename? })` builds a `text/calendar` attachment
from `@spy4x/time/ics` (`generateIcs`) — there is no second ICS writer here. The
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
import { fetchDkimPublicKey, verifyDkim } from "@spy4x/email"

// Key supplied by the caller — no permissions needed.
const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
const offline = await verifyDkim(rawMessage, key ?? undefined)

// Key fetched from DNS by the default resolver — needs --allow-net.
const live = await verifyDkim(rawMessage)
if (!live.valid) console.warn(live.reason)
```

`rawMessage` may be a `string` or a `Uint8Array`. DKIM is defined over octets
(RFC 6376 §2.4), and a `string` cannot represent 8-bit content that is not
valid UTF-8 — decoding it as UTF-8 rewrites the bytes, and decoding it as
`latin1` actually runs windows-1252 and remaps 0x80-0x9F. Pass the raw bytes
for mail that might not be UTF-8; a `string` keeps working exactly as before,
UTF-8 encoded first. `maxMessageLength` and the message-too-large reason both
count octets, not UTF-16 code units, either way.

## What this verifies

Given a raw RFC 5322 message and a DKIM public key, `verifyDkim` answers one
question: **does this message's `DKIM-Signature` verify against this key?**

- Signature-header parsing (`parseDkimSignature`), including folded values.
- `simple` and `relaxed` canonicalization, for headers and for bodies
  (`canonicalizeHeader`, `canonicalizeBody`).
- The body hash (`bh=`), computed over the canonicalized body truncated to the
  `l=` bound when one is present, as RFC 6376 §3.7 step 1 requires. Canonicalized
  and hashed at most once per distinct `(c=, l=)` combination for the whole
  message, however many `DKIM-Signature` fields share it (§6.1 verifies every
  field independently, and most real mail signs the body once).
- `rsa-sha256` (RSASSA-PKCS1-v1_5) and `ed25519-sha256`, the latter signing
  `SHA-256` of the canonical input as RFC 8463 §3 requires.
- `parseDkimPublicKey` from a DNS TXT record, including revoked keys (`p=`).
- Expiry (`x=`) against an injectable clock, and that `x=` is later than `t=`.
- **That `h=` names `From`** (§6.1.1), and that the message has a `From` field to
  sign. A signature that does not cover `From` says nothing about who sent the
  mail, and this verifier used to call one valid.
- **That `d=` is the `i=` domain or a parent of it** (§6.1.1), and exactly `d=`
  when the key record carries `t=s`.
- **The key record's own tags** (§3.6.1): `v=` must be `DKIM1` and come first,
  `h=` must allow `sha256`, `s=` must name `email` or `*`, and `t=y` — the domain
  is only testing DKIM — never produces a valid verdict.
- **RSA keys of at least 1 024 bits** (RFC 8301 §3.2). A 512-bit key is refused
  however well its signature verifies. The bits are counted from the modulus
  itself: `CryptoKey.algorithm.modulusLength` reports an imported key's modulus
  rounded up to a whole byte, so a 1 023-bit key claims 1 024 there.
- **Every `DKIM-Signature` field**, not just the first (§6.1). `verifyDkim`
  reports the first valid one; `verifyDkimSignatures` returns one result per
  field, so a caller can see which domains signed.
- The header/body boundary, which RFC 5322 §2.2 puts at the **first** empty line.
  A body whose first line begins with SP or HTAB is body, not a folded header —
  reading it as a header left those octets outside the body hash entirely.
- **That the header block's line endings are uniform.** A block carrying a
  carriage return that no line feed follows is refused before a single field is
  parsed, and so is a block that ends some lines with CRLF and others with a bare
  LF. A block that uses a bare LF throughout keeps verifying: that is what mailbox
  storage produces, and RFC 6376's own example message is stored that way. **The
  body's line endings are a separate, looser rule:** only CRLF and a bare LF end a
  body line; a lone CR there is an ordinary octet, hashed as one, matching RFC
  6376 §3.4.3/§3.4.4 and how dkimpy and OpenDKIM canonicalize a body. A CR in the
  body cannot hide a header field, so the header block's stricter refusal has no
  reason to apply there — treating a lone CR as a line ending in the body used to
  disagree with every RFC-faithful signer on a body that legitimately carries one
  and reported it as tampered with (issue #94).
- **That the message did not grow an instance of a header the signature covers**
  (§5.4.2). A signer lists a name in `h=` as many times as the message carried it,
  so an instance left over after the pairing means the message gained one after
  signing. The trace fields in `TRANSIT_ADDED_HEADER_NAMES` are exempt, because a
  relay adds those on the way; every other name, `From` above all, is refused.
- The DKIM-Signature field **name the message actually spells**. §3.7 step 2
  hashes "the DKIM-Signature header field that exists", and under `simple`
  canonicalization the name's case is part of the signed bytes.

Every result that hashed a body also carries `bodyCoverage`: how many canonical
octets the signature covers, how many the body has, and whether they are the same.
A signer may bound the body hash with `l=`, and with `l=0` the signature covers no
body at all — the verdict is still `valid`, because RFC 6376 §3.5 allows it, so
**a caller that shows the body to a person must check `bodyCoverage.complete`**.

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
  stays valid unless `x=` says otherwise. `t=` is parsed, and the only rule
  applied to it is §3.5's: `x=` must be later than `t=` when both are present.
  Nothing here refuses a signature for being old.
- **No signature generation.** Verification only; there is no signer here.

## Injected resolver contract

```ts
interface DnsTxtResolver {
  resolveTxt: (name: string) => Promise<string[][]>
}

interface DkimVerifyOptions {
  now?: bigint
  resolver?: DnsTxtResolver
  maxMessageLength?: number // default DEFAULT_MAX_MESSAGE_LENGTH, 10 MiB of octets
  maxSignatures?: number // default DEFAULT_MAX_SIGNATURES, 10
  maxHeaderFields?: number // default DEFAULT_MAX_HEADER_FIELDS, 1000
  maxSignedHeaderNames?: number // default DEFAULT_MAX_SIGNED_HEADER_NAMES, 200
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
- Several records come back for one name often enough — a domain publishes what it
  likes beside its key — so each is tried and the first that parses is the key.
  When none parses, the first record's own error is what the caller sees.
- `d=` and `s=` are checked against §3.1's grammar before the name is built, so a
  resolver that puts the name into a URL or a command line cannot be handed
  anything but letters, digits, hyphens and dots. Three spellings a verifier
  without that check would have looked up are refused with
  `"DKIM d= tag is not a domain name"` (or `s=`): an **underscore**
  (`s=sel_1`), a **trailing dot** (`d=example.com.`), and **non-ASCII letters**
  (`d=münchen.example`, which RFC 8616 permits — publish the A-label
  `xn--mnchen-3ya.example` instead). The check reads `d=` and `s=` separately, so
  the `_domainkey` label the lookup itself adds is unaffected, and ordinary
  selectors (`selector1`, `hs1-12345`, `2026`) are unaffected too.

`verifyDkim` returns a result for every message-shaped failure — missing header,
bad grammar, expiry, unsigned `From`, body mismatch, unverifiable signature — and
for a resolver that throws, whose message becomes `result.reason`. Nothing escapes
it, which the docs used to deny.

One consequence is worth knowing: the result says `valid: false` for a DNS lookup
that failed, and does not distinguish that from a signature that is wrong. RFC
6376 §6.1.2 calls the first TEMPFAIL and the second PERMFAIL, and a caller that
needs to tell them apart should fetch the key itself with `fetchDkimPublicKey`,
which propagates the resolver's rejection instead of reporting it.

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
- **An unsigned `From:` is refused.** §6.1.1: "If the 'h=' tag does not include
  the From header field, the Verifier MUST ignore the DKIM-Signature header field
  and return PERMFAIL (From field not signed)." An earlier revision of this file
  read §5.4 as binding the signer only and accepted such a signature, which is the
  first finding of issue #62: a message signed with `h=to:subject` kept a valid
  signature while its `From:` line was rewritten to any address at all. A message
  with no `From:` field is refused for the same reason — `h=from` over a message
  without one hashes nothing for it.
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
- **An unknown tag is ignored, whatever its value.** §3.2: "Unrecognized tags
  MUST be ignored." Real signatures carry them (`r=`, `dt=`). An earlier revision
  rejected `dt=` with any value but `1` — an invented rule this file documented as
  an ignored tag, and a rule no test could reach.
- **Unfolding deletes the line ending, it does not turn it into a space.**
  §3.4.2 unfolds by removing the CRLF and then compressing the WSP that followed
  it, so `one<CRLF><HTAB>two` canonicalizes to `one two` and `a<LF>b` to `ab`.
  A bare LF inside a value is not a line ending (RFC 5322 §2.3): `simple` keeps
  it byte for byte, `relaxed` deletes it as part of unfolding. A lone CR
  survives both modes, at the ends of the value as much as in the middle:
  §3.4.2 unfolds CRLF only, and the relaxed path trims the ends of the value
  with WSP only — SP and HTAB, RFC 5234's own definition, via a hand-written
  `trimWsp` rather than `String.trim()`. An earlier revision used `trim()`
  there, for which CR is whitespace, so a leading or trailing lone CR was
  stripped by `relaxed` and kept by `simple`; that asymmetry is gone. It
  mattered once this file could handle raw octets rather than decoded text
  (see `verifyDkim`'s `Uint8Array` support): `trim()` also strips U+00A0, so a
  raw UTF-8 value ending in the byte 0xA0 — the second byte of "à" (0xC3 0xA0)
  — would have lost that byte under relaxed canonicalization. Body handling no
  longer normalises a lone CR at all — see the body line-endings paragraph
  above.
- **A header block with a lone carriage return is refused outright.** This is the
  first finding of issue #88, and what it costs to get wrong is a forged sender.
  Readers do not agree on whether a bare CR ends a line: this verifier keeps the
  CR inside the value it sits in, so a message carrying
  `X-Note: a<CR>From: ceo@bank.example` above a signed block has one `From:` here
  — the genuine one, which the signature covers — and two in a client that breaks
  the line, where the forged one is what a person reads. The verdict was `valid`
  and the sender shown was not the sender signed for. Guessing which reading is
  right is not available to a verifier, so the message is refused with a reason
  that names the problem, and a block that mixes CRLF with bare LF is refused for
  the same reason: it has already passed through something that rewrote line
  endings, and which ending a later reader honours is again a guess. A block that
  is uniformly bare LF is **accepted**, because refusing it would reject ordinary
  mail out of a mailbox — the alternative reading of the issue's checkbox, "refuse
  every bare LF", turns RFC 6376's own example message invalid. The rule covers
  the header block only; a carriage return in the body cannot hide a header field.
- **A header block carrying a vertical tab, a form feed, a file/group/record
  separator, NEL or a Unicode line/paragraph separator is refused outright.**
  Issue #121, the same shape as the lone-CR rule above for a different set of
  bytes: `X-Note: a<FF>From: ceo@bank.example` above a signed block hides a
  second `From:` from this verifier the way the CR form does, behind a byte
  some reader still treats as ending the line. RFC 5322 never allows any of
  0x0B (VT), 0x0C (FF), 0x1C-0x1E (file/group/record separator), 0x85 (NEL) or
  U+2028/U+2029 (Unicode LINE/PARAGRAPH SEPARATOR) inside a header field at
  all, so no conformant sender's message carries one, and the block is refused
  with a reason naming the byte, anywhere in the block.
  The tricky one is 0x85: it is also an ordinary _continuation_ byte of dozens
  of legitimate multi-byte UTF-8 characters (`Å` is C3 85, `ą` is C4 85), so
  refusing every occurrence of that raw byte would refuse header values that
  hide nothing. The check decodes the header block as UTF-8 as it scans, one
  well-formed sequence at a time, and refuses a byte only when it stands for
  NEL itself — a bare, Latin-1-style 0x85 with no valid lead byte before it,
  or a properly encoded C2 85 — never when 0x85 is a continuation byte inside
  a different, legitimate character. A `string` input can only ever produce
  the well-formed form, because `TextEncoder` never emits an unpaired byte; a
  `Uint8Array` input can carry the bare form directly, which is the literal
  shape of the issue's own proof of concept.
- **Trace fields a relay adds are exempt from the §5.4.2 growth check.** The check
  refuses a message that still holds an instance of a name `h=` asked for, which is
  how a prepended second `From:` or `Subject:` is caught — it must not be removed,
  and removing it makes those forgeries verify again. It did, however, refuse
  ordinary forwarded mail: every hop prepends its own `Received:`, so a signature
  covering `Received` broke the moment the mail was forwarded. The names in
  `TRANSIT_ADDED_HEADER_NAMES` — `received`, `x-received`, `return-path`,
  `delivered-to`, `authentication-results`, `resent-*` and `arc-*` — are therefore
  exempt, and no others. What makes a name belong there is that a later hop
  prepends it by design, so a message that carries one more of it than the signer
  signed is ordinary mail and not a forgery. It is **not** that a person never sees
  these fields — `Resent-From` is on the list and some mail clients display it as
  the sender. It is there because a redirect prepends a fresh `Resent-*` block
  exactly the way a relay prepends a `Received:` field, and a verifier that
  implements RFC 6376 and nothing more accepts that message as well, having no
  growth check at all. A signer who wants one of these names protected has the
  remedy §5.4 gives for it: list the name in `h=` once more than the message
  carries it. The oversigned instance is still hashed, so a message that gained a
  field of that name fails the signature. The exemption does not change which
  bytes are hashed: §5.4.2
  pairs `h=` with the message from the bottom up and a relay prepends, so the
  instances selected are still the ones the signer signed, and altering a signed
  `Received:` still fails the signature. The list is exported so the choice is
  visible, and a caller who disagrees can see exactly what it admits.

  Both this check and the unsigned-`From` check compare a header **name**
  loosely on purpose: every octet outside printable ASCII (0x21-0x7E) is
  trimmed from both ends of the name before it is compared (`trimHeaderName`),
  so `From\x0B:` and `From` padded with a no-break space, a byte order mark, a
  zero-width space or a C0 control character all still count as `from`. A
  client that reads the field the same loose way would display the forged
  address, so refusing to match it here would be the unsafe choice. RFC 5322's
  `ftext` already restricts a genuine field name to this same range, so
  trimming anything outside it can only make a disguised name easier to
  recognise, never harder — an earlier revision trimmed a narrower, explicit
  byte set copied from what `String.prototype.trim()` stripped, which missed
  several of `trim()`'s own Unicode whitespace characters (found in round 1
  review of the pull request that added it) and every control character and
  zero-width space RFC 5322 never allows in a name either (issue #106). This
  also means CR and LF are trimmed now, which is load-bearing rather than a
  side effect: RFC 5322 does not let a field name fold before its own colon —
  the obsolete syntax it does allow there is plain spaces and tabs,
  `obs-from = "From" *WSP ":"` — but unfolding is defined as deleting every
  CRLF immediately followed by WSP wherever it sits, so a reader that unfolds
  first, as this verifier and most mail programs do, turns
  `From<CRLF><TAB>: ceo@bank.example` (a _uniform_ CRLF block, so the header
  block's line-ending refusal above accepts it) into `From<TAB>: ...` and
  reads it as that same obsolete `From` form. The raw name this comparison
  reads still carries the CRLF and the tab; trimming them is what lets it
  still read that line as `From` — the same thing `String.trim()` did on
  `main` — so the growth guard refuses the extra instance instead of missing
  it.

  A name's two ends are not the only place a disguising byte can sit, and a
  name can need more than one kind of disguise at once. A byte outside
  0x21-0x7E placed _inside_ a name — `Fr<U+00AD>om:` (a soft hyphen),
  `From<NUL>x:` (a NUL) — survives the end-trim untouched and used to slip
  past both checks (issue #113), because they bucketed a header purely by its
  exact trimmed name and never noticed that a name they never asked about
  could still read, to a lenient mail program, as one they did. A first fix
  for that read the trimmed name two further ways, independently over the
  whole name — every such byte stripped out wherever it sits, and the name
  cut at the first one — but a name that needs both readings _at the same
  time_ defeated it: `Fr<U+00AD>om<NUL>x:` strips to `Fromx` and cuts to `Fr`,
  and neither is `from`.

  Both checks now instead walk the trimmed name once, building up the
  stripped prefix as they go, and test that prefix against `h=`'s names every
  time a run of padding bytes _begins_ — as if a lenient reader had silently
  swallowed the run and kept going — and once more after the whole name, as
  if it had read to the end; a match at either point counts the same as a
  match on the plain trimmed name. `Fr<U+00AD>om<NUL>x:` now matches at the
  NUL, because by then the walk has already absorbed the soft hyphen and its
  prefix reads `From`. Because the prefix only ever grows, the walk stops as
  soon as it is longer than the longest name in `h=` — no later point can
  match one either — which is what keeps the cost linear in the name's length
  rather than proportional to how many padding runs an attacker packs into
  it. A candidate is only ever compared against the names `h=` actually
  lists, so a genuine, unrelated, unsigned field with a stray byte in its name
  is untouched — but a plain, otherwise-ordinary field whose name starts with
  a signed name and then a padding byte is not: `Subject Line:` (the space is
  one of the padding bytes) or `To Name:` now count as an extra, unsigned
  instance of `subject` or `to` and are refused, where they verified on
  `main`. This is not a new trade this round invents — issue #113's own
  reproduction table lists exactly this shape, `Fr om:`, as one a lenient
  reader could read as `From` — it is stated here because a reader checking
  this file's claims against its behaviour should not have to discover it.
- **Both RSA key shapes import.** §3.6.1 says the `p=` tag holds a bare PKCS#1
  `RSAPublicKey`, which is what real selector records publish, but RFC 6376's own
  example record publishes a complete SubjectPublicKeyInfo. The envelope is
  detected, not guessed. `DkimPublicKey.keyBytes` therefore holds whatever the
  record carried — SPKI bytes for an SPKI `p=` — rather than a normalised form.
- **The work is bounded, because the sender is not trusted.** Four limits, each
  with a `reason` that names it: a message longer than `maxMessageLength` (10 MiB
  of octets) is refused before it is canonicalized, a message with more than
  `maxHeaderFields` (1 000) fields is refused before any signature is looked at,
  `maxSignedHeaderNames` (200) bounds the names one `h=` may list, and at most
  `maxSignatures` (10) `DKIM-Signature` fields are verified — §6.1 allows that
  one, and each extra field otherwise buys a key lookup and a public-key
  operation. Inside those limits every pass over the message is linear: twice the
  message costs about twice the time. Three things used to cost more than that,
  and all three are gone. Two backtracking regular expressions made the body
  canonicalizer quadratic — four times the time for twice the input, so a message
  an attacker sizes froze the process. The selection of signed headers did the
  same to the header block, by walking the whole `h=` list again for every
  distinct header name in the message. And the body itself used to be
  canonicalized and hashed once per `DKIM-Signature` field rather than once per
  distinct `(c=, l=)` combination, so a message with several signatures — up to
  `maxSignatures` of them — multiplied the one linear pass that scales with the
  body's size by however many fields shared it, even though real mail signs the
  body once (issue #88's third finding).
- **Several signatures are all verified, and the first valid one is the verdict.**
  §6.1 treats each field independently. A broken signature above a good one no
  longer condemns the message, and one an attacker prepends no longer decides it —
  but "valid" still only says _that domain signed it_, so a caller that cares
  whether the signer has anything to do with the `From:` address must compare
  `result.parsed.domain` itself. That comparison is DMARC alignment, which is out
  of scope here. `verifyDkim` reports the **first valid** signature, which on a
  mailing-list message is the list's rather than the author's, so a caller making
  that comparison should read every result from `verifyDkimSignatures` and look
  for the one whose domain lines up.
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
