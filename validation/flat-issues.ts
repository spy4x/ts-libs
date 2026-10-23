/**
 * The one reading of an arktype rejection that `validate` and `schemaIssues` both build on, so the
 * two never describe the same failure two different ways. Not exported from the package.
 * @module
 */

import type { ArkError, ArkErrors } from "arktype"

/** One arktype issue, with intersections already split into their parts. */
export interface FlatIssue {
  /** Path as arktype prints it (`"address.city"`, `"items[1]"`); empty for an issue with no field. */
  path: string
  /** The model field the issue belongs to — the first path segment — or `undefined` for none. */
  field: string | undefined
  /** arktype's error code, for example `"domain"` or `"minLength"`. */
  code: string
  /** Explanation for the value alone, without the path: `"must be a number"`. */
  problem: string
  /** The same explanation prefixed with its path: `"age must be a number"`. */
  message: string
  /**
   * The constraint the value missed, for a message to quote: `{ rule: 120 }` for `maxLength`,
   * plus `exclusive: true` for a bound like `> 1`. Empty for a code with no rule (`required`,
   * `domain`). Never the submitted value, which can be a password.
   */
  values: Record<string, string | number | boolean>
}

/**
 * Every issue of a rejection, one per failed constraint, in the order arktype reports them.
 *
 * Read from `flatByPath`, so an intersection (`"string.alpha & /^a/"`) yields one issue per failed
 * part instead of one multi-line message.
 */
export function flatIssues(errors: ArkErrors): FlatIssue[] {
  return Object.entries(errors.flatByPath).flatMap(([path, list]) =>
    list.map((issue) => ({
      path,
      field: issue.path.length > 0 ? String(issue.path[0]) : undefined,
      code: issue.code,
      problem: problemOf(issue),
      message: issue.message,
      values: valuesOf(issue),
    }))
  )
}

/**
 * An issue's explanation without its path, or its full message when arktype cannot build one.
 *
 * arktype builds `problem` from the issue's `expected` text. A rejection written the way arktype's
 * own docs show it, `ctx.reject({ message: "…" })`, has a message but no `expected`, and reading
 * its `problem` throws a `TypeError`. Its `message` is the caller's own sentence, with no path in
 * it, so it is the right text to show instead.
 */
function problemOf(issue: ArkError): string {
  try {
    return issue.problem
  } catch {
    return issue.message
  }
}

/**
 * The rule an issue carries, as JSON-safe values. arktype puts the limit of a bound, the divisor
 * and a pattern's source on `rule` (a `Date` for `before` and `after`, sent as its ISO string) and
 * marks a strict bound with `exclusive`.
 */
function valuesOf(issue: ArkError): Record<string, string | number | boolean> {
  const { rule, exclusive } = issue as { rule?: unknown; exclusive?: unknown }
  const values: Record<string, string | number | boolean> = {}
  if (rule instanceof Date) values.rule = rule.toISOString()
  else if (typeof rule === "number" || typeof rule === "string") values.rule = rule
  if (exclusive === true) values.exclusive = true
  return values
}
