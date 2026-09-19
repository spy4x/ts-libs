/**
 * Recovering a JSON value from model output.
 *
 * The ladder, in order, first success wins:
 *
 * 1. strict `JSON.parse` of the trimmed text;
 * 2. the body of the first fenced block, parsed strictly — ```json or a bare
 *    ``` fence, so a language tag is optional;
 * 3. a balanced-brace scan for the first complete JSON object in the text;
 * 4. shape check — the recovered value must be an object or an array, unless the
 *    caller allows a scalar.
 *
 * Rung 3 is a scan rather than a `firstIndexOf("{")`…`lastIndexOf("}")` slice: a
 * slice from the first `{` to the last `}` runs past the object when prose after
 * it also contains a brace, and stops early when the object contains a nested
 * one. The scan tracks string state and escapes, so a `}` inside a string closes
 * nothing, and it returns the first candidate that actually parses.
 *
 * The ladder is extraction only. It does not decide whether the value is the
 * *right* JSON — that is the caller's schema, applied by `chatJson`.
 */

import { type AiError, AiErrorCode, AiRequestError, JsonExtractionFailure } from "./errors.ts"

export { JsonExtractionFailure }

/** Options for {@link extractJsonFromMarkdown}. */
export interface JsonExtractionOptions {
  /**
   * Accept a top-level JSON scalar (`42`, `true`, `null`).
   *
   * Defaults to `false`, and the tradeoff is deliberate: a bare number or `true`
   * in prose is far more likely to be a coincidence than an answer, so a scalar
   * is reported as `ScalarValue` rather than returned as data. A caller that
   * really wants a scalar schema passes this on — `chatJson` retries with it when
   * the strict pass found nothing usable — and then rung 1 and rung 2 accept a
   * scalar while the scan still requires an object, because a scalar has no
   * delimiter to scan for.
   */
  allowScalar?: boolean
}

/** A recovered value, or the error that rejected it. */
export type JsonExtractionOutcome =
  | { error: AiError; data: null }
  | { error: null; data: unknown }

/**
 * Extract the first JSON object or array from model output.
 *
 * @example
 * ```ts
 * const { error, data } = extractJsonFromMarkdown(`Here you go:\n\`\`\`json\n{"a":1}\n\`\`\``)
 * if (error) return error.message
 * console.log(data) // { a: 1 }
 * ```
 */
export function extractJsonFromMarkdown(
  text: string,
  options: JsonExtractionOptions = {},
): JsonExtractionOutcome {
  const allowScalar = options.allowScalar ?? false
  const trimmed = text.trim()
  if (trimmed === "") {
    return failure(JsonExtractionFailure.Empty, "the completion is empty — nothing to recover")
  }

  // Rung 1 — strict parse of the whole text.
  const direct = tryParse(trimmed)
  if (direct.kind === "value") return shapeOutcome(direct.value, allowScalar)

  // Rung 2 — the body of the first fenced block, parsed strictly.
  for (const body of fencedBodies(trimmed)) {
    const fenced = tryParse(body)
    if (fenced.kind === "value") return shapeOutcome(fenced.value, allowScalar)
  }

  // Rung 3 — the first balanced object that parses. A scalar has no delimiter to
  // scan for, so this rung only ever recovers an object.
  const scanned = scanForJsonValue(trimmed)
  if (scanned !== undefined) return shapeOutcome(scanned, allowScalar)

  return failure(JsonExtractionFailure.NoJsonValue)
}

/** Accept a parsed candidate, or report why its shape is not usable. */
function shapeOutcome(value: unknown, allowScalar: boolean): JsonExtractionOutcome {
  if (Array.isArray(value)) return { error: null, data: value }
  if (typeof value === "object" && value !== null) return { error: null, data: value }
  if (allowScalar) return { error: null, data: value }
  return failure(JsonExtractionFailure.ScalarValue)
}

/**
 * Every finished ``` fence body in the text, in order.
 *
 * A fence is three backticks, an optional info string, then the body up to the
 * next fence. An unterminated fence is ignored: a truncated stream is not a
 * recoverable envelope, and guessing where it ended is how a half-written object
 * gets parsed as if it were complete.
 */
export function fencedBodies(text: string): string[] {
  const bodies: string[] = []
  const pattern = /```[^\n]*\n([\s\S]*?)```/g
  let match = pattern.exec(text)
  while (match !== null) {
    bodies.push(match[1].trim())
    match = pattern.exec(text)
  }
  return bodies
}

/**
 * The first complete JSON object in `text` that parses, or `undefined`.
 *
 * Returns the parsed value rather than a slice, so a candidate that parses is
 * never mistaken for a failure: the shape check decides whether it is usable.
 */
export function scanForJsonValue(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue
    const end = matchBalanced(text, start)
    if (end === -1) continue
    const parsed = tryParse(text.slice(start, end + 1))
    if (parsed.kind === "value") return parsed.value
  }
  return undefined
}

/**
 * Index of the brace closing the object that opens at `start`, or `-1`.
 *
 * Tracks single and double quoted strings and backslash escapes, so a `}` inside
 * a string or a nested object does not end the scan early. An unclosed string or
 * object returns `-1` rather than a guess.
 */
export function matchBalanced(text: string, start: number): number {
  let depth = 0
  let inString = false
  let quote = ""
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === "\\") escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === "{") {
      depth++
      continue
    }
    if (char === "}") {
      depth--
      if (depth === 0) return index
      if (depth < 0) return -1
    }
  }
  return -1
}

type ParseAttempt = { kind: "value"; value: unknown } | { kind: "failed" }

function tryParse(text: string): ParseAttempt {
  try {
    return { kind: "value", value: JSON.parse(text) }
  } catch {
    return { kind: "failed" }
  }
}

/** The typed error every rung reports through, so a caller branches on a code. */
function failure(reason: JsonExtractionFailure, detail?: string): JsonExtractionOutcome {
  const message = detail !== undefined
    ? `ai: ${detail}`
    : reason === JsonExtractionFailure.ScalarValue
    ? "ai: the completion held a JSON scalar, not an object or array"
    : "ai: the completion held no JSON object or array"
  return {
    error: new AiRequestError({
      kind: "json",
      code: AiErrorCode.JsonNotFound,
      message,
      extraction: reason,
    }),
    data: null,
  }
}
