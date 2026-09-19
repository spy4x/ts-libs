// ── JSON Schema → arktype validation ──
// `inputSchema` stays the wire contract (MCP sends JSON Schema). The repo forbids a
// hand-rolled validator, so the supported subset of a schema is compiled, once at
// registration time, into an arktype definition and arktype does the validating. A
// keyword this converter does not implement throws loudly instead of silently
// accepting unvalidated arguments.
//
// arktype 2 cannot parse an object literal from a string, so the definition is built
// as a plain object whose *values* are arktype type expressions — the same form
// `type({ name: "string" })` uses.

import { type } from "arktype"
import type { JsonSchemaObject } from "./tools.ts"

/**
 * A compiled arktype validator. arktype's own `Type` type is not callable in a type
 * position here, so this narrow structural shape is used instead: call it with a value
 * and test the result with `instanceof type.errors`.
 */
export interface CompiledValidator {
  (value: unknown): unknown
  errors?: unknown
}

/** A JSON Schema node. Recursive, so it is authored as an interface. */
export interface JsonSchemaNode {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null"
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
}

/**
 * Schema keywords the converter implements. Any other key on a node is refused at
 * conversion time rather than ignored: a constraint that silently does nothing is
 * worse than a registration that fails.
 */
const SUPPORTED_NODE_KEYS = new Set([
  "type",
  "enum",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
])

/** Result of validating arguments against a tool's `inputSchema`. */
export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string }

/** Validates a tool's arguments. Injectable so the handler is testable without arktype. */
export type SchemaValidator = (
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
) => ValidationResult

// One compiled arktype validator per schema object. Schemas are authored once at
// registration and reused for every call, so a WeakMap keyed on the schema is enough.
const compiled = new WeakMap<object, CompiledValidator>()

/**
 * Translate one schema node into an arktype definition value: a string for a scalar,
 * `"x[]"` for an array, a nested object for an object.
 */
export function schemaToArkTypeDefinition(node: JsonSchemaNode, path = "arguments"): unknown {
  refuseUnsupportedKeys(node, path)
  const members: string[] = []

  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) throw new Error(`inputSchema enum at ${path} is empty`)
    const literals: string[] = []
    for (const member of node.enum) {
      if (typeof member !== "string" && typeof member !== "number") {
        throw new Error(
          `inputSchema enum at ${path} must hold strings or numbers, got ${typeof member}`,
        )
      }
      literals.push(JSON.stringify(member))
    }
    // Parenthesised: arktype resolves an unquoted word as a keyword, so a member named
    // "string" would otherwise be read as the string *type*.
    const literal = literals.length === 1 ? literals[0] : `(${literals.join(" | ")})`
    members.push(literal)
  }

  if (node.type === undefined) {
    if (members.length === 0) {
      throw new Error(`inputSchema node at ${path} has neither "type" nor "enum"`)
    }
    return members.length === 1 ? members[0] : members.join(" | ")
  }

  const expression = nodeExpression(node, path)
  // `enum` narrows a scalar `type`. An object type has no enumerated form.
  if (members.length === 0) return expression
  if (typeof expression !== "string") {
    throw new Error(`inputSchema at ${path} combines "enum" with an object type`)
  }
  return members.length === 1 ? members[0] : `(${members.join(" | ")})`
}

function refuseUnsupportedKeys(node: JsonSchemaNode, path: string): void {
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_NODE_KEYS.has(key)) {
      throw new Error(`inputSchema keyword "${key}" at ${path} is not supported`)
    }
  }
}

function nodeExpression(node: JsonSchemaNode, path: string): string | Record<string, unknown> {
  switch (node.type) {
    case "object":
      return objectDefinition(node, path)
    // arktype keywords are bare words; a quoted `"string"` would mean the literal.
    case "string":
      return "string"
    case "null":
      return "null"
    case "number":
      return "number"
    case "integer":
      return "number.integer"
    case "boolean":
      return "boolean"
    case "array": {
      if (!node.items) throw new Error(`inputSchema array at ${path} has no "items"`)
      const items = schemaToArkTypeDefinition(node.items, `${path}[]`)
      return typeof items === "string" ? `${items}[]` : `${JSON.stringify(items)}[]`
    }
    default:
      throw new Error(`inputSchema type "${String(node.type)}" at ${path} is not supported`)
  }
}

function objectDefinition(node: JsonSchemaNode, path: string): Record<string, unknown> {
  const required = new Set(node.required ?? [])
  for (const key of required) {
    if (!node.properties?.[key]) {
      throw new Error(`inputSchema requires "${key}" at ${path} but does not declare it`)
    }
  }

  const definition: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    const value = schemaToArkTypeDefinition(property, `${path}.${key}`)
    definition[`${key}${required.has(key) ? "" : "?"}`] = value
  }
  return definition
}

/**
 * Compile a tool `inputSchema` into an arktype validator, cached per schema object.
 * Throws when the schema uses an unsupported keyword — a registration-time failure, so
 * a broken tool never serves a request.
 */
export function compileInputSchema(schema: JsonSchemaObject): CompiledValidator {
  const cached = compiled.get(schema)
  if (cached) return cached

  const definition = objectDefinition(schema as JsonSchemaNode, "arguments")
  // arktype throws on a definition it cannot parse — that is the registration-time
  // loud failure, so no extra guard is needed here. The cast is the one place this
  // package crosses into a third-party library's types: `Type` is not callable in a
  // type position, so the narrow `CompiledValidator` shape is used instead.
  const validator = type(definition) as unknown as CompiledValidator
  compiled.set(schema, validator)
  return validator
}

/**
 * Validate `args` against `schema` with arktype.
 *
 * Unknown keys follow JSON Schema's `additionalProperties`: absent or `true` leaves
 * them in place, `false` rejects the call. arktype itself treats undeclared keys as
 * optional, so the `false` case is checked explicitly here.
 *
 * A `TypeError` from an unsupported schema keyword becomes a failed
 * `ValidationResult` carrying the message, so the JSON-RPC layer answers `-32602`
 * instead of throwing.
 */
export function validateAgainstSchema(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): ValidationResult {
  let validator: CompiledValidator
  try {
    validator = compileInputSchema(schema)
  } catch (error) {
    return { ok: false, message: `Invalid inputSchema: ${describe(error)}` }
  }

  if (schema.additionalProperties === false) {
    const declared = new Set(Object.keys(schema.properties ?? {}))
    const unexpected = Object.keys(args).filter((key) => !declared.has(key))
    if (unexpected.length > 0) {
      return { ok: false, message: `Unexpected argument(s): ${unexpected.join(", ")}` }
    }
  }

  const result = validator(args)
  if (result instanceof type.errors) return { ok: false, message: result.summary }
  return { ok: true, value: result as Record<string, unknown> }
}

/**
 * Adapter for tool authors who would rather write an arktype schema than a JSON Schema.
 * The supplied `Type` replaces the schema-derived validator, so the `inputSchema`
 * argument the port passes in is ignored.
 *
 * `inputSchema` still has to be supplied on the tool definition: arktype 2 does not
 * emit standard JSON Schema, and `tools/list` must advertise a JSON Schema wire
 * contract for clients.
 */
export function arkTypeValidator(validator: (value: unknown) => unknown): SchemaValidator {
  return (_schema, args) => {
    const result = validator(args)
    if (result instanceof type.errors) return { ok: false, message: result.summary }
    return { ok: true, value: result as Record<string, unknown> }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
