# `@spy4x/bank-statements`

Bank statements read into dated, signed amounts in minor units, and checked against their own
balances. Standard formats need nothing else: OFX and QFX, QIF, CAMT.053 and MT940. A bank's own
CSV is read through a profile, which describes its format as data, so a household's mapping, a
built-in profile and an AI proposal all go through the same tested parser. A check that fails
names the lines that do not add up. No UI and no storage.

## Install

```bash
deno add jsr:@spy4x/bank-statements
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## Modules

Usage is in the module doc, shown by `deno doc` and on JSR.

- [`@spy4x/bank-statements`](mod.ts): `readStatement`, the parsers, profiles and
  `verifyStatement`.

## Safety

An uploaded statement comes from a stranger. `maxBytes` (10 MiB) is checked before decoding and
`maxRows` (100,000) before any row is read; the XML formats refuse a DTD; OFX 1 is read by a
linear tokenizer. A file refused whole throws `StatementError`; a row that does not read is a row
error with its line, and a statement with one never verifies.

The test fixtures in `fixtures/` are all synthetic.
