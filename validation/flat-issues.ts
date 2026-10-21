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
