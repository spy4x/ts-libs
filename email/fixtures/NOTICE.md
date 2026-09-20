# Third-party material in this folder

This repository is MIT (`LICENSE` at the root, © 2026 Anton Shubin). Two of the fixtures here
were not written for it, and this note records where they came from and under what terms, which
issue #62 asked for. `SOURCES.md` describes what each fixture proves; this file is only about
provenance.

## Copied from dkimpy

| File                                      | Origin in dkimpy                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `rfc6376-rsa.msg`, `rfc6376-rsa-crlf.msg` | `data/rfc6376.signed.rsa.msg`, the second with LF endings rewritten to CRLF |
| `rfc6376-rsa.key`, `rfc6376-rsa-crlf.key` | `data/test.txt`, the published key record for that message                  |

dkimpy is the Python DKIM implementation at <https://launchpad.net/dkimpy>, maintained by Scott
Kitterman. Its `LICENSE` file, reproduced in full below as its third restriction requires, is the
zlib licence:

```
This software is provided 'as-is', without any express or implied
warranty.  In no event will the author be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

Copyright (c) 2008 Greg Hewgill http://hewgill.com
See individual files for information about modification to these files and
additional copyright information.
```

The message itself is RFC 6376 §3.5's example, re-signed by dkimpy in 2018 with a key whose
private half dkimpy publishes; `SOURCES.md` explains why the signature printed in the RFC cannot
be verified by anyone. The `-crlf` variant is an altered copy in the sense of restriction 2: the
line endings were rewritten, and nothing else.

## Produced by running dkimpy

Every `dkimpy-*.msg` was generated in this repository by the script in `SOURCES.md`, which calls
dkimpy 1.1.8's canonicalizers and then signs with OpenSSL. The files are that script's output
rather than copies of dkimpy's own data, and the name records which implementation produced the
bytes the verifier is checked against. The licence above still covers the code that produced
them.

## Taken from a standards document

`rfc8463-a3.msg` and `rfc8463-a3.key` are Appendix A.3 of RFC 8463, and the `openssl-*` fixtures
were produced by the OpenSSL-only script in `SOURCES.md`, which shares no code with dkimpy. RFC
text and its code components are published by the IETF Trust under the terms at
<https://trustee.ietf.org/license-info>.

## Keys

No private key is committed. Every `.key` file is a public DNS TXT record: `p=` holds a public
key, which is what a verifier reads out of DNS.
