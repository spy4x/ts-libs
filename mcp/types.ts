// ── Shared MCP wire types ──
// The shapes MCP clients and servers exchange, plus the `{ success, output, error }`
// envelope every fallible tool result is reported through (house convention).

/** JSON-RPC message id. `null` is reserved for errors with no matching request. */
export type JsonRpcId = string | number | null

/** Content block returned by a tool. Only text is produced by this core. */
export interface ToolContent {
  type: "text"
  text: string
}

/** Result of a successful `tools/call`, as MCP defines it. */
export interface ToolResult {
  content: ToolContent[]
  /** Structured mirror of `content[0].text`, read by clients that want the envelope. */
  structuredContent?: Record<string, unknown>
  /** Set when the tool itself failed. Distinguishable from an empty valid result. */
  isError?: boolean
}

/** JSON-RPC error object. */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** Envelope returned by a tool handler. `success` is the discriminator. */
export interface ToolOutcome {
  success: boolean
  output: unknown
  error?: string
}

/** Server identity advertised in the `initialize` result. */
export interface McpServerInfo {
  name: string
  version: string
}

/** Advertised MCP capabilities. This core implements tools only. */
export interface McpCapabilities {
  tools: Record<string, never>
}

/** Result payload of the `initialize` method. */
export interface InitializeResult {
  protocolVersion: string
  capabilities: McpCapabilities
  serverInfo: McpServerInfo
}

/** Wire transport a handler is serving, when a caller needs to branch on it. */
export type Transport = "stdio" | "http"
