# Differential fixtures

Every `*.msg` here is an externally produced DKIM signature. The `*.key` beside it
is the `v=DKIM1; …` TXT record the verifier should use. Expected verdicts are in
the tables below; all are **valid**.

## Provenance of `rfc6376-rsa*.msg` — read this before citing §3.5

These are dkimpy's `data/rfc6376.signed.rsa.msg` (md5
`5deeccd15678e5bd33a7d6fda8e58209`) together with its `data/test.txt` as the key.
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

## Why `dkimpy-unsigned-trailing-tag` is valid

§3.7 step 2 deletes the _value_ of `b=`, not the rest of the field. The short input
that stops at `b=` (208 bytes) therefore **fails** OpenSSL, while the construction
keeping `; x=1800000000` (222 bytes) **verifies** — so that `x=` is authenticated
and this message is valid mail that an earlier revision of this package wrongly
refused.

The same property protects the other direction: appending `; x=9999999999` or
`; i=@attacker.invalid` to a genuine message lands inside the hashed field and
**fails** verification. Both payloads are tested against `dkimpy-relaxed`.
