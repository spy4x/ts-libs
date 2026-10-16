/**
 * Test cases for `likeContains`, shared by its SQLite unit test and its Postgres integration test.
 *
 * @module
 */

/**
 * Pairs of search text and stored text, and whether the stored text contains the search text as it
 * is written. Each line is something a wildcard or a stray escape would get wrong.
 */
export const LIKE_CASES: readonly (readonly [search: string, text: string, matches: boolean])[] = [
  [`%`, `100% sure`, true],
  [`%`, `100 sure`, false], // a bare % must not match every row
  [`_`, `a_b`, true],
  [`_`, `ab`, false], // a bare _ must not match any one character
  [`a_c`, `abc`, false],
  [`a%c`, `abbbc`, false],
  [`\\`, `C:\\temp`, true],
  [`\\`, `C:/temp`, false],
  [`\\%`, `50\\%`, true], // a backslash then a percent sign, both literal
  [`\\%`, `50%`, false],
  [`\\_`, `x\\y`, false],
  [`end\\`, `the end\\`, true], // a trailing backslash must not escape the closing wildcard
  [`end\\`, `the end`, false],
  [`%_%_%_`, `a%_%_%_d`, true],
  [`%_%_%_`, `abcdef`, false],
  [`ann@example.com`, `Ann <ann@example.com>`, true],
  [`ünï 💸`, `pay ünï 💸 now`, true],
  [``, `anything`, true], // empty search contains-matches every row, as an empty filter should
]
