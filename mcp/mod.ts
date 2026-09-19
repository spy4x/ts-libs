// ── @ts-libs/mcp ──
// Zero-dependency MCP (Model Context Protocol) core: a JSON-RPC 2.0 handler for the
// tools lifecycle, a tool registry with JSON-Schema input validation, and two
// transports (stdio and HTTP, including an SSE stream).
//
// Deliberately absent: the official `npm:@modelcontextprotocol/sdk`, the MCP
// resources/prompts APIs, and the CalDAV tool bindings (those are `#13`).

export {
  createMcpHandler,
  MCP_METHODS,
  MCP_PROTOCOL_VERSION,
  McpHandler,
  type McpHandlerOptions,
} from "./handler.ts"

export {
  jsonRpcError,
  JsonRpcErrorCode,
  jsonRpcErrorMessages,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonRpcResult,
} from "./jsonrpc.ts"

export {
  errorMessage,
  type InvokeOutcome,
  invokeTool,
  isToolOutcome,
  type JsonSchemaObject,
  registerAllTools,
  type RegisteredTool,
  type ToolDefinition,
  type ToolHandler,
  ToolRegistry,
  toToolOutcome,
} from "./tools.ts"

export {
  arkTypeValidator,
  compileInputSchema,
  type JsonSchemaNode,
  schemaToArkTypeDefinition,
  type SchemaValidator,
  validateAgainstSchema,
  type ValidationResult,
} from "./schema.ts"

export {
  AUTHORIZATION_HEADER,
  bearerTokenFromEnv,
  bearerTokenFromHeaders,
  constantTimeEquals,
  createTokenVerifier,
  formatLogLine,
  REDACTED_TOKEN,
  redactor,
  type TokenVerifier,
} from "./auth.ts"

export {
  clientIp,
  createRateLimitStore,
  MemoryRateLimitStore,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  retryAfterSeconds,
} from "./rate-limit.ts"

export {
  startStdioTransport,
  stdinReader,
  STDIO_BUFFER_SIZE,
  type StdioTransportOptions,
  stdoutWriter,
  type SyncReader,
  type SyncWriter,
} from "./stdio.ts"

export {
  createHttpTransport,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_BODY_BYTES,
  type HeartbeatProducer,
  type HttpLogger,
  type HttpTransportOptions,
  intervalHeartbeat,
  sseResponse,
} from "./http.ts"

export type {
  InitializeResult,
  JsonRpcError,
  JsonRpcId,
  McpCapabilities,
  McpServerInfo,
  ToolContent,
  ToolOutcome,
  ToolResult,
  Transport,
} from "./types.ts"
