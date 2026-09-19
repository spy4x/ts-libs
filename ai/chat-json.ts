/**
 * `chatJson` — one model call whose answer must match an arktype schema.
 *
 * `/chat/completions` has no reliable structured-output contract across
 * OpenAI-compatible providers: some honour `response_format`, some ignore it,
 * and some wrap the JSON in a Markdown fence anyway. So the output is treated as
 * untrusted text: recover a JSON value with the `parse-json.ts` ladder, hand it
 * to `@ts-libs/validation`'s `validate`, and only then return it.
 *
 * A failed attempt gets at most **one** automatic repair round-trip. The repair
 * prompt carries the validator's *issue summary* — path-prefixed messages such
 * as `"tasks[0].time must be a string or null"` — and never the model's previous
 * text, because echoing a completion back into a request is how a model is
 * talked into repeating a prompt injection it was fed.
 */

import { type Type } from "arktype"
import { type SchemaOutput, validate } from "@ts-libs/validation"

import { type AiError, AiErrorCode, AiRequestError, JsonExtractionFailure } from "./errors.ts"
import { extractJsonFromMarkdown } from "./parse-json.ts"

/**
 * Why a structured call could not be satisfied.
 *
 * Separate from {@link AiError} so the caller can branch on the recovery step
 * (`"json-not-found"` versus `"schema-mismatch"`) while the error envelope stays
 * the single `AiError` shape used everywhere else in the package.
 */
export type ChatJsonFailure = "json-not-found" | "schema-mismatch"

/** Result of recovering and validating one completion. */
export type ChatJsonOutcome<T> =
  | { error: AiError; data: null; failure: ChatJsonFailure }
  | { error: null; data: T; failure: null }

/**
 * Recover a JSON value from `content` and validate it against `schema`.
 *
 * Two extraction attempts, because a schema is a better scalar detector than any
 * heuristic: the first requires an object or array, the second admits a scalar,
 * and each candidate goes through `validate`. A schema that is `type("number")`
 * therefore succeeds on `42`, while `type({ a: "number" })` never accepts a
 * scalar even when the model emits one.
 */
export function parseCompletionJson<T extends Type>(
  content: string,
  schema: T,
): ChatJsonOutcome<SchemaOutput<T>> {
  const strict = extractJsonFromMarkdown(content)
  const relaxed = extractJsonFromMarkdown(content, { allowScalar: true })
  let mismatch: string | null = null

  for (const extracted of [strict, relaxed]) {
    if (extracted.error !== null) continue
    const validated = validate(schema, extracted.data)
    if (validated.error === null) {
      return { error: null, data: validated.data as SchemaOutput<T>, failure: null }
    }
    mismatch = validated.error.details.summary
  }

  if (mismatch !== null) {
    return schemaMismatch(mismatch)
  }
  if (strict.error?.extraction === JsonExtractionFailure.ScalarValue) {
    // The text held a JSON scalar and the schema wanted an object or array, so
    // the schema is the reason the call failed, not the recovery ladder.
    return schemaMismatch("the completion was a JSON scalar, not an object or array")
  }
  const notFound = strict.error ?? relaxed.error
  if (notFound === null) {
    // Unreachable: every non-error outcome above returned or threw.
    throw new AiRequestError({
      kind: "json",
      code: AiErrorCode.JsonNotFound,
      message: "ai: the completion contained no JSON value",
    })
  }
  return { error: notFound, data: null, failure: "json-not-found" }
}

/**
 * The repair prompt.
 *
 * Generic and free of the previous completion, the original prompt and the raw
 * input: only validator issue text crosses into it, and that text is built by
 * arktype from the schema, not by the model.
 */
export function repairPrompt(error: AiError): string {
  const issue = error.code === AiErrorCode.SchemaMismatch
    ? error.message.replace(/^ai: the response did not match the schema: /, "")
    : "the response was not a JSON object or array"
  return `Your previous answer could not be used: ${issue}\n\n` +
    "Reply with one JSON value only — no prose, no Markdown fence. " +
    "Use exactly the field names and types the request describes."
}

function schemaMismatch(summary: string): ChatJsonOutcome<never> {
  return {
    error: new AiRequestError({
      kind: "json",
      code: AiErrorCode.SchemaMismatch,
      message: `ai: the response did not match the schema: ${sanitizeIssueSummary(summary)}`,
    }),
    data: null,
    failure: "schema-mismatch",
  }
}

/**
 * Collapse a validator summary into one bounded line.
 *
 * `error.details.summary` is arktype's own rendering of the issues, so it is
 * bounded here before it can reach an error message or a repair prompt: a wide
 * schema over a large model payload can produce a summary of many kilobytes, and
 * a multi-line string inside a message is how a forged log line gets started.
 */
function sanitizeIssueSummary(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim()
  return flat.length > MAX_ISSUE_SUMMARY ? `${flat.slice(0, MAX_ISSUE_SUMMARY)}…` : flat
}

/** Cap on validator text that may reach a message or a repair prompt. */
const MAX_ISSUE_SUMMARY: number = 400
