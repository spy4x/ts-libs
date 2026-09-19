// Tests for the JSON Schema → arktype conversion. The wire contract is JSON Schema;
// arktype is the validator. An unsupported keyword must fail loudly at registration
// rather than silently accepting unvalidated arguments.

import { assert, assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import { arkTypeValidator, compileInputSchema, validateAgainstSchema } from "./schema.ts"
import { invokeTool, type ToolDefinition, ToolRegistry } from "./tools.ts"

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object" as const, properties, required }
}

describe("validateAgainstSchema", () => {
  it("accepts arguments that satisfy the schema", () => {
    const result = validateAgainstSchema(schema({ text: { type: "string" } }, ["text"]), {
      text: "hello",
    })
    assertEquals(result, { ok: true, value: { text: "hello" } })
  })

  it("rejects a wrong property type with the arktype summary", () => {
    const result = validateAgainstSchema(schema({ text: { type: "string" } }, ["text"]), {
      text: 42,
    })
    assertEquals(result.ok, false)
    if (result.ok) return
    assert(result.message.includes("text must be a string"))
  })

  it("rejects a missing required property", () => {
    const result = validateAgainstSchema(schema({ text: { type: "string" } }, ["text"]), {})
    assertEquals(result.ok, false)
    if (result.ok) return
    assert(result.message.includes("missing"))
  })

  it("accepts an omitted optional property", () => {
    const result = validateAgainstSchema(
      schema({ text: { type: "string" }, limit: { type: "integer" } }, ["text"]),
      { text: "hello" },
    )
    assertEquals(result, { ok: true, value: { text: "hello" } })
  })

  it("validates an enum member", () => {
    const enumSchema = schema({ status: { type: "string", enum: ["NEEDS-ACTION", "COMPLETED"] } })
    assertEquals(validateAgainstSchema(enumSchema, { status: "COMPLETED" }).ok, true)
    const rejected = validateAgainstSchema(enumSchema, { status: "DONE" })
    assertEquals(rejected.ok, false)
    if (rejected.ok) return
    assert(rejected.message.includes("NEEDS-ACTION"))
  })

  it("treats an enum member named like an arktype keyword as a literal", () => {
    const enumSchema = schema({ unit: { enum: ["string", "number"] } })
    assertEquals(validateAgainstSchema(enumSchema, { unit: "string" }).ok, true)
    assertEquals(validateAgainstSchema(enumSchema, { unit: "boolean" }).ok, false)
  })

  it("validates a nested object and a nested array", () => {
    const nested = schema({
      priority: {
        type: "object",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
      categories: { type: "array", items: { type: "string" } },
    })
    assertEquals(
      validateAgainstSchema(nested, { priority: { min: 1 }, categories: ["a", "b"] }).ok,
      true,
    )
    assertEquals(validateAgainstSchema(nested, { categories: [1] }).ok, false)
    assertEquals(validateAgainstSchema(nested, { priority: { min: "high" } }).ok, false)
  })

  it("treats a number as an integer only when the schema says integer", () => {
    const integers = schema({ count: { type: "integer" } })
    assertEquals(validateAgainstSchema(integers, { count: 1.5 }).ok, false)
    assertEquals(
      validateAgainstSchema(schema({ count: { type: "number" } }), { count: 1.5 }).ok,
      true,
    )
  })

  it("rejects an undeclared argument when additionalProperties is false", () => {
    const strict = {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }
    const result = validateAgainstSchema(strict, { text: "hello", extra: 1 })
    assertEquals(result.ok, false)
    if (result.ok) return
    assert(result.message.includes("Unexpected argument(s): extra"))
  })

  it("tolerates an undeclared argument when additionalProperties is unspecified", () => {
    const result = validateAgainstSchema(schema({ text: { type: "string" } }), {
      text: "hello",
      extra: 1,
    })
    assertEquals(result.ok, true)
  })

  it("reports an unsupported keyword as a failed validation, not a throw", () => {
    const unsupported = schema({ text: { type: "string", pattern: "^a" } })
    const result = validateAgainstSchema(unsupported, { text: "abc" })
    assertEquals(result.ok, false)
    if (result.ok) return
    assert(result.message.includes("Invalid inputSchema"))
  })

  it("refuses a schema using anyOf at registration time instead of ignoring it", () => {
    let thrown: unknown
    try {
      compileInputSchema(schema({ value: { anyOf: [{ type: "string" }, { type: "number" }] } }))
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes('keyword "anyOf"'), (thrown as Error).message)
  })

  it("reports a missing items node on an array as a failed validation", () => {
    const result = validateAgainstSchema(schema({ tags: { type: "array" } }), { tags: [] })
    assertEquals(result.ok, false)
    if (result.ok) return
    assert(result.message.includes('has no "items"'))
  })
})

describe("compileInputSchema", () => {
  it("compiles a schema once and reuses the validator", () => {
    const compiled = schema({ text: { type: "string" } }, ["text"])
    assertEquals(compileInputSchema(compiled), compileInputSchema(compiled))
  })

  it("throws at registration time for an unsupported type", () => {
    let thrown: unknown
    try {
      compileInputSchema(schema({ when: { type: "date-time" } }))
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assertEquals((thrown as Error).message.includes("not supported"), true)
  })

  it("throws at registration time for a required property that is not declared", () => {
    let thrown: unknown
    try {
      compileInputSchema(schema({ text: { type: "string" } }, ["missing"]))
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes('requires "missing"'))
  })

  it("throws at registration time for an empty enum", () => {
    let thrown: unknown
    try {
      compileInputSchema(schema({ unit: { enum: [] } }))
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes("enum"))
  })
})

describe("arkTypeValidator", () => {
  it("adapts a hand-written arktype schema to the validator port", () => {
    const validate = arkTypeValidator(type({ url: "string" }))
    assertEquals(
      validate(schema({ url: { type: "string" } }), { url: "https://example.invalid/x" }),
      {
        ok: true,
        value: { url: "https://example.invalid/x" },
      },
    )
    const rejected = validate(schema({ url: { type: "string" } }), { url: 1 })
    assertEquals(rejected.ok, false)
  })

  it("rejects the call before the handler runs when the arktype schema fails", async () => {
    const definition: ToolDefinition = {
      name: "noop",
      description: "no-op",
      inputSchema: schema({ url: { type: "string" } }, ["url"]),
    }
    const registry = new ToolRegistry()
    let handlerRan = false
    registry.register(definition, () => {
      handlerRan = true
      return { success: true, output: "ok" }
    })

    const outcome = await invokeTool(
      registry,
      "noop",
      { url: 1 },
      arkTypeValidator(type({ url: "string" })),
    )
    assertEquals(outcome.kind, "invalid")
    assertEquals(handlerRan, false)
  })
})
