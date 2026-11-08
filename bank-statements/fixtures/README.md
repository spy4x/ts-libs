# Fixtures

Every file in this folder is synthetic: written by hand for the tests, with
made-up names, accounts, references and amounts. None is, or is derived from, a
real bank statement. Real statements are never committed; a real bank's format
joins only as a new synthetic file in its shape, once its export has been
anonymised.

| File               | Format                                              | Read with                                                       |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| `signed.csv`       | CSV, one signed amount column, balances             | built-in profile "Signed amount, comma, ISO dates"              |
| `debit-credit.csv` | CSV in Windows-1252, debit and credit, newest first | built-in profile "Debit and credit, semicolon, German numbers"  |
| `preamble.csv`     | CSV with three preamble lines, no balances          | built-in profile "Preamble rows, US dates, foreign amounts"     |
| `ofx1.ofx`         | OFX 1 (SGML)                                        | `parseOfx`                                                      |
| `ofx2.qfx`         | OFX 2 (XML), a credit card                          | `parseOfx`                                                      |
| `bank.qif`         | QIF                                                 | `parseQif`                                                      |
| `camt053.xml`      | CAMT.053, with one pending entry                    | `parseCamt053`                                                  |
| `mt940.sta`        | MT940 in a SWIFT envelope                           | `parseMt940`                                                    |
| `statement.pdf`    | PDF with a text layer, two pages, running balances  | `extractPdfLines`, then `parsePdfStatement` with a `pdf` layout |
| `scanned.pdf`      | PDF whose one page is an image and holds no text    | `extractPdfLines` refuses it: `"no-text-layer"`                 |
| `encrypted.pdf`    | PDF behind the user password `secret`               | `extractPdfLines` refuses it: `"encrypted"`                     |

The PDFs are written byte by byte by `make-pdfs.ts`, with no PDF tool, so a change to them is a
change to that script. Rebuild them from the repository root with
`deno run --allow-write=bank-statements/fixtures bank-statements/fixtures/make-pdfs.ts`.
