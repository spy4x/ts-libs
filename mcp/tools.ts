// ── Tool registration layer ──
// Keeps the source's `ToolDefinition` / `ToolHandler` / `registerAllTools` shape. The
// CalDAV bindings live in `@ts-libs/caldav`, not here; this module only owns the
// registry and the schema validation contract.

import type { ToolOutcome } from "./types.ts"
import { type SchemaValidator, validateAgainstSchema } from "./schema.ts"

/** The default validator: arktype, compiled from the tool's JSON Schema. */
export const defaultSchemaValidator: SchemaValidator = (schema, args) =>
  validateAgainstSchema(schema, args)

/** A JSON Schema object as MCP sends it. Only the subset in `schema.ts` is supported. */
export interface JsonSchemaObject {
  type: "object"
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

/** A tool as advertised by `tools/list`. `inputSchema` is the wire contract. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

/**
 * A tool implementation. Returning an `unknown` value is wrapped into a successful
 * `ToolOutcome` by the registry; returning a `ToolOutcome` is passed through so a
 * handler can report a domain failure without throwing.
 */
export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** A registered tool: its advertisement plus its implementation. */
export interface RegisteredTool {
  definition: ToolDefinition
  handler: ToolHandler
}

/**
 * Holds every tool a server exposes. One registry per server instance — the returned
 * object has no module-level state, so two servers cannot leak tools into each other.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  /** Register a tool. A duplicate name replaces the previous registration. */
  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler })
  }

  /** The registered tool, or `undefined` when the name is unknown. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  /** Whether `name` is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Registered definitions in registration order — the `tools/list` payload. */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition)
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }
}

/** Outcome of one tool invocation. */
export type InvokeOutcome =
  | { kind: "ok"; outcome: ToolOutcome }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string }

/** Normalise whatever a handler returned into the house envelope. */
export function toToolOutcome(returned: unknown): ToolOutcome {
  if (isToolOutcome(returned)) return returned
  return { success: true, output: returned }
}

/** True for a value that already carries the `{ success, output, error }` envelope. */
export function isToolOutcome(value: unknown): value is ToolOutcome {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as { success?: unknown }).success === "boolean"
}

/**
 * Validate arguments and run one tool. Never throws: a missing tool, a schema
 * violation and a handler exception each come back as a distinct `InvokeOutcome`, so
 * the caller can map them to a JSON-RPC error or a `tools/call` error result without
 * guessing why it failed.
 */
export async function invokeTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  validator: SchemaValidator = defaultSchemaValidator,
): Promise<InvokeOutcome> {
  const tool = registry.get(name)
  if (!tool) return { kind: "invalid", message: `Unknown tool: ${name}` }

  const validated = validator(tool.definition.inputSchema, args)
  if (!validated.ok) {
    return { kind: "invalid", message: validated.message }
  }

  try {
    return { kind: "ok", outcome: toToolOutcome(await tool.handler(validated.value)) }
  } catch (error) {
    return { kind: "failed", message: errorMessage(error) }
  }
}

/** Message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register a whole set of tools against a registry. Sibling packages (the CalDAV
 * bindings in `#13`) keep their own `registerXxxTools(registry, deps)` functions with
 * this signature and are called from an entry point, exactly as the source did.
 */
export function registerAllTools(
  registry: ToolRegistry,
  registrars: ReadonlyArray<(registry: ToolRegistry) => void>,
): void {
  for (const registrar of registrars) registrar(registry)
}
