// ── JSON-RPC 2.0 wire types and error codes ──

import type { JsonRpcError, JsonRpcId, ToolResult } from "./types.ts"

/** JSON-RPC 2.0 error codes used by the MCP core. */
export enum JsonRpcErrorCode {
  /** Invalid JSON was received by the server. */
  ParseError = -32700,
  /** The JSON sent is not a valid Request object. */
  InvalidRequest = -32600,
  /** The requested method does not exist. */
  MethodNotFound = -32601,
  /** Invalid method parameters, including unknown tools and failed input validation. */
  InvalidParams = -32602,
  /** The server hit an unexpected condition while handling the request. */
  InternalError = -32603,
}

/** Canonical message for each code. Unknown codes fall back to "Error". */
export const jsonRpcErrorMessages: Record<number, string> = {
  [JsonRpcErrorCode.ParseError]: "Parse error",
  [JsonRpcErrorCode.InvalidRequest]: "Invalid request",
  [JsonRpcErrorCode.MethodNotFound]: "Method not found",
  [JsonRpcErrorCode.InvalidParams]: "Invalid params",
  [JsonRpcErrorCode.InternalError]: "Internal error",
}

export type { JsonRpcId } from "./types.ts"

/** A JSON-RPC 2.0 request. `id` is absent on notifications. */
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id?: JsonRpcId
}

/** A JSON-RPC 2.0 response. Exactly one of `result` / `error` is present. */
export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: ToolResult | Record<string, unknown> | null
  error?: JsonRpcError
}

/** Build an error response with the canonical message for `code` (or a custom one). */
export function jsonRpcError(
  id: JsonRpcId,
  code: JsonRpcErrorCode,
  message?: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = {
    code,
    message: message ?? jsonRpcErrorMessages[code] ?? "Error",
  }
  if (data !== undefined) error.data = data
  return { jsonrpc: "2.0", id, error }
}

/** Build a success response. */
export function jsonRpcResult(id: JsonRpcId, result: JsonRpcResponse["result"]): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}
