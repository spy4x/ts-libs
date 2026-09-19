// ── MCP JSON-RPC handler ──
// Protocol lifecycle: initialize → notifications/initialized → tools/list →
// tools/call. Methods are dispatched by an explicit switch: an unknown method can
// never reach a tool, and a tool name that is not registered can never reach a
// handler.

import {
  jsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcResult,
} from "./jsonrpc.ts"
import {
  errorMessage,
  invokeTool,
  type ToolDefinition,
  type ToolHandler,
  ToolRegistry,
} from "./tools.ts"
import type { InitializeResult, McpServerInfo, ToolResult } from "./types.ts"

/** The MCP protocol revision this core implements. */
export const MCP_PROTOCOL_VERSION = "2024-11-05"

/** Methods this server answers. Anything else is `-32601`. */
export const MCP_METHODS = [
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
] as const

/** Options for {@link McpHandler}. */
export interface McpHandlerOptions {
  /** Identity reported in the `initialize` result. */
  serverInfo: McpServerInfo
  /** Tools to expose. A fresh registry when omitted. */
  registry?: ToolRegistry
  /**
   * Reject `tools/list` / `tools/call` before `initialize` with `-32603`. MCP requires
   * the handshake; a client that skips it is broken, not merely optimistic. Set false
   * only for tests or a transport that owns its own lifecycle check.
   */
  requireInitialized?: boolean
}

/**
 * Serves the MCP tools lifecycle over any transport. Holds only per-connection state
 * (the initialize flag and the tool registry), so callers may create one per
 * connection or share one; both are correct.
 */
export class McpHandler {
  readonly registry: ToolRegistry
  private readonly serverInfo: McpServerInfo
  private readonly requireInitialized: boolean
  private initialized = false

  constructor(options: McpHandlerOptions) {
    this.serverInfo = options.serverInfo
    this.registry = options.registry ?? new ToolRegistry()
    this.requireInitialized = options.requireInitialized ?? true
  }

  /** Register one tool. The CalDAV bindings (#13) call this. */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.registry.register(definition, handler)
  }

  /** True once `initialize` has been handled. */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Parse and handle one newline-delimited JSON-RPC message. A message that is not
   * valid JSON, or not a JSON-RPC request object, comes back as a well-formed error
   * response — this method never throws.
   */
  async handleMessage(message: string): Promise<JsonRpcResponse> {
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return jsonRpcError(null, JsonRpcErrorCode.ParseError)
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return jsonRpcError(null, JsonRpcErrorCode.InvalidRequest)
    }

    return await this.handleRequest(parsed as JsonRpcRequest)
  }

  /** Handle a parsed JSON-RPC request. Never throws. */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id: JsonRpcId = request.id ?? null

    if (request.jsonrpc !== "2.0") {
      return jsonRpcError(id, JsonRpcErrorCode.InvalidRequest, 'Missing or invalid "jsonrpc"')
    }
    if (typeof request.method !== "string") {
      return jsonRpcError(id, JsonRpcErrorCode.InvalidRequest, 'Missing "method"')
    }

    switch (request.method) {
      case "initialize":
        return this.handleInitialize(id)
      case "notifications/initialized":
        // Notification: acknowledge locally, the transport sends nothing back.
        return jsonRpcResult(id, null)
      case "tools/list":
        return this.handleToolsList(id)
      case "tools/call":
        return await this.handleToolsCall(id, request.params)
      default:
        // Allow-list by construction: no other method reaches a handler.
        return jsonRpcError(
          id,
          JsonRpcErrorCode.MethodNotFound,
          `Method not found: ${request.method}`,
        )
    }
  }

  private handleInitialize(id: JsonRpcId): JsonRpcResponse {
    this.initialized = true
    // A client asking for another revision gets this server's revision back and
    // decides whether it can proceed — see README, "Protocol version pin".
    const result: InitializeResult = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: this.serverInfo,
    }
    return jsonRpcResult(id, result as unknown as Record<string, unknown>)
  }

  private handleToolsList(id: JsonRpcId): JsonRpcResponse {
    const denial = this.initializationGuard(id)
    if (denial) return denial
    return jsonRpcResult(id, { tools: this.registry.list() } as unknown as Record<string, unknown>)
  }

  private async handleToolsCall(
    id: JsonRpcId,
    params: Record<string, unknown> | undefined,
  ): Promise<JsonRpcResponse> {
    const denial = this.initializationGuard(id)
    if (denial) return denial

    if (typeof params !== "object" || params === null) {
      return jsonRpcError(id, JsonRpcErrorCode.InvalidParams, 'Missing "params"')
    }
    const name = params.name
    if (typeof name !== "string" || name.length === 0) {
      return jsonRpcError(id, JsonRpcErrorCode.InvalidParams, 'Missing "params.name"')
    }

    const rawArgs = params.arguments
    if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
      return jsonRpcError(
        id,
        JsonRpcErrorCode.InvalidParams,
        '"params.arguments" must be an object',
      )
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>

    try {
      const invoked = await invokeTool(this.registry, name, args)

      if (invoked.kind === "invalid") {
        // Unknown tool or failed input validation: a protocol-level error.
        return jsonRpcError(id, JsonRpcErrorCode.InvalidParams, invoked.message)
      }
      if (invoked.kind === "failed") {
        // The tool exists and its arguments were valid, so the failure belongs to the
        // tool. Reported as a tool error result, never as a JSON-RPC error.
        return jsonRpcResult(
          id,
          toolFailureResult(invoked.message) as unknown as Record<
            string,
            unknown
          >,
        )
      }

      const result: ToolResult = {
        content: [{ type: "text", text: JSON.stringify(invoked.outcome) }],
        structuredContent: { envelope: invoked.outcome } as Record<string, unknown>,
        ...(invoked.outcome.success ? {} : { isError: true }),
      }
      return jsonRpcResult(id, result as unknown as Record<string, unknown>)
    } catch (error) {
      // Only reachable if a future change makes invokeTool throw. Reported as a
      // JSON-RPC error rather than an unhandled rejection.
      return jsonRpcError(
        id,
        JsonRpcErrorCode.InternalError,
        `Internal error: ${errorMessage(error)}`,
      )
    }
  }

  private initializationGuard(id: JsonRpcId): JsonRpcResponse | undefined {
    if (!this.requireInitialized || this.initialized) return undefined
    return jsonRpcError(
      id,
      JsonRpcErrorCode.InternalError,
      "Server not initialized: send initialize first",
    )
  }
}

/** Convenience factory matching the source's `new McpHandler({ name, version })` call. */
export function createMcpHandler(serverInfo: McpServerInfo): McpHandler {
  return new McpHandler({ serverInfo })
}

/**
 * `tools/call` result for a handler that threw. `isError: true` is what makes a
 * transport failure distinguishable from a valid result that happens to be empty —
 * and the envelope is still the house `{ success, output, error }` shape.
 */
function toolFailureResult(reason: string): ToolResult {
  const envelope = { success: false, output: null, error: reason }
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: { envelope } as Record<string, unknown>,
    isError: true,
  }
}
