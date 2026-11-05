/**
 * DKIM signature verification per RFC 6376.
 *
 * Pure verifier: given a raw RFC 5322 message and a DKIM public key it decides
 * whether the message's DKIM-Signature verifies against that key. It fetches
 * nothing on its own unless a caller injects a DNS TXT resolver.
 *
 * This file runs the verification and is the package's public entry point.
 * Each step lives in a sibling module of this same package, re-exported here:
 * `dkim-signature.ts` (parse the field), `dkim-canonicalize.ts`,
 * `dkim-key.ts` (key record and DNS lookup), `dkim-message.ts` (split the
 * message, refuse ambiguous header bytes), `dkim-headers.ts` (select signed
 * fields), `dkim-crypto.ts` (hash and signature check), `dkim-types.ts` and
 * `dkim-body-hash.ts`. Together they use Web Crypto (`crypto.subtle`),
 * platform primitives (`TextEncoder`), `@std/encoding` for base64 only,
 * and `resolveTxt` of `@spy4x/net/dns` for the default key lookup on Deno,
 * Node and Bun.
 *
 * ```ts
 * import { fetchDkimPublicKey, verifyDkim } from "@spy4x/email"
 *
 * // Key supplied by the caller — no permissions needed.
 * const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
 * const offline = await verifyDkim(rawMessage, key ?? undefined)
 *
 * // Key fetched from DNS by the default resolver — needs --allow-net.
 * const live = await verifyDkim(rawMessage)
 * if (!live.valid) console.warn(live.reason)
 * ```
 *
 * `rawMessage` may be a `string` or a `Uint8Array`. DKIM is defined over octets
 * (RFC 6376 §2.4), and a `string` cannot represent 8-bit content that is not
 * valid UTF-8 — decoding it as UTF-8 rewrites the bytes, and decoding it as
 * `latin1` actually runs windows-1252 and remaps 0x80-0x9F. Pass the raw bytes
 * for mail that might not be UTF-8; a `string` keeps working exactly as before,
 * UTF-8 encoded first. `maxMessageLength` and the message-too-large reason both
 * count octets, not UTF-16 code units, either way.
 *
 * ## What this verifies
 *
 * Given a raw RFC 5322 message and a DKIM public key, `verifyDkim` answers one
 * question: **does this message's `DKIM-Signature` verify against this key?**
 *
 * - Signature-header parsing (`parseDkimSignature`), including folded values.
 * - `simple` and `relaxed` canonicalization, for headers and for bodies.
 *   `canonicalizeHeader`, `canonicalizeBody`, `splitMessage`, `sha256Base64` and
 *   `refuseHeaderLineEndings` are deprecated: they are internal steps of
 *   `verifyDkim` and go in 2.0.
 * - The body hash (`bh=`), computed over the canonicalized body truncated to the
 *   `l=` bound when one is present, as RFC 6376 §3.7 step 1 requires. Canonicalized
 *   and hashed at most once per distinct `(c=, l=)` combination for the whole
 *   message, however many `DKIM-Signature` fields share it (§6.1 verifies every
 *   field independently, and most real mail signs the body once).
 * - `rsa-sha256` (RSASSA-PKCS1-v1_5) and `ed25519-sha256`, the latter signing
 *   `SHA-256` of the canonical input as RFC 8463 §3 requires.
 * - `parseDkimPublicKey` from a DNS TXT record, including revoked keys (`p=`).
 * - Expiry (`x=`) against an injectable clock, and that `x=` is later than `t=`.
 * - **That `h=` names `From`** (§6.1.1), and that the message has a `From` field to
 *   sign. A signature that does not cover `From` says nothing about who sent the
 *   mail, and this verifier used to call one valid.
 * - **That `d=` is the `i=` domain or a parent of it** (§6.1.1), and exactly `d=`
 *   when the key record carries `t=s`.
 * - **The key record's own tags** (§3.6.1): `v=` must be `DKIM1` and come first,
 *   `h=` must allow `sha256`, `s=` must name `email` or `*`, and `t=y` — the domain
 *   is only testing DKIM — never produces a valid verdict.
 * - **RSA keys of at least 1 024 bits** (RFC 8301 §3.2). A 512-bit key is refused
 *   however well its signature verifies. The bits are counted from the modulus
 *   itself: `CryptoKey.algorithm.modulusLength` reports an imported key's modulus
 *   rounded up to a whole byte, so a 1 023-bit key claims 1 024 there.
 * - **Every `DKIM-Signature` field**, not just the first (§6.1). `verifyDkim`
 *   reports the first valid one; `verifyDkimSignatures` returns one result per
 *   field, so a caller can see which domains signed.
 * - The header/body boundary, which RFC 5322 §2.2 puts at the **first** empty line.
 *   A body whose first line begins with SP or HTAB is body, not a folded header —
 *   reading it as a header left those octets outside the body hash entirely.
 * - **That the header block's line endings are uniform.** A block carrying a
 *   carriage return that no line feed follows is refused before a single field is
 *   parsed, and so is a block that ends some lines with CRLF and others with a bare
 *   LF. A block that uses a bare LF throughout keeps verifying: that is what mailbox
 *   storage produces, and RFC 6376's own example message is stored that way. **The
 *   body's line endings are a separate, looser rule:** only CRLF and a bare LF end a
 *   body line; a lone CR there is an ordinary octet, hashed as one, matching RFC
 *   6376 §3.4.3/§3.4.4 and how dkimpy and OpenDKIM canonicalize a body. A CR in the
 *   body cannot hide a header field, so the header block's stricter refusal has no
 *   reason to apply there — treating a lone CR as a line ending in the body used to
 *   disagree with every RFC-faithful signer on a body that legitimately carries one
 *   and reported it as tampered with (issue #94).
 * - **That the message did not grow an instance of a header the signature covers**
 *   (§5.4.2). A signer lists a name in `h=` as many times as the message carried it,
 *   so an instance left over after the pairing means the message gained one after
 *   signing. The trace fields in `TRANSIT_ADDED_HEADER_NAMES` are exempt, because a
 *   relay adds those on the way; every other name, `From` above all, is refused.
 * - The DKIM-Signature field **name the message actually spells**. §3.7 step 2
 *   hashes "the DKIM-Signature header field that exists", and under `simple`
 *   canonicalization the name's case is part of the signed bytes.
 *
 * Every result that hashed a body also carries `bodyCoverage`: how many canonical
 * octets the signature covers, how many the body has, and whether they are the same.
 * A signer may bound the body hash with `l=`, and with `l=0` the signature covers no
 * body at all — the verdict is still `valid`, because RFC 6376 §3.5 allows it, so
 * **a caller that shows the body to a person must check `bodyCoverage.complete`**.
 *
 * The signature input follows §3.7 step 2 exactly: every header named in `h=`, in
 * the order `h=` declares (so repeated fields are consumed from the bottom of the
 * header block upwards, §5.4.2), then the `DKIM-Signature` field with its `b=`
 * value deleted and **without a trailing CRLF**. Nothing follows that field — the
 * body hash the signer covered is the `bh=` tag inside it. Names in `h=` that match
 * no header in the message contribute nothing, as §3.5 allows.
 *
 * Correctness is checked against implementations other than this one: RFC 8463's
 * Appendix A.3 Ed25519 example, RFC 6376's example message signed with a known key,
 * eighteen messages built with dkimpy 1.1.8's canonicalizers plus OpenSSL, and five
 * signed by an OpenSSL-only script whose canonicalizer is written from the RFC text
 * (`openssl-*`: the §2.2 boundary cases and a lower-case field name). Every one is
 * confirmed by `openssl dgst -sha256 -verify` against the §3.7 reconstruction. See
 * `fixtures/SOURCES.md`, which also records what these vectors are _not_.
 *
 * ## What this does not do
 *
 * - **It does not fetch the key for you** unless you inject a resolver or accept
 *   the default one. The default is `resolveTxt` of `@spy4x/net/dns`, which works
 *   on Deno, Node and Bun and needs `--allow-net` on Deno. Everything in this package's own test suite runs through an
 *   injected resolver and therefore needs no permissions.
 * - **No DMARC, SPF, ARC or DKIM alignment.** A verified signature is not an
 *   authorized sender. DMARC needs `d=`/`i=` alignment against the visible `From:`
 *   field, which is a policy decision rather than a cryptographic one, and this
 *   package never inspects `From:` for that purpose.
 * - **No deliverability policy.** It does not decide what to do with a message
 *   that fails: no quarantine, no scoring, no reporting. That belongs in the
 *   caller.
 * - **No replay, freshness or `Received`-chain protection.** A valid signature
 *   stays valid unless `x=` says otherwise. `t=` is parsed, and the only rule
 *   applied to it is §3.5's: `x=` must be later than `t=` when both are present.
 *   Nothing here refuses a signature for being old.
 * - **No signature generation.** Verification only; there is no signer here.
 *
 * ## Injected resolver contract
 *
 * ```ts
 * interface DnsTxtResolver {
 *   resolveTxt: (name: string) => Promise<string[][]>
 * }
 *
 * interface DkimVerifyOptions {
 *   now?: bigint
 *   resolver?: DnsTxtResolver
 *   maxMessageLength?: number // default DEFAULT_MAX_MESSAGE_LENGTH, 10 MiB of octets
 *   maxSignatures?: number // default DEFAULT_MAX_SIGNATURES, 10
 *   maxHeaderFields?: number // default DEFAULT_MAX_HEADER_FIELDS, 1000
 *   maxSignedHeaderNames?: number // default DEFAULT_MAX_SIGNED_HEADER_NAMES, 200
 * }
 * ```
 *
 * - The queried name is `` `${selector}._domainkey.${domain}` ``.
 * - The shape is one array of strings per TXT record. RFC 6376 §3.6.2.2 requires a
 *   record's strings to be concatenated with no separator, and
 *   `fetchDkimPublicKey` does that before parsing.
 * - An empty answer throws `DkimParseError` rather than reporting a revoked key,
 *   so a broken resolver cannot be mistaken for a revoked key. A resolver
 *   rejection propagates out of `fetchDkimPublicKey` and becomes
 *   `result.reason` in `verifyDkim`.
 * - `p=` present but empty is a revoked key: `fetchDkimPublicKey` returns `null`
 *   and `verifyDkim` reports `"DKIM key revoked (p= is empty)"`.
 * - `publicKey` wins over `resolver` in `verifyDkim`: pass a key and no lookup
 *   happens at all.
 * - Several records come back for one name often enough — a domain publishes what it
 *   likes beside its key — so each is tried and the first that parses is the key.
 *   When none parses, the first record's own error is what the caller sees.
 * - `d=` and `s=` are checked against §3.1's grammar before the name is built, so a
 *   resolver that puts the name into a URL or a command line cannot be handed
 *   anything but letters, digits, hyphens and dots. Three spellings a verifier
 *   without that check would have looked up are refused with
 *   `"DKIM d= tag is not a domain name"` (or `s=`): an **underscore**
 *   (`s=sel_1`), a **trailing dot** (`d=example.com.`), and **non-ASCII letters**
 *   (`d=münchen.example`, which RFC 8616 permits — publish the A-label
 *   `xn--mnchen-3ya.example` instead). The check reads `d=` and `s=` separately, so
 *   the `_domainkey` label the lookup itself adds is unaffected, and ordinary
 *   selectors (`selector1`, `hs1-12345`, `2026`) are unaffected too.
 *
 * `verifyDkim` returns a result for every message-shaped failure — missing header,
 * bad grammar, expiry, unsigned `From`, body mismatch, unverifiable signature — and
 * for a resolver that throws, whose message becomes `result.reason`. Nothing escapes
 * it, which the docs used to deny.
 *
 * One consequence is worth knowing: the result says `valid: false` for a DNS lookup
 * that failed, and does not distinguish that from a signature that is wrong. RFC
 * 6376 §6.1.2 calls the first TEMPFAIL and the second PERMFAIL, and a caller that
 * needs to tell them apart should fetch the key itself with `fetchDkimPublicKey`,
 * which propagates the resolver's rejection instead of reporting it.
 *
 * ## Decisions a reviewer should weigh
 *
 * - **Errors are results, not exceptions.** A malformed message does not throw, so
 *   a caller cannot lose a diagnosis to a `catch`. `reason` distinguishes the
 *   cases and `parsed` is populated whenever the header parsed at all.
 * - **`l=` truncates the canonicalized body before hashing it.** §3.7 step 1 says
 *   the body is "truncated to the length specified in the l= tag", so a signature
 *   over 18 octets is only reproducible by hashing 18 octets. A bound _longer_ than
 *   the body it accompanies is **accepted**, although §3.5 says the signer "MUST
 *   NOT" use one: that MUST binds the signer, and verifier-side a bound can only
 *   ever _reduce_ the octets covered, never extend them, so accepting one cannot
 *   admit a message a shorter bound would have rejected (`dkimpy-l25` is `l=25`
 *   over an 18-octet body, and appending a single byte to it still fails). It is
 *   inside the signed field, so an attacker cannot add or enlarge it. Rejecting
 *   instead would convert a harmless signer tag into a false rejection.
 * - **An unsigned `From:` is refused.** §6.1.1: "If the 'h=' tag does not include
 *   the From header field, the Verifier MUST ignore the DKIM-Signature header field
 *   and return PERMFAIL (From field not signed)." An earlier revision of this file
 *   read §5.4 as binding the signer only and accepted such a signature, which is the
 *   first finding of issue #62: a message signed with `h=to:subject` kept a valid
 *   signature while its `From:` line was rewritten to any address at all. A message
 *   with no `From:` field is refused for the same reason — `h=from` over a message
 *   without one hashes nothing for it.
 * - **The DKIM-Signature field name comes from the message.** §3.7 step 2 hashes
 *   "the DKIM-Signature header field that exists", and `simple` preserves the
 *   name's case (§3.4.1), so the name is signed bytes: renaming the field to
 *   `dkim-signature:` fails a simple signature, and a signer that emitted the
 *   lower-case name verifies. Hashing a literal `"DKIM-Signature"` — as an earlier
 *   revision did — verified a renamed field against bytes the message no longer
 *   contained and rejected the lower-case signer. `relaxed` lower-cases the name
 *   (§3.4.2), so there the case carries no information and a renamed field still
 *   verifies.
 * - **`h=` may list `dkim-signature`, but never reaches the field being
 *   verified.** §3.5 forbids signing the field being created or verified, and §3.7
 *   adds that field to the header hash as its own step, so it is left out of the
 *   `h=` selection. Other `DKIM-Signature` fields are selected like any header:
 *   that is how a mailing list re-signs and covers the author's signature.
 * - **Tags after `b=` are verified, not refused.** §3.7 deletes only the _value_ of
 *   `b=`, so everything after it stays inside the signed bytes. A signature ending
 *   `…; b=SIG; x=1800000000` is valid and its `x=` is authenticated, and appending
 *   `; x=9999999999` or `; i=@attacker.invalid` to a genuine message changes the
 *   hashed field and fails. An earlier revision truncated the field at `b=` and
 *   claimed the tag was unprotected; that reasoning was wrong in both directions,
 *   and it rejected conformant mail.
 * - **A repeated tag is rejected.** §3.2 forbids duplicates. Silently keeping the
 *   last one let an attacker append `; b=<their own signature>` and win.
 * - **An unknown tag is ignored, whatever its value.** §3.2: "Unrecognized tags
 *   MUST be ignored." Real signatures carry them (`r=`, `dt=`). An earlier revision
 *   rejected `dt=` with any value but `1` — an invented rule this file documented as
 *   an ignored tag, and a rule no test could reach.
 * - **Unfolding deletes the line ending, it does not turn it into a space.**
 *   §3.4.2 unfolds by removing the CRLF and then compressing the WSP that followed
 *   it, so `one<CRLF><HTAB>two` canonicalizes to `one two` and `a<LF>b` to `ab`.
 *   A bare LF inside a value is not a line ending (RFC 5322 §2.3): `simple` keeps
 *   it byte for byte, `relaxed` deletes it as part of unfolding. A lone CR
 *   survives both modes, at the ends of the value as much as in the middle:
 *   §3.4.2 unfolds CRLF only, and the relaxed path trims the ends of the value
 *   with WSP only — SP and HTAB, RFC 5234's own definition, via a hand-written
 *   `trimWsp` rather than `String.trim()`. An earlier revision used `trim()`
 *   there, for which CR is whitespace, so a leading or trailing lone CR was
 *   stripped by `relaxed` and kept by `simple`; that asymmetry is gone. It
 *   mattered once this file could handle raw octets rather than decoded text
 *   (see `verifyDkim`'s `Uint8Array` support): `trim()` also strips U+00A0, so a
 *   raw UTF-8 value ending in the byte 0xA0 — the second byte of "à" (0xC3 0xA0)
 *   — would have lost that byte under relaxed canonicalization. Body handling no
 *   longer normalises a lone CR at all — see the body line-endings paragraph
 *   above.
 * - **A header block with a lone carriage return is refused outright.** This is the
 *   first finding of issue #88, and what it costs to get wrong is a forged sender.
 *   Readers do not agree on whether a bare CR ends a line: this verifier keeps the
 *   CR inside the value it sits in, so a message carrying
 *   `X-Note: a<CR>From: ceo@bank.example` above a signed block has one `From:` here
 *   — the genuine one, which the signature covers — and two in a client that breaks
 *   the line, where the forged one is what a person reads. The verdict was `valid`
 *   and the sender shown was not the sender signed for. Guessing which reading is
 *   right is not available to a verifier, so the message is refused with a reason
 *   that names the problem, and a block that mixes CRLF with bare LF is refused for
 *   the same reason: it has already passed through something that rewrote line
 *   endings, and which ending a later reader honours is again a guess. A block that
 *   is uniformly bare LF is **accepted**, because refusing it would reject ordinary
 *   mail out of a mailbox — the alternative reading of the issue's checkbox, "refuse
 *   every bare LF", turns RFC 6376's own example message invalid. The rule covers
 *   the header block only; a carriage return in the body cannot hide a header field.
 * - **A header block carrying LF, CR, a vertical tab, a form feed, a
 *   file/group/record separator, NEL or a Unicode line/paragraph separator — as
 *   any UTF-8 packing, minimal or overlong, of any length from 2 to 6 bytes —
 *   is refused outright.** Issue #121, the same shape as the lone-CR rule
 *   above for a wider set of code points: `X-Note: a<FF>From: ceo@bank.example`
 *   above a signed block hides a second `From:` from this verifier the way the
 *   CR form does, behind a byte some reader still treats as ending the line.
 *   No conformant _sender_ emits any of these code points in a header value.
 *   RFC 5322 §4.1 puts VT, FF and 0x1C-0x1E only in the _obsolete_ syntax a
 *   generator "MUST NOT" produce, and 0x85/U+2028/U+2029 are not ASCII at all
 *   — RFC 6532 is what lets a header value carry them, as UTF-8. So refusing
 *   all of them, anywhere in the block, is the safe direction rather than a
 *   free one.
 *
 *   The rule is generated from ten code points — LF, CR, VT, FF, the
 *   file/group/record separators, NEL, and U+2028/U+2029 — rather than
 *   hand-listed as byte sequences, because two review rounds each found the
 *   hand-picked list still had gaps. Round 1: an earlier draft exempted 0x85
 *   whenever it looked like a UTF-8 continuation byte of a longer character
 *   (`Å` is C3 85, `ą` is C4 85), on the theory that a reader decoding the
 *   block as UTF-8 would never mistake it for NEL — wrong, because a reader is
 *   not obliged to decode as UTF-8 at all, and one that decodes header octets
 *   as Latin-1, or falls back to it the moment it meets one byte that is not
 *   valid UTF-8, reads a bare 0x85 as NEL regardless of what bytes sit next to
 *   it. Round 2: refusing only the minimal and one-step-overlong UTF-8 form of
 *   U+2028/U+2029 left every other overlong packing open, and, worse, left LF
 *   and CR themselves reachable the same way — `C0 8A` is an overlong 2-byte
 *   UTF-8 encoding of LF, so a decoder that does not enforce the shortest-form
 *   rule reads it as a line break even though the raw byte 0x0A never appears
 *   in the message at all, which is invisible to the CR/LF uniformity check
 *   above.
 *
 *   So every 2-to-6-byte UTF-8 packing of every one of the ten code points is
 *   generated and refused: the classic FSS-UTF byte shapes (an `n`-byte form
 *   reserves `n` one-bits and a zero separator bit in its lead byte, 6 payload
 *   bits in each of the other `n - 1` bytes), skipping only a length too small
 *   to hold the code point without corrupting its own marker bits. LF and CR's
 *   _raw_ single-byte form stays legitimate, necessary content — every header
 *   line ends in one — governed by the CR/LF uniformity check above instead;
 *   only their multi-byte (inherently overlong) packings are refused here. The
 *   other five single-byte code points, plus NEL's own two-byte minimal UTF-8
 *   form (`C2 85`), are refused directly, with no exemption for context, which
 *   has a real cost: a genuine RFC 6532 (SMTPUTF8) header value whose UTF-8
 *   encoding happens to contain 0x85 — `Å` (C3 85), `ą` (C4 85), `久` (E4 B9
 *   85), `😅` (F0 9F 98 85) — is refused too, and so is a raw windows-1252
 *   ellipsis (`…`, byte 0x85) in an 8-bit header nobody encoded as UTF-8 at
 *   all. An RFC 2047-encoded value (`=?UTF-8?B?w4U=?=` for `Å`) is untouched,
 *   because every one of its octets is printable ASCII. A `string` input can
 *   only ever produce a minimal UTF-8 form, never an overlong one, because
 *   `TextEncoder` never emits one; overlong packings only ever reach this
 *   verifier through the `Uint8Array` path.
 * - **Trace fields a relay adds are exempt from the §5.4.2 growth check.** The check
 *   refuses a message that still holds an instance of a name `h=` asked for, which is
 *   how a prepended second `From:` or `Subject:` is caught — it must not be removed,
 *   and removing it makes those forgeries verify again. It did, however, refuse
 *   ordinary forwarded mail: every hop prepends its own `Received:`, so a signature
 *   covering `Received` broke the moment the mail was forwarded. The names in
 *   `TRANSIT_ADDED_HEADER_NAMES` — `received`, `x-received`, `return-path`,
 *   `delivered-to`, `authentication-results`, `resent-*` and `arc-*` — are therefore
 *   exempt, and no others. What makes a name belong there is that a later hop
 *   prepends it by design, so a message that carries one more of it than the signer
 *   signed is ordinary mail and not a forgery. It is **not** that a person never sees
 *   these fields — `Resent-From` is on the list and some mail clients display it as
 *   the sender. It is there because a redirect prepends a fresh `Resent-*` block
 *   exactly the way a relay prepends a `Received:` field, and a verifier that
 *   implements RFC 6376 and nothing more accepts that message as well, having no
 *   growth check at all. A signer who wants one of these names protected has the
 *   remedy §5.4 gives for it: list the name in `h=` once more than the message
 *   carries it. The oversigned instance is still hashed, so a message that gained a
 *   field of that name fails the signature. The exemption does not change which
 *   bytes are hashed: §5.4.2
 *   pairs `h=` with the message from the bottom up and a relay prepends, so the
 *   instances selected are still the ones the signer signed, and altering a signed
 *   `Received:` still fails the signature. The list is exported so the choice is
 *   visible, and a caller who disagrees can see exactly what it admits.
 *
 *   Both this check and the unsigned-`From` check compare a header **name**
 *   loosely on purpose: every octet outside printable ASCII (0x21-0x7E) is
 *   trimmed from both ends of the name before it is compared (`trimHeaderName`),
 *   so `From\x0B:` and `From` padded with a no-break space, a byte order mark, a
 *   zero-width space or a C0 control character all still count as `from`. A
 *   client that reads the field the same loose way would display the forged
 *   address, so refusing to match it here would be the unsafe choice. RFC 5322's
 *   `ftext` already restricts a genuine field name to this same range, so
 *   trimming anything outside it can only make a disguised name easier to
 *   recognise, never harder — an earlier revision trimmed a narrower, explicit
 *   byte set copied from what `String.prototype.trim()` stripped, which missed
 *   several of `trim()`'s own Unicode whitespace characters (found in round 1
 *   review of the pull request that added it) and every control character and
 *   zero-width space RFC 5322 never allows in a name either (issue #106). This
 *   also means CR and LF are trimmed now, which is load-bearing rather than a
 *   side effect: RFC 5322 does not let a field name fold before its own colon —
 *   the obsolete syntax it does allow there is plain spaces and tabs,
 *   `obs-from = "From" *WSP ":"` — but unfolding is defined as deleting every
 *   CRLF immediately followed by WSP wherever it sits, so a reader that unfolds
 *   first, as this verifier and most mail programs do, turns
 *   `From<CRLF><TAB>: ceo@bank.example` (a _uniform_ CRLF block, so the header
 *   block's line-ending refusal above accepts it) into `From<TAB>: ...` and
 *   reads it as that same obsolete `From` form. The raw name this comparison
 *   reads still carries the CRLF and the tab; trimming them is what lets it
 *   still read that line as `From` — the same thing `String.trim()` did on
 *   `main` — so the growth guard refuses the extra instance instead of missing
 *   it.
 *
 *   A name's two ends are not the only place a disguising byte can sit, and a
 *   name can need more than one kind of disguise at once. A byte outside
 *   0x21-0x7E placed _inside_ a name — `Fr<U+00AD>om:` (a soft hyphen),
 *   `From<NUL>x:` (a NUL) — survives the end-trim untouched and used to slip
 *   past both checks (issue #113), because they bucketed a header purely by its
 *   exact trimmed name and never noticed that a name they never asked about
 *   could still read, to a lenient mail program, as one they did. A first fix
 *   for that read the trimmed name two further ways, independently over the
 *   whole name — every such byte stripped out wherever it sits, and the name
 *   cut at the first one — but a name that needs both readings _at the same
 *   time_ defeated it: `Fr<U+00AD>om<NUL>x:` strips to `Fromx` and cuts to `Fr`,
 *   and neither is `from`.
 *
 *   Both checks now instead walk the trimmed name once, building up the
 *   stripped prefix as they go, and test that prefix against `h=`'s names every
 *   time a run of padding bytes _begins_ — as if a lenient reader had silently
 *   swallowed the run and kept going — and once more after the whole name, as
 *   if it had read to the end; a match at either point counts the same as a
 *   match on the plain trimmed name. `Fr<U+00AD>om<NUL>x:` now matches at the
 *   NUL, because by then the walk has already absorbed the soft hyphen and its
 *   prefix reads `From`. Because the prefix only ever grows, the walk stops as
 *   soon as it is longer than the longest name in `h=` — no later point can
 *   match one either — which is what keeps the cost linear in the name's length
 *   rather than proportional to how many padding runs an attacker packs into
 *   it. A candidate is only ever compared against the names `h=` actually
 *   lists, so a genuine, unrelated, unsigned field with a stray byte in its name
 *   is untouched — but a plain, otherwise-ordinary field whose name starts with
 *   a signed name and then a padding byte is not: `Subject Line:` (the space is
 *   one of the padding bytes) or `To Name:` now count as an extra, unsigned
 *   instance of `subject` or `to` and are refused, where they verified on
 *   `main`. This is not a new trade this round invents — issue #113's own
 *   reproduction table lists exactly this shape, `Fr om:`, as one a lenient
 *   reader could read as `From` — it is stated here because a reader checking
 *   this file's claims against its behaviour should not have to discover it.
 *
 *   This is also why an mbox file's envelope line —
 *   `From sender@example.com Mon Sep 21 10:00:00 2026`, the line mbox storage
 *   puts in front of every message it holds — is refused (issue #120). That
 *   line is not RFC 5322 at all: it has no colon before its first space, so this
 *   verifier reads it as a header field literally named `From sender@example.com
 *   Mon Sep 21 10` (the first colon sits inside the timestamp), and the loose
 *   match above reads that name's `From` prefix, at the first space, as a
 *   second, unsigned `From:`. Nothing here parses mbox framing, so a caller
 *   verifying a message straight out of an mbox file must strip the envelope
 *   line before calling `verifyDkim` — a message that still carries it is
 *   refused as a forged sender rather than silently accepted or silently
 *   stripped.
 *
 *   The refusal depends on that colon existing somewhere in the line, which is
 *   why the wording above is exact about it rather than saying "the envelope
 *   line": `From sender@example.com Mon Sep 21 2026`, a timestamp with no
 *   `HH:MM:SS` and so no colon anywhere in the line, is _not_ refused — there
 *   is then no colon at all before the next header's own, so this verifier
 *   reads the whole line as one header field literally named `From
 *   sender@example.com Mon Sep 21 2026` with an empty value, which is not
 *   `From` under any reading and never enters the loose match at all. That is
 *   not a gap this rule needs to close: no mail client displays this line as a
 *   sender either way, colon or not, so a caller still has to strip it before
 *   verifying — this paragraph documents what the current checks do with an
 *   unstripped one, not a promise to catch every shape it can take.
 * - **Both RSA key shapes import.** §3.6.1 says the `p=` tag holds a bare PKCS#1
 *   `RSAPublicKey`, which is what real selector records publish, but RFC 6376's own
 *   example record publishes a complete SubjectPublicKeyInfo. The envelope is
 *   detected, not guessed. `DkimPublicKey.keyBytes` therefore holds whatever the
 *   record carried — SPKI bytes for an SPKI `p=` — rather than a normalised form.
 * - **The work is bounded, because the sender is not trusted.** Four limits, each
 *   with a `reason` that names it: a message longer than `maxMessageLength` (10 MiB
 *   of octets) is refused before it is canonicalized, a message with more than
 *   `maxHeaderFields` (1 000) fields is refused before any signature is looked at,
 *   `maxSignedHeaderNames` (200) bounds the names one `h=` may list, and at most
 *   `maxSignatures` (10) `DKIM-Signature` fields are verified — §6.1 allows that
 *   one, and each extra field otherwise buys a key lookup and a public-key
 *   operation. Inside those limits every pass over the message is linear: twice the
 *   message costs about twice the time. Three things used to cost more than that,
 *   and all three are gone. Two backtracking regular expressions made the body
 *   canonicalizer quadratic — four times the time for twice the input, so a message
 *   an attacker sizes froze the process. The selection of signed headers did the
 *   same to the header block, by walking the whole `h=` list again for every
 *   distinct header name in the message. And the body itself used to be
 *   canonicalized and hashed once per `DKIM-Signature` field rather than once per
 *   distinct `(c=, l=)` combination, so a message with several signatures — up to
 *   `maxSignatures` of them — multiplied the one linear pass that scales with the
 *   body's size by however many fields shared it, even though real mail signs the
 *   body once (issue #88's third finding).
 * - **Several signatures are all verified, and the first valid one is the verdict.**
 *   §6.1 treats each field independently. A broken signature above a good one no
 *   longer condemns the message, and one an attacker prepends no longer decides it —
 *   but "valid" still only says _that domain signed it_, so a caller that cares
 *   whether the signer has anything to do with the `From:` address must compare
 *   `result.parsed.domain` itself. That comparison is DMARC alignment, which is out
 *   of scope here. `verifyDkim` reports the **first valid** signature, which on a
 *   mailing-list message is the list's rather than the author's, so a caller making
 *   that comparison should read every result from `verifyDkimSignatures` and look
 *   for the one whose domain lines up.
 * - **`b=` need not be the last tag, in either mode.** §3.7 step 2 deletes only the
 *   _value_ of `b=`, bounded by the value's parsed offsets, so the deletion is
 *   byte-exact wherever the tag sits; a field ending `…; b=SIG; x=1800000000`
 *   verifies under `simple` as well as `relaxed` and its `x=` is authenticated
 *   (`dkimpy-unsigned-trailing-tag`). An earlier revision refused that shape, on the
 *   false premise that a non-final `b=` could not be emptied without rebuilding the
 *   header.
 *
 * ## What the suite does not cover
 *
 * - **No real mail.** Every fixture is synthetic. A message from a production
 *   signer would test more, and none is available offline.
 * - **The printed §3.5 signature is not reproduced.** Its private key is
 *   unpublished, so the RFC's actual signature cannot be verified by anyone; what
 *   is tested is the RFC's example message signed with a known key.
 * - **Negative coverage is a matrix, not a proof.** Tampering is tested across both
 *   modes and both algorithms (body, signed header, signature byte, removed header,
 *   wrong key), which is stronger than one case per path but still finite.
 *
 * @module
 */

import { type BodyHashCache, createBodyHashCache } from "./dkim-body-hash.ts"
import { canonicalizeBody, canonicalizeHeader } from "./dkim-canonicalize.ts"
import {
  binaryStringToBytes,
  bytesToBinaryString,
  sha256Base64,
  verifySignature,
} from "./dkim-crypto.ts"
import { headerNameMatches, selectSignedHeaders, trimHeaderName } from "./dkim-headers.ts"
import { fetchDkimPublicKey } from "./dkim-key.ts"
import { refuseHeaderLineEndings, splitMessage } from "./dkim-message.ts"
import { deleteTagValue, parseDkimSignatureHeader } from "./dkim-signature.ts"
import {
  DEFAULT_MAX_HEADER_FIELDS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DEFAULT_MAX_SIGNED_HEADER_NAMES,
  type DkimBodyCoverage,
  type DkimPublicKey,
  type DkimSignatureHeader,
  type DkimVerificationResult,
  type DkimVerifyOptions,
} from "./dkim-types.ts"

export type {
  Canonicalization,
  DkimAlgorithm,
  DkimBodyCoverage,
  DkimKeyAlgorithm,
  DkimPublicKey,
  DkimSignatureHeader,
  DkimVerificationResult,
  DkimVerifyOptions,
  DnsTxtResolver,
} from "./dkim-types.ts"
export {
  DEFAULT_MAX_HEADER_FIELDS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DEFAULT_MAX_SIGNED_HEADER_NAMES,
  DkimParseError,
  MIN_RSA_KEY_BITS,
} from "./dkim-types.ts"
export { parseDkimSignature } from "./dkim-signature.ts"
export { canonicalizeBody, canonicalizeHeader } from "./dkim-canonicalize.ts"
export { fetchDkimPublicKey, parseDkimPublicKey } from "./dkim-key.ts"
export { refuseHeaderLineEndings, splitMessage } from "./dkim-message.ts"
export { TRANSIT_ADDED_HEADER_NAMES } from "./dkim-headers.ts"
export { sha256Base64 } from "./dkim-crypto.ts"

/**
 * Verify a message's DKIM signatures and report one verdict.
 *
 * A message may carry several `DKIM-Signature` fields, and RFC 6376 §6.1 treats
 * them independently: the message is signed by any one of them that verifies.
 * This returns the first valid result, and the first signature's diagnosis when
 * none is valid — so a broken signature above a good one no longer condemns the
 * message, and a signature an attacker prepends no longer decides it either.
 * {@link verifyDkimSignatures} returns all of them when a caller needs to know
 * which domains signed.
 *
 * When `publicKey` is omitted the key is fetched from `options.resolver`,
 * defaulting to `resolveTxt` of `@spy4x/net/dns`, which needs `--allow-net` on
 * Deno.
 *
 * `rawMessage` may be a `string` or a `Uint8Array`. DKIM is defined over
 * octets (RFC 6376 §2.4: "the entire, unaltered message body, including any
 * MIME framing"), and a JavaScript string cannot represent an 8-bit body
 * faithfully — decoding it as UTF-8 rewrites bytes outside that encoding, and
 * decoding it as `latin1` actually runs windows-1252 and remaps 0x80-0x9F.
 * Pass the raw bytes for mail that might not be UTF-8; a `string` keeps
 * working exactly as before, UTF-8 encoded first.
 *
 * Message-shaped failures — missing header, bad grammar, expired signature,
 * unsigned `From`, body mismatch, unverifiable signature — all come back as a
 * {@link DkimVerificationResult}, and so does a resolver that throws: its message
 * becomes the reason. Nothing escapes, which means a DNS failure and a wrong
 * signature look alike here; a caller that needs RFC 6376 §6.1.2's TEMPFAIL and
 * PERMFAIL apart should fetch the key with {@link fetchDkimPublicKey}, which
 * propagates the resolver's rejection.
 */
export async function verifyDkim(
  rawMessage: string | Uint8Array,
  publicKey?: DkimPublicKey,
  options: DkimVerifyOptions = {},
): Promise<DkimVerificationResult> {
  const results = await verifyDkimSignatures(rawMessage, publicKey, options)
  return results.find((result) => result.valid) ?? results[0]
}

/**
 * Verify every `DKIM-Signature` field in the message and return one result each,
 * in the order the fields appear.
 *
 * The list is never empty: a message with no signature at all produces the single
 * "no DKIM-Signature header found" result, and so does a message longer than
 * {@link DkimVerifyOptions.maxMessageLength} or one whose header block fails
 * {@link refuseHeaderLineEndings}. Fields past
 * {@link DkimVerifyOptions.maxSignatures} get a result saying they were not
 * checked, rather than disappearing.
 *
 * See {@link verifyDkim} for `rawMessage`'s `string | Uint8Array` contract.
 */
export async function verifyDkimSignatures(
  rawMessage: string | Uint8Array,
  publicKey?: DkimPublicKey,
  options: DkimVerifyOptions = {},
): Promise<DkimVerificationResult[]> {
  // Every octet, header scan and canonicalization step below works on one
  // byte-exact string — one UTF-16 code unit per octet — whether the caller
  // passed a `string` or a `Uint8Array`. A `string` is UTF-8 encoded first,
  // which is what this verifier hashed all along; that also makes the size
  // cap below count octets rather than code units, matching what §2.4 and
  // §3.7 size a message and a body in.
  const octets = typeof rawMessage === "string" ? new TextEncoder().encode(rawMessage) : rawMessage

  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
  if (octets.length > maxMessageLength) {
    return [{
      valid: false,
      reason: `message is ${octets.length} octets, over the ` +
        `${maxMessageLength}-octet limit`,
    }]
  }

  // A pure-ASCII string round-trips through UTF-8 as itself — every code unit
  // is already its own octet — so rebuilding it byte by byte below would only
  // waste a second linear pass over the whole message. `octets.length ===
  // rawMessage.length` holds exactly then: any non-ASCII character encodes to
  // more than one octet, which can only make the encoded form longer.
  const raw = typeof rawMessage === "string" && octets.length === rawMessage.length
    ? rawMessage
    : bytesToBinaryString(octets)

  // Before any field is parsed: a header block whose line endings are not uniform
  // does not have one reading, and this verifier's reading is the one an attacker
  // gets to choose against. See `refuseHeaderLineEndings`.
  const lineEndings = refuseHeaderLineEndings(raw)
  if (lineEndings !== undefined) {
    return [{ valid: false, reason: lineEndings }]
  }

  const { headers, body } = splitMessage(raw)
  const maxHeaderFields = options.maxHeaderFields ?? DEFAULT_MAX_HEADER_FIELDS
  if (headers.length > maxHeaderFields) {
    return [{
      valid: false,
      reason: `message has ${headers.length} header fields, over the ` +
        `${maxHeaderFields}-field limit`,
    }]
  }
  // Every signature is verified, not just the first: a broken one above a good
  // one used to condemn the whole message, and a valid one an attacker put on top
  // used to decide it. Each field's value keeps its exact bytes, so the canonical
  // form reconstructed for hashing matches what that signer saw.
  // The name is compared trimmed, as `selectSignedHeaders` compares it: RFC 5322's
  // obsolete syntax allows WSP before the colon, so `DKIM-Signature :` is a field.
  const fields: number[] = []
  headers.forEach((line, index) => {
    const colon = line.indexOf(":")
    if (colon === -1) return
    if (trimHeaderName(line.slice(0, colon)).toLowerCase() === "dkim-signature") fields.push(index)
  })
  if (fields.length === 0) {
    return [{ valid: false, reason: "no DKIM-Signature header found" }]
  }

  // One cache for the whole message: RFC 6376 §6.1 verifies every signature
  // field independently, and most real messages sign the body once — the same
  // `c=` and `l=` — no matter how many `DKIM-Signature` fields they carry. See
  // `dkim-body-hash.ts` for why splitting this out gave the caching seam a
  // name a test could reach without widening the package's exports.
  const bodyHashCache = createBodyHashCache({
    canonicalize: (algorithm) => canonicalizeBody(body, algorithm),
    encode: binaryStringToBytes,
    digest: (bytes) => sha256Base64(bytes),
  })

  const maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES
  const results: DkimVerificationResult[] = []
  for (const [index, at] of fields.entries()) {
    // §6.1: a verifier may limit how many signatures it tries. Without a limit,
    // every extra field buys an attacker one key lookup and one public-key
    // operation.
    if (index >= maxSignatures) {
      results.push({
        valid: false,
        reason: `not verified: only the first ${maxSignatures} DKIM-Signature ` +
          `fields of a message are checked`,
      })
      continue
    }
    // §3.5: the field being verified is never one of the headers h= selects, so
    // an h= that names `dkim-signature` reaches only the other signatures.
    const others = headers.filter((_, i) => i !== at)
    results.push(await verifyOneSignature(headers[at], others, publicKey, options, bodyHashCache))
  }
  return results
}

async function verifyOneSignature(
  dkimHeaderLine: string,
  headers: string[],
  publicKey: DkimPublicKey | undefined,
  options: DkimVerifyOptions,
  bodyHashCache: BodyHashCache,
): Promise<DkimVerificationResult> {
  // §3.7 step 2 hashes "the DKIM-Signature header field that exists" in the
  // message, so the field name is taken from the message rather than assumed.
  // Under `simple` canonicalization the name's case is part of the hashed
  // bytes: hashing a literal "DKIM-Signature" verified a field renamed to
  // `dkim-signature:`, i.e. bytes the message no longer contained, and rejected
  // a signer that emitted the lower-case name.
  const dkimFieldName = dkimHeaderLine.slice(0, dkimHeaderLine.indexOf(":"))
  const dkimRaw = dkimHeaderLine.slice(dkimFieldName.length + 1)
  if (dkimRaw.trim() === "") {
    return { valid: false, reason: "DKIM-Signature header is empty" }
  }

  let parsed: DkimSignatureHeader
  try {
    const field = parseDkimSignatureHeader(dkimRaw)
    parsed = field.header
  } catch (err) {
    return { valid: false, reason: errorMessage(err) }
  }

  const refusal = refuseSignatureHeader(parsed, headers, options)
  if (refusal !== undefined) return { valid: false, parsed, reason: refusal }

  let key = publicKey
  if (!key) {
    try {
      const fetched = await fetchDkimPublicKey(
        parsed.domain,
        parsed.selector,
        options,
      )
      if (fetched === null) {
        return {
          valid: false,
          parsed,
          reason: "DKIM key revoked (p= is empty)",
        }
      }
      key = fetched
    } catch (err) {
      return { valid: false, parsed, reason: errorMessage(err) }
    }
  }

  const keyRefusal = refuseKeyRecord(key, parsed)
  if (keyRefusal !== undefined) return { valid: false, parsed, reason: keyRefusal }

  let signedHeaders: { name: string; value: string }[]
  let computedBodyHash: string
  let bodyCoverage: DkimBodyCoverage
  try {
    signedHeaders = selectSignedHeaders(headers, parsed.signedHeaders)
    // §3.7 step 1: the body is hashed "canonicalized using the body
    // canonicalization algorithm specified in the c= tag and then truncated to
    // the length specified in the l= tag". The bound counts canonical *octets*,
    // so the truncation happens on encoded bytes, not on `String.prototype.slice`
    // — which counts UTF-16 code units and, before every octet here was already
    // byte-exact, diverged from octets at the first non-ASCII character and
    // falsely rejected valid non-ASCII mail. The bound may also land inside a
    // multi-octet character, which is what rules out decoding the sliced bytes
    // back to a string: U+FFFD would be hashed in place of the declared octets.
    // A bound longer than the body it accompanies is not an error: the slice
    // then covers all of it, which is what a signer that declared a longer bound
    // produced.
    //
    // `bodyHashCache` does the canonicalizing and hashing, at most once per
    // `(c=, l=)` combination for the whole message — see `dkim-body-hash.ts`
    // and issue #88's third finding: verifying this per signature field, as an
    // earlier revision did, cost one full canonicalize-and-hash pass over the
    // body for every `DKIM-Signature` field, so a message with several of them
    // multiplied the one thing here that scales with the body's size.
    const hashed = await bodyHashCache.get(parsed.canonicalization.body, parsed.bodyLength)
    computedBodyHash = hashed.hash
    bodyCoverage = {
      signedOctets: hashed.signedOctets,
      totalOctets: hashed.totalOctets,
      complete: hashed.signedOctets === hashed.totalOctets,
    }
  } catch (err) {
    return { valid: false, parsed, reason: errorMessage(err) }
  }

  // Neither side of this comparison is a secret — `computedBodyHash` is derived
  // from the public message body, and `parsed.bodyHash` is copied straight out
  // of the `bh=` tag the sender put on the wire — so a plain compare needs no
  // constant-time treatment: there is nothing here a timing channel could leak
  // that the message itself does not already show. #71's constant-time copy
  // that used to sit here is removed, not moved to a shared home.
  if (computedBodyHash !== parsed.bodyHash) {
    return {
      valid: false,
      parsed,
      reason: "body hash mismatch (body modified after signing)",
      computedBodyHash,
      bodyCoverage,
    }
  }

  // Signature input, §3.7 step 2, assembled in one place so there is no second
  // copy of the field to drift:
  //   1. every header named in h=, in h= order, each terminated by one CRLF;
  //   2. the DKIM-Signature field with its b= value deleted, canonicalized, and
  //      *without a trailing CRLF*.
  let canonicalInput: string
  try {
    const signedParts = signedHeaders.map(({ name, value }) =>
      canonicalizeHeader(name, value, parsed.canonicalization.header)
    )
    const signatureField = canonicalizeHeader(
      dkimFieldName,
      deleteTagValue(dkimRaw, "b"),
      parsed.canonicalization.header,
    ).replace(/\r\n$/, "")
    // Nothing follows the DKIM-Signature field: §3.7 step 2 hashes the field
    // bare, and the body hash the signer covered is the `bh=` tag inside that
    // very field. Appending it here would hash 44 bytes no signer hashed, and
    // every externally produced signature failed.
    canonicalInput = signedParts.join("") + signatureField
  } catch (err) {
    return { valid: false, parsed, reason: errorMessage(err), computedBodyHash, bodyCoverage }
  }

  let verified: boolean
  try {
    verified = await verifySignature(parsed, canonicalInput, key)
  } catch (err) {
    return {
      valid: false,
      parsed,
      reason: errorMessage(err),
      computedBodyHash,
      bodyCoverage,
    }
  }

  return {
    valid: verified,
    parsed,
    computedBodyHash,
    computedInputPreview: canonicalInput.slice(0, 240),
    bodyCoverage,
    reason: verified ? undefined : "signature did not verify against public key",
  }
}

/**
 * The checks RFC 6376 §6.1.1 puts on the signature header itself, before a key
 * is fetched. Returns the reason to refuse, or `undefined` to carry on.
 *
 * Every one of these is a MUST in the standard, and the first is the one this
 * verifier shipped without: a signature whose `h=` never names `From` binds
 * nothing to the address a person reads, so rewriting `From` left the signature
 * valid and the mail was accepted as coming from whoever the attacker liked.
 */
function refuseSignatureHeader(
  parsed: DkimSignatureHeader,
  headers: string[],
  options: DkimVerifyOptions,
): string | undefined {
  // The work a signature can ask for is bounded before any of it is done: the
  // selection below walks h= once per name, and h= comes from the sender.
  const maxSignedHeaderNames = options.maxSignedHeaderNames ?? DEFAULT_MAX_SIGNED_HEADER_NAMES
  if (parsed.signedHeaders.length > maxSignedHeaderNames) {
    return `h= names ${parsed.signedHeaders.length} headers, over the ` +
      `${maxSignedHeaderNames}-name limit`
  }

  // §6.1.1: "If the 'h=' tag does not include the From header field, the Verifier
  // MUST ignore the DKIM-Signature header field and return PERMFAIL (From field
  // not signed)."
  if (!parsed.signedHeaders.includes("from")) {
    return "From field not signed (h= does not name from)"
  }
  // §5.4 requires the From field to be signed, which a message that has no From
  // field cannot satisfy: `h=from` over a message with no From hashes nothing for
  // it, so the signature would say nothing about the author either. The name is
  // read through `headerNameMatches`, not a plain end-trimmed comparison, so a
  // line whose only "From" is disguised inside the name still counts as present
  // here (issue #113) — this check only ever widens what counts as an instance
  // to reject; `selectSignedHeaders`' own #113 guard is what actually refuses
  // such a line, whether or not a genuine `From:` sits elsewhere in the message.
  // A line with no colon at all is not a header field this verifier can name —
  // `line.indexOf(":")` is `-1`, and `line.slice(0, -1)` would drop only that
  // line's last character rather than naming the whole line, which let an mbox
  // `From sender Mon Sep …` envelope line (no colon, and `From` padded by the
  // space that follows it) count as a `From` field being present. Skipping a
  // colon-less line here is what a real field-name comparison would do anyway.
  if (
    !headers.some((line) => {
      const colon = line.indexOf(":")
      return colon !== -1 && headerNameMatches(line.slice(0, colon), "from")
    })
  ) {
    return "From field not signed (the message has no From field)"
  }

  // §6.1.1: "Verifiers MUST confirm that the domain specified in the 'd=' tag is
  // the same as or a parent domain of the domain part of the 'i=' tag."
  const identityDomain = signerIdentityDomain(parsed)
  if (identityDomain !== undefined && !isSameOrParentDomain(parsed.domain, identityDomain)) {
    return `i= domain ${identityDomain} is not d= (${parsed.domain}) or a subdomain of it`
  }

  // §3.5 on x=: "The value of the 'x=' tag MUST be greater than the value of the
  // 't=' tag if both are present." A signature that expires before it was made
  // covers no window at all.
  if (
    parsed.expiration !== undefined && parsed.timestamp !== undefined &&
    parsed.expiration <= parsed.timestamp
  ) {
    return `x= (${parsed.expiration}) is not later than t= (${parsed.timestamp})`
  }

  if (parsed.expiration !== undefined) {
    const now = options.now ?? BigInt(Math.floor(Date.now() / 1000))
    if (parsed.expiration < now) return "signature expired"
  }

  // §3.5 on q=: the only method this verifier implements is `dns/txt`, which is
  // also the default when the tag is absent. A signer that asks for a method
  // nobody here speaks has not published a key this code can find.
  if (parsed.queryMethod !== undefined) {
    const methods = parsed.queryMethod.toLowerCase().split(":").map((method) =>
      method.replace(/[ \t]+/g, "")
    )
    if (!methods.some((method) => method === "dns/txt" || method === "dns")) {
      return `unsupported q= query method: ${parsed.queryMethod}`
    }
  }

  return undefined
}

/**
 * The checks RFC 6376 §3.6.1 puts on the key record, once it is in hand. Returns
 * the reason to refuse, or `undefined` to carry on.
 */
function refuseKeyRecord(
  key: DkimPublicKey,
  parsed: DkimSignatureHeader,
): string | undefined {
  // §3.6.1 on t=y: "This domain is testing DKIM. Verifiers MUST NOT treat
  // messages from signers in testing mode differently from unsigned email."
  // A verdict of "valid" is exactly the different treatment that forbids, so a
  // testing key produces a reason rather than an authentication.
  if (key.flags?.includes("y")) {
    return "key record is in testing mode (t=y), so the signature authenticates nothing"
  }
  // §3.6.1 on t=s: "Any DKIM-Signature header fields using the 'i=' tag MUST have
  // the same domain value on the right-hand side of the '@' in the 'i=' tag and
  // the value of the 'd=' tag." The parent-domain allowance above is withdrawn.
  const identityDomain = signerIdentityDomain(parsed)
  if (
    key.flags?.includes("s") && identityDomain !== undefined && identityDomain !== parsed.domain
  ) {
    return `i= domain ${identityDomain} is not exactly d= (${parsed.domain}), which t=s requires`
  }
  // §3.6.1 on h=: "A colon-separated list of hash algorithms that might be used.
  // Signers and Verifiers MUST support the 'sha256' hash algorithm." Both
  // algorithms this verifier implements hash with SHA-256, so a record that does
  // not list it does not allow this signature.
  if (key.hashAlgorithms !== undefined && !key.hashAlgorithms.includes("sha256")) {
    return `key record does not allow sha256 (h=${key.hashAlgorithms.join(":")})`
  }
  // §3.6.1 on s=: a key that does not name the `email` service type, or `*`, is
  // not published for signing mail.
  if (
    key.serviceTypes !== undefined && !key.serviceTypes.includes("*") &&
    !key.serviceTypes.includes("email")
  ) {
    return `key record is not published for email (s=${key.serviceTypes.join(":")})`
  }
  return undefined
}

/**
 * The domain half of the signature's `i=` tag, lowercased, or `undefined` when
 * the tag is absent.
 *
 * §3.5 gives `i=` the grammar `[ Local-part ] "@" domain-name`, and a quoted
 * local part may itself contain an `@`, so the domain starts after the last one.
 */
function signerIdentityDomain(parsed: DkimSignatureHeader): string | undefined {
  if (parsed.identity === undefined) return undefined
  return parsed.identity.slice(parsed.identity.lastIndexOf("@") + 1).toLowerCase()
}

/** True when `candidate` is `domain` itself or a subdomain of it. */
function isSameOrParentDomain(domain: string, candidate: string): boolean {
  return candidate === domain || candidate.endsWith(`.${domain}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
