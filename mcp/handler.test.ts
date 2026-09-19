// Tests for the JSON-RPC 2.0 core: error codes, method allow-listing and the
// parse-error path. Every request is a string built in-process — no transport.

import { assert, assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { JsonRpcErrorCode } from "./jsonrpc.ts"
import { MCP_PROTOCOL_VERSION, McpHandler } from "./handler.ts"
import { FAKE_TOKEN, toolSchema } from "./test-helpers.ts"

function createHandler(): McpHandler {
  const handler = new McpHandler({ serverInfo: { name: "test-server", version: "0.1.0" } })
  handler.registerTool({
    name: "echo",
    description: "Echo the given text back",
    inputSchema: toolSchema({ text: { type: "string" } }, ["text"]),
  }, (args) => ({ success: true, output: args.text }))
  handler.registerTool({
    name: "explode",
    description: "Always throws",
    inputSchema: toolSchema({}),
  }, () => {
    throw new Error("transport exploded")
  })
  handler.registerTool({
    name: "empty",
    description: "Returns a valid empty result",
    inputSchema: toolSchema({}),
  }, () => ({ success: true, output: null }))
  return handler
}

async function call(handler: McpHandler, message: unknown) {
  return await handler.handleMessage(JSON.stringify(message))
}

describe("McpHandler.handleMessage", () => {
  it("returns -32700 for malformed JSON instead of throwing", async () => {
    const response = await createHandler().handleMessage("{not json")
    assertEquals(response.error?.code, JsonRpcErrorCode.ParseError)
    assertEquals(response.error?.message, "Parse error")
    assertEquals(response.id, null)
    assertEquals(response.jsonrpc, "2.0")
  })

  it("returns -32700 for a truncated JSON-RPC frame", async () => {
    const response = await createHandler().handleMessage('{"jsonrpc":"2.0","method":"tools/list"')
    assertEquals(response.error?.code, JsonRpcErrorCode.ParseError)
  })

  it("returns -32600 for a JSON array, which is not a JSON-RPC request", async () => {
    const response = await createHandler().handleMessage("[1,2,3]")
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidRequest)
  })

  it("returns -32600 when the jsonrpc field is missing", async () => {
    const response = await call(createHandler(), { id: 1, method: "tools/list" })
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidRequest)
  })
})

describe("method allow-listing", () => {
  const forbidden = [
    "shutdown",
    "tools/delete",
    "resources/list",
    "prompts/list",
    "tools/call ",
    "__proto__",
    "constructor",
  ]

  for (const method of forbidden) {
    it(`returns -32601 for the unknown method "${method}"`, async () => {
      const response = await call(createHandler(), { jsonrpc: "2.0", id: 7, method, params: {} })
      assertEquals(response.error?.code, JsonRpcErrorCode.MethodNotFound)
      assertEquals(response.id, 7)
      assert(
        response.result === undefined,
        "an unknown method must not produce a result",
      )
    })
  }

  it("returns -32601 rather than reaching a registered handler", async () => {
    const response = await call(createHandler(), {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call/extra",
      params: { name: "echo", arguments: { text: "x" } },
    })
    assertEquals(response.error?.code, JsonRpcErrorCode.MethodNotFound)
  })

  it("returns -32601 for an empty method name rather than falling through", async () => {
    const response = await call(createHandler(), { jsonrpc: "2.0", id: 9, method: "" })
    assertEquals(response.error?.code, JsonRpcErrorCode.MethodNotFound)
    assert(response.result === undefined)
  })
})

describe("initialize", () => {
  it("advertises protocol 2024-11-05, the tools capability and the server info", async () => {
    const response = await call(createHandler(), { jsonrpc: "2.0", id: 1, method: "initialize" })
    const result = response.result as {
      protocolVersion: string
      capabilities: { tools: unknown }
      serverInfo: { name: string; version: string }
    }
    assertEquals(result.protocolVersion, MCP_PROTOCOL_VERSION)
    assertEquals(result.protocolVersion, "2024-11-05")
    assertEquals(result.capabilities.tools, {})
    assertEquals(result.serverInfo, { name: "test-server", version: "0.1.0" })
  })

  it("echoes a protocol version it does not implement without failing", async () => {
    const response = await call(createHandler(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })
    const result = response.result as { protocolVersion: string }
    assertEquals(result.protocolVersion, MCP_PROTOCOL_VERSION)
    assertEquals(response.error, undefined)
  })

  it("answers notifications/initialized without an error", async () => {
    const response = await call(createHandler(), {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
    assertEquals(response.error, undefined)
    assertEquals(response.result, null)
  })

  it("rejects tools/list before initialize with -32603", async () => {
    const response = await call(createHandler(), { jsonrpc: "2.0", id: 2, method: "tools/list" })
    assertEquals(response.error?.code, JsonRpcErrorCode.InternalError)
    assert(JSON.stringify(response.error).includes("initialize"))
  })

  it("serves tools/list after initialize", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    assert(response.error === undefined)
  })
})

describe("tools/list", () => {
  it("returns every registered tool with its JSON-Schema input contract", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools =
      (response.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools
    assertEquals(tools.map((tool) => tool.name).sort(), ["echo", "empty", "explode"])
    const echo = tools.find((tool) => tool.name === "echo")
    assertEquals(echo?.inputSchema, toolSchema({ text: { type: "string" } }, ["text"]))
  })

  it("returns an empty list when no tool is registered", async () => {
    const handler = new McpHandler({ serverInfo: { name: "empty-server", version: "0.1.0" } })
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    assertEquals((response.result as { tools: unknown[] }).tools, [])
  })
})

describe("tools/call", () => {
  it("returns -32602 for an unregistered tool without throwing", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "no-such-tool", arguments: {} },
    })
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidParams)
    assert(JSON.stringify(response.error).includes("Unknown tool: no-such-tool"))
    assert(response.result === undefined)
  })

  it("returns -32602 when params.name is missing", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {},
    })
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidParams)
  })

  it("returns -32602 when params itself is missing", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, { jsonrpc: "2.0", id: 3, method: "tools/call" })
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidParams)
  })

  it("returns -32602 when arguments is not an object", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: "text" },
    })
    assertEquals(response.error?.code, JsonRpcErrorCode.InvalidParams)
  })

  it("returns the tool envelope as text content", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: { text: FAKE_TOKEN } },
    })
    const result = response.result as { content: Array<{ type: string; text: string }> }
    assertEquals(result.content[0].type, "text")
    assertEquals(JSON.parse(result.content[0].text), { success: true, output: FAKE_TOKEN })
  })

  it("reports a throwing handler as an isError tool result, not a JSON-RPC error", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })
    const response = await call(handler, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "explode", arguments: {} },
    })
    // A handler exception is a tool error result, not a JSON-RPC error.
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> }
    assertEquals(result.isError, true)
    assertEquals(JSON.parse(result.content[0].text), {
      success: false,
      output: null,
      error: "transport exploded",
    })
    assertEquals(response.error, undefined)
  })
})

describe("transport failure versus valid empty result", () => {
  it("distinguishes a failed result from a valid empty result", async () => {
    const handler = createHandler()
    await call(handler, { jsonrpc: "2.0", id: 1, method: "initialize" })

    const failed = await call(handler, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "explode", arguments: {} },
    })
    const empty = await call(handler, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "empty", arguments: {} },
    })

    const failedResult = failed.result as { isError?: boolean; content: Array<{ text: string }> }
    const emptyResult = empty.result as { isError?: boolean; content: Array<{ text: string }> }

    assertEquals(failedResult.isError, true)
    assertEquals(emptyResult.isError, undefined)
    assertEquals(JSON.parse(failedResult.content[0].text), {
      success: false,
      output: null,
      error: "transport exploded",
    })
    assertEquals(JSON.parse(emptyResult.content[0].text), { success: true, output: null })
    assert(
      failedResult.content[0].text !== emptyResult.content[0].text,
      "a transport failure must not look like an empty result",
    )
  })
})
