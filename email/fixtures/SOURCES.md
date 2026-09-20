# Differential fixtures

Every `*.msg` here is an externally produced DKIM signature. The `*.key` beside it
is the `v=DKIM1; …` TXT record the verifier should use. Expected verdicts are in
the tables below; all are **valid**.

Where these files come from and under whose licence is in `NOTICE.md`. Two of them
were copied from dkimpy, whose licence requires that its notice travel with them.

## Provenance of `rfc6376-rsa*.msg` — read this before citing §3.5

These are dkimpy's `dkim/tests/data/rfc6376.signed.rsa.msg` (md5
`5deeccd15678e5bd33a7d6fda8e58209`) together with its `dkim/tests/data/test.txt` as the key.
That is a **2018 re-signature of the RFC 6376 example _message_** (`t=1527915362`,
`s=test`), not the signature printed in the RFC.

The signature printed in §3.5 cannot be verified from the RFC at all: the private
key behind it is not published. What is tested here is therefore "the RFC's example
message, signed with a known key using the RFC's own canonicalization" — a genuine
cross-implementation vector, but not a reproduction of the printed signature.
`rfc6376-rsa-crlf.msg` is the same message with CRLF endings.

## `rfc8463-a3.msg` — the Ed25519 vector

RFC 8463 Appendix A.3, carrying **both** an `ed25519-sha256` and an `rsa-sha256`
signature over the same message; the fixture ships the Ed25519 key (`k=ed25519`,
selector `brisbane`). This is the only standards-document Ed25519 vector available
offline and it is decisive: the signature verifies **only** over
`SHA-256(canonical input)`, per RFC 8463 §3. Over the 478-byte input, OpenSSL
reports `Signature Verified Successfully` for the digest and `Signature
Verification Failure` for the raw input. A verifier that hands the raw input to Web
Crypto rejects every conformant Ed25519 message.

RFC 6376's _other_ Ed25519 example (the two-signature §3.5 message, selector
`brisbane`) is **not** usable: neither dkimpy nor OpenSSL verifies it, because the
private key behind that printed signature is unpublished. Note also that without
`pynacl` installed, dkimpy returns `False` for _every_ Ed25519 message rather than
raising — so an Ed25519 verdict from dkimpy alone is not evidence of anything.

## `dkimpy-*.msg` — cross-implementation vectors

Built with dkimpy 1.1.8's canonicalizers plus OpenSSL, and asserted valid with
`openssl dgst -sha256 -verify` against the §3.7 reconstruction — not with
`dkimpy.verify` alone, since the verdict that matters is OpenSSL's over the bytes.

The runnable recipe (the script that produced them, not a paraphrase):

```python
import base64, hashlib, subprocess, sys
sys.path.insert(0, "<dkimpy-1.1.8 checkout>")
from dkim.canonicalization import CanonicalizationPolicy

mode = "relaxed"                        # or "simple", per fixture
msg = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n\r\nbody line\r\n"
head, _, body = msg.partition(b"\r\n\r\n")

policy = CanonicalizationPolicy.from_c_value(f"{mode}/{mode}".encode())
headers = [(b"From", b" a@example.com"), (b"To", b" b@example.com"), (b"Subject", b" s")]
body_hash = base64.b64encode(hashlib.sha256(policy.canonicalize_body(body)).digest()).decode()
field = (f"v=1; a=rsa-sha256; c={mode}/{mode}; d=example.com; s=sel; "
         f"h=from:to:subject; bh={body_hash}")

# §3.7 step 2: the h= headers in order, then the field with b= emptied and NO
# trailing CRLF. Nothing is appended after the field.
def canon(name, value):
    n, v = policy.canonicalize_headers([(name, value)])[0]
    return n + b":" + v

input_bytes = b"".join(canon(n, v) for n, v in headers) + \
    canon(b"DKIM-Signature", (field + "; b=").encode()).rstrip(b"\r\n")

signature = subprocess.run(["openssl", "dgst", "-sha256", "-sign", "key.pem"],
                           input=input_bytes, capture_output=True, check=True).stdout
signed = (head + b"\r\nDKIM-Signature: " + (field + "; b=").encode()
          + base64.b64encode(signature) + b"\r\n\r\n" + body)
```

Verify independently before committing:

```bash
openssl dgst -sha256 -verify pub.pem -signature sig.bin input.bin
```

What each fixture pins:

| Fixture                                                     | What it pins                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `dkimpy-relaxed`, `dkimpy-simple`                           | the two canonicalization modes end to end                                     |
| `dkimpy-empty-body-simple`, `dkimpy-two-empty-lines`        | §3.4.5's empty-body digest under `simple`                                     |
| `dkimpy-relaxed-empty-body`, `dkimpy-wsp-only-body-relaxed` | the same under `relaxed`, whose canonical body is zero bytes                  |
| `dkimpy-folded-hdr-simple`, `dkimpy-folded-hdr-relaxed`     | folded header values in both modes                                            |
| `dkimpy-folded-b`                                           | a `b=` value folded across lines                                              |
| `dkimpy-h-fws`                                              | `h=from : to : subject`, FWS around the colons                                |
| `dkimpy-h-repeat`                                           | the same field named twice in `h=`                                            |
| `dkimpy-received-bottomup`                                  | repeated `Received:` instances, consumed bottom-up per §5.4.2                 |
| `dkimpy-rsa4096`                                            | the DER long-form (`0x82`) length path                                        |
| `dkimpy-l0`, `dkimpy-l8`, `dkimpy-l18`, `dkimpy-l25`        | `l=` truncation of the canonical body, including a bound longer than the body |
| `dkimpy-unsigned-trailing-tag`                              | **valid**: its `x=` tag after `b=` is inside the signed bytes                 |

Plus the five `openssl-*` vectors described below, which the dkimpy set does not
reach (bodies beginning with SP or HTAB, and a `simple` signature made over a
lower-case field name) and the three `openssl-utf8-*` vectors, which are the only
ones combining a non-ASCII body with an `l=` bound. Twenty-nine `*.msg` in total,
every one expected valid: eighteen built with dkimpy 1.1.8's canonicalizers plus
OpenSSL, eight from the OpenSSL-only scripts below, and three with a
standards-document provenance (RFC 6376's example message in LF and CRLF form,
RFC 8463 Appendix A.3).

## Why `dkimpy-unsigned-trailing-tag` is valid

§3.7 step 2 deletes the _value_ of `b=`, not the rest of the field. The short input
that stops at `b=` (208 bytes) therefore **fails** OpenSSL, while the construction
keeping `; x=1800000000` (222 bytes) **verifies** — so that `x=` is authenticated
and this message is valid mail that an earlier revision of this package wrongly
refused.

The same property protects the other direction: appending `; x=9999999999` or
`; i=@attacker.invalid` to a genuine message lands inside the hashed field and
**fails** verification. Both payloads are tested against `dkimpy-relaxed`.

## `openssl-*.msg` — the RFC 5322 §2.2 boundary and the field name

Five vectors built by an **OpenSSL-only** script: no dkimpy, a canonicalizer
written from the RFC 6376 text, and every signature checked with
`openssl dgst -sha256 -verify` before the fixture was written. They cover cases the
dkimpy set cannot: RFC 5322 §2.2 ends the header section at the first empty line
whatever follows it, so a body beginning with SP or HTAB is body — and §3.7 step 2
hashes "the DKIM-Signature header field that exists", so under `simple` the field
name's case is signed bytes.

| Fixture                                               | What it pins                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `openssl-sp-body-simple`, `openssl-tab-body-simple`   | `c=simple/simple`, body whose first line starts with SP / with HTAB       |
| `openssl-sp-body-relaxed`, `openssl-tab-body-relaxed` | the same bodies under `c=relaxed/relaxed`                                 |
| `openssl-lower-field-simple`                          | `c=simple/simple`, field emitted as `dkim-signature:` and signed that way |

The forgery these pin is a mutation, not a fixture: injecting `" \r\n<payload>"`
behind the first empty line of `dkimpy-empty-body-simple` used to verify, because
the boundary was not found and the whole message was hashed as an empty body.

The runnable recipe (`key.pem` is any RSA key, e.g. `openssl genrsa -out key.pem 2048`):

```python
import base64, hashlib, re, subprocess

def canon_header(name, value, mode):                    # §3.4.1 / §3.4.2
    if mode == "simple":
        return name + b":" + value + b"\r\n"
    unfolded = value.replace(b"\r\n", b"")
    return name.lower().strip() + b":" + re.sub(rb"[ \t]+", b" ", unfolded).strip() + b"\r\n"

def canon_body(body, mode):                             # §3.4.3 / §3.4.4
    crlf = re.sub(rb"\r\n|\r|\n", b"\r\n", body)
    if mode == "simple":
        stripped = re.sub(rb"(?:\r\n)+$", b"", crlf)
        return b"\r\n" if stripped == b"" else stripped + b"\r\n"
    prepared = re.sub(rb"[ \t]+", b" ", re.sub(rb"[ \t]+\r\n", b"\r\n", crlf))
    stripped = re.sub(rb"(?:\r\n)+$", b"", prepared)
    return b"" if stripped == b"" else stripped + b"\r\n"

mode, field_name = "simple", b"DKIM-Signature"          # or "relaxed", b"dkim-signature"
headers = [(b"From", b" a@example.com"), (b"To", b" b@example.com"), (b"Subject", b" s")]
body = b" Leading space body\r\nsecond line\r\n"
bh = base64.b64encode(hashlib.sha256(canon_body(body, mode)).digest()).decode()
stub = (f"v=1; a=rsa-sha256; c={mode}/{mode}; d=example.com; s=sel; t=1700000000; "
        f"h=from:to:subject; bh={bh}; b=").encode()

# §3.7 step 2: the h= headers, then the field with b= emptied in place and no
# trailing CRLF. The field value carries the SP that followed the colon, which
# `simple` keeps verbatim.
signed_input = b"".join(canon_header(n, v, mode) for n, v in headers) + \
    canon_header(field_name, b" " + stub, mode).rstrip(b"\r\n")

sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", "key.pem"],
                     input=signed_input, capture_output=True, check=True).stdout
msg = (b"From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n" + field_name +
       b": " + stub + base64.b64encode(sig) + b"\r\n\r\n" + body)
```

Verify independently before committing, and note that OpenSSL 3.x prints
`Verified OK` where 1.1.1 printed `Verified Successfully`:

```bash
openssl dgst -sha256 -verify pub.pem -signature sig.bin input.bin
```

The `*.key` beside each is `v=DKIM1; k=rsa; p=` plus the base64 of
`openssl rsa -in key.pem -RSAPublicKey_out -outform DER` — the bare PKCS#1 shape
§3.6.1 specifies.

## `openssl-utf8-*.msg` — `l=` counted in octets over a non-ASCII body

Three vectors signed by the same **OpenSSL-only** approach, differing in one
respect: the body carries a multi-octet character before the `l=` bound, so the
bound falls at a different place in octets than in UTF-16 code units. They exist
because a verifier that applies `l=` with `String.prototype.slice` — code units —
hashes a byte range the signer never signed, and rejects valid mail.

| Fixture                 | `l=` | Canonical body | Octets hashed (the signer's range) | Digest of that range                           |
| ----------------------- | ---- | -------------- | ---------------------------------- | ---------------------------------------------- |
| `openssl-utf8-l4`       | 4    | `héllo\r\n`    | `h\xc3\xa9l` (3 code units)        | `nCjUmslET0eKzs9FV7zzkWhR/r2ik2CJIgWSlEPYf6A=` |
| `openssl-utf8-l6`       | 6    | `heloéé\r\n`   | `helo\xc3\xa9`                     | `sZ0NsYvV5Rbv3pELbhdaYgWpIl+a0NmYlxJvzRwfLhc=` |
| `openssl-utf8-split-l2` | 2    | `h€llo\r\n`    | `h\xe2`                            | `BnwhlmstcOW74w+XBvVGZvPGRVnBN23k4FCq43WUwBw=` |

The same bounds read as UTF-16 code units give different ranges — that is the
defect these pin, and the difference is always in the direction of _more_ octets
hashed, never fewer, so it is a false rejection rather than an acceptance gap:

| Fixture           | Code-unit slice | Octets it hashes | Digest it produces                             |
| ----------------- | --------------- | ---------------- | ---------------------------------------------- |
| `openssl-utf8-l4` | `héll`          | 5                | `V/OrDY5eigJU1Zmgo+zLEbepPnNVUwupIRgyjsfEE4g=` |
| `openssl-utf8-l6` | `heloéé`        | 8                | `yBKAQFKuFs2/qleNmNMoYTEymlYIAmjf7a4iVC7HQPE=` |

`openssl-utf8-split-l2` is the decisive one for the _other_ hazard: the bound stops
inside the three-octet euro sign, so a verifier that decodes the sliced bytes back
to a string hashes `h\xef\xbf\xbd` (U+FFFD, `4b5JJzu7A+6PSXw3/SguYfWFYGMPbuteZ+mHdZDLaxM=`)
rather than the two octets the signer declared. Both alternatives are recorded as
inequalities in the tests.

The recipe is the `openssl-*.msg` script above with no change other than the body,
the `l=` tag and the truncation:

```python
body = "héllo\r\n".encode()          # or "heloéé\r\n", or "h€llo\r\n"
l = 4                                # or 6, or 2
canonical = canon_body(body, mode)
bh = base64.b64encode(hashlib.sha256(canonical[:l]).digest()).decode()
stub = (f"v=1; a=rsa-sha256; c={mode}/{mode}; d=example.com; s=sel; t=1700000000; "
        f"h=from:to:subject; bh={bh}; l={l}; b=").encode()
```

`canonical[:l]` is a byte slice, which is the point: the signer hashes octets, and
`openssl dgst -sha256 -verify` was run over the reconstructed input before each
fixture was written. All three were produced with the same `key.pem`, so their
`*.key` records are byte-identical.
