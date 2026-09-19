/**
 * The JSON-recovery ladder: strict parse → fenced block → balanced-brace scan →
 * shape check.
 *
 * One case per rung and per documented edge, because this is the code every
 * feature with structured output depends on and the code that silently returns
 * garbage when a rung is wrong.
 */

import { assertEquals, assertMatch, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"

import { AiErrorCode, isAiError, JsonExtractionFailure } from "./errors.ts"
import {
  extractJsonFromMarkdown,
  fencedBodies,
  JsonExtractionFailure as LadderFailure,
  matchBalanced,
  scanForJsonValue,
} from "./parse-json.ts"

/** Assert an outcome is a value and return it. */
function valueOf(outcome: ReturnType<typeof extractJsonFromMarkdown>): unknown {
  assertEquals(outcome.error, null, `expected a value, got ${outcome.error?.message}`)
  return outcome.data
}

/** Assert an outcome is a failure and return the error. */
function errorOf(outcome: ReturnType<typeof extractJsonFromMarkdown>) {
  assertEquals(outcome.data, null)
  if (outcome.error === null) throw new Error("expected a typed error")
  return outcome.error
}

describe("the ladder's rungs", () => {
  it("parses a bare JSON object", () => {
    assertEquals(valueOf(extractJsonFromMarkdown(`{"a":1,"b":[2,3]}`)), { a: 1, b: [2, 3] })
  })

  it("parses a bare JSON array", () => {
    assertEquals(valueOf(extractJsonFromMarkdown(`[1,{"a":2}]`)), [1, { a: 2 }])
  })

  it("parses JSON wrapped in a json fence", () => {
    assertEquals(valueOf(extractJsonFromMarkdown('```json\n{"a":1}\n```')), { a: 1 })
  })

  it("parses JSON wrapped in a fence with no language tag", () => {
    assertEquals(valueOf(extractJsonFromMarkdown('```\n{"a":1}\n```')), { a: 1 })
  })

  it("parses JSON after leading prose", () => {
    const text = 'Sure! Here is the plan:\n\n```json\n{"tasks":["one"]}\n```'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { tasks: ["one"] })
  })

  it("parses JSON followed by trailing prose", () => {
    const text = 'Here you go:\n{"a":1}\n\nLet me know if you want changes!'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { a: 1 })
  })

  it("stops at the matching brace of a nested object", () => {
    const text = '{"outer":{"inner":{"deep":true}},"list":[{"n":1}]} and some trailing prose'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), {
      outer: { inner: { deep: true } },
      list: [{ n: 1 }],
    })
  })

  it("treats a closing brace inside a string as string content", () => {
    const text = 'prefix {"a":"} not the end {","b":1} suffix'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { a: "} not the end {", b: 1 })
  })

  it("handles an escaped quote inside a string", () => {
    const text = '{"quote":"he said \\"hi\\"","brace":"}"}'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { quote: 'he said "hi"', brace: "}" })
  })

  it("handles an escaped backslash before a quote", () => {
    const text = '{"path":"C:\\\\tmp\\\\","n":1}'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { path: "C:\\tmp\\", n: 1 })
  })

  it("skips a brace in prose before the real object", () => {
    const text = 'The schema {a: string} is not JSON. Actual answer:\n{"a":"x"}'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { a: "x" })
  })

  it("ignores an unterminated fence and scans anyway", () => {
    const text = '```json\n{"a":1}\n(no closing fence, stream cut off)'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { a: 1 })
  })

  it("prefers the first fenced block over a later object in prose", () => {
    const text = '```json\n{"first":true}\n```\nthen prose with {"second":true}'
    assertEquals(valueOf(extractJsonFromMarkdown(text)), { first: true })
  })
})

describe("the ladder's shape check", () => {
  for (const scalar of ['"42"', "42", "true", "null"]) {
    it(`rejects the JSON scalar ${scalar} by default`, () => {
      const error = errorOf(extractJsonFromMarkdown(scalar))
      assertEquals(error.code, AiErrorCode.JsonNotFound)
      assertEquals(error.extraction, JsonExtractionFailure.ScalarValue)
    })

    it(`accepts the JSON scalar ${scalar} when scalars are allowed`, () => {
      assertEquals(
        valueOf(extractJsonFromMarkdown(scalar, { allowScalar: true })),
        JSON.parse(scalar),
      )
    })
  }

  it("rejects a fenced scalar when scalars are not allowed", () => {
    const error = errorOf(extractJsonFromMarkdown("```json\n42\n```"))
    assertEquals(error.extraction, JsonExtractionFailure.ScalarValue)
  })

  it("accepts a fenced scalar when scalars are allowed", () => {
    assertEquals(valueOf(extractJsonFromMarkdown("```json\n42\n```", { allowScalar: true })), 42)
  })
})

describe("the ladder's failures are typed, never garbage", () => {
  it("fails on empty text", () => {
    const error = errorOf(extractJsonFromMarkdown("   "))
    assertEquals(error.code, AiErrorCode.JsonNotFound)
    assertEquals(error.extraction, JsonExtractionFailure.Empty)
    assertMatch(error.message, /completion is empty/)
  })

  it("fails on prose with no JSON at all", () => {
    const error = errorOf(extractJsonFromMarkdown("I cannot help with that request."))
    assertEquals(error.kind, "json")
    assertEquals(error.extraction, JsonExtractionFailure.NoJsonValue)
    assertEquals(isAiError(error), true)
  })

  it("fails on an unterminated object", () => {
    const error = errorOf(extractJsonFromMarkdown('here: {"a": 1, "b":'))
    assertEquals(error.extraction, JsonExtractionFailure.NoJsonValue)
  })

  it("returns the first complete object and ignores the malformed tail", () => {
    // The scan stops at the matching brace, so a truncated object later in the
    // same text cannot pollute the value that was recovered.
    const outcome = extractJsonFromMarkdown('{"a":1} then {"b":2} malformed {"c"')
    assertEquals(outcome.error, null)
    assertEquals(outcome.data, { a: 1 })
  })

  it("fails when every candidate in the text is truncated", () => {
    const error = errorOf(extractJsonFromMarkdown('prefix {"a":1 "b": and {"c"'))
    assertEquals(error.code, AiErrorCode.JsonNotFound)
    assertEquals(error.extraction, JsonExtractionFailure.NoJsonValue)
  })

  it("throws nothing: failures are returned, not raised", () => {
    const outcome = extractJsonFromMarkdown("nothing here")
    assertEquals(outcome.error === null, false)
    assertEquals(outcome.data, null)
  })

  it("keeps the JSON text out of the error message", () => {
    const secret = `{"apiKey":"sk-test-not-a-real-key","prompt":"do the thing"}`
    const error = errorOf(extractJsonFromMarkdown(`prefix ${secret.slice(0, 12)}`))
    assertEquals(error.message.includes("apiKey"), false)
    assertEquals(error.message.includes("do the thing"), false)
  })
})

describe("the ladder's helpers", () => {
  it("lists finished fence bodies in order", () => {
    assertEquals(fencedBodies('a ```json\n{"x":1}\n``` b ```\n[1]\n``` c'), ['{"x":1}', "[1]"])
  })

  it("ignores an unterminated fence", () => {
    assertEquals(fencedBodies('a ```json\n{"x":1}'), [])
  })

  it("returns the index of the matching brace", () => {
    assertEquals(matchBalanced('{"a":{"b":1}}', 0), 12)
  })

  it("returns -1 for an unclosed object", () => {
    assertEquals(matchBalanced('{"a":1', 0), -1)
  })

  it("scans past a candidate that is not valid JSON", () => {
    assertEquals(scanForJsonValue('{not json} then {"ok":true}'), { ok: true })
  })

  it("returns undefined when no balanced object parses", () => {
    assertEquals(scanForJsonValue("{not json}"), undefined)
  })

  it("exports one failure enum, not two", () => {
    assertEquals(JsonExtractionFailure, LadderFailure)
  })
})

describe("extractJsonFromMarkdown direct use", () => {
  it("does not throw on any input", () => {
    const inputs = ["", "```", "```json", "{", "}", "[]", "null", "```\n```", '{"a":}']
    for (const input of inputs) {
      const outcome = extractJsonFromMarkdown(input)
      assertEquals(typeof outcome, "object")
    }
  })

  it("is awaitable-safe: it never returns a promise", () => {
    const outcome = extractJsonFromMarkdown('{"a":1}')
    assertEquals(outcome instanceof Promise, false)
    void assertRejects
  })
})
