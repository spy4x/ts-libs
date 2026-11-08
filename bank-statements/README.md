# `@spy4x/bank-statements`

Bank statements read into dated, signed amounts in minor units, and checked against their own
balances. Standard formats need nothing else: OFX and QFX, QIF, CAMT.053 and MT940. A bank's own
CSV, or its PDF statement's text, is read through a profile, which describes its format as data, so
a household's mapping, a built-in profile and an AI proposal all go through the same tested parser. A check that fails
names the lines that do not add up. No UI and no storage.

## Install

```bash
deno add jsr:@spy4x/bank-statements
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API. The
`./pdf` entry runs pdf.js through [unpdf](https://github.com/unjs/unpdf); a bundle of it was run on
Deno 2.9, Node 26 and Bun 1.4, and unpdf itself asks for Node 24 or later.

## Modules

Usage is in the module doc, shown by `deno doc` and on JSR.

- [`@spy4x/bank-statements`](mod.ts): `readStatement`, the parsers, profiles and
  `verifyStatement`.
- [`@spy4x/bank-statements/pdf`](pdf.ts): `extractPdfLines`, which reads a PDF's text into lines
  of positioned words, and `parsePdfStatement`, which reads those lines with a profile's `pdf`
  layout. A separate entry, so pdf.js stays out of apps that do not read PDF.
- [`@spy4x/bank-statements/infer`](infer.ts): `inferProfile`, which asks a language model for a
  profile when no known one reads a file, `maskSample` and `profilePrompt`. The model is a port the
  app passes in, so this package sends nothing by itself.

## Safety

An uploaded statement comes from a stranger. `maxBytes` (10 MiB) is checked before decoding and
`maxRows` (100,000) before any row is read; the XML formats refuse a DTD; OFX 1 is read by a
linear tokenizer. A file refused whole throws `StatementError`; a row that does not read is a row
error with its line, and a statement with one never verifies.

A PDF is checked against `maxBytes` before pdf.js opens it, and against `maxPages` (50) before any
page's text is read; the text read and the lines are capped too. pdf.js loads with
`isEvalSupported: false` and renders nothing. A scan without a text layer is refused as
`"no-text-layer"` and a password-protected file as `"encrypted"`. A profile's line pattern is a list
of typed tokens (`date`, `amount`, `text`, a literal), never a regular expression, because a
profile can come from an AI reply.

`inferProfile` sends a model only a masked sample: at most 20 lines, every digit turned into `9`
and every letter into `x` or `X`, with spacing and separators kept. Only the header row keeps its
letters, and only when none of its cells reads as a date or an amount. Nothing else from the file
leaves the host. The date pattern and number format are read here from the real values, and a
proposal is accepted only when it reads every row and the file's balances add up; a file without
balances is refused as `"unverifiable"`.

The test fixtures in `fixtures/` are all synthetic.
