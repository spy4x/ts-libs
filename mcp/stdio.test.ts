// Tests for the stdio transport. The reader and writer are injected: no real fd, no
// subprocess. Framing is checked at chunk boundaries, including a split multi-byte
// character and a message that arrives without a trailing newline.

import { assert, assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { McpHandler } from "./handler.ts"
import { startStdioTransport, type SyncReader, type SyncWriter } from "./stdio.ts"
import { toolSchema } from "./test-helpers.ts"

/** A reader over a fixed byte string, handing out at most `chunkSize` bytes per read. */
function stringReader(input: Uint8Array, chunkSize = input.byteLength): SyncReader {
  let offset = 0
  return {
    read(buffer: Uint8Array): number | null {
      if (offset >= input.byteLength) return null
      const size = Math.min(chunkSize, buffer.byteLength, input.byteLength - offset)
      buffer.set(input.subarray(offset, offset + size))
      offset += size
      return size
    },
  }
}

/** Collects every written byte and decodes the finished transcript. */
function collectingWriter(): SyncWriter & { transcript(): string } {
  const chunks: Uint8Array[] = []
  return {
    write(bytes: Uint8Array): void {
      chunks.push(bytes.slice())
    },
    transcript(): string {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const joined = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(joined)
    },
  }
}

function createHandler(): McpHandler {
  const handler = new McpHandler({ serverInfo: { name: "stdio-test", version: "0.1.0" } })
  handler.registerTool({
    name: "echo",
    description: "Echo text",
    inputSchema: toolSchema({ text: { type: "string" } }, ["text"]),
  }, (args) => ({ success: true, output: args.text }))
  return handler
}

function respondLines(transcript: string): Array<Record<string, unknown>> {
  return transcript
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const encoder = new TextEncoder()

describe("startStdioTransport", () => {
  it("answers one newline-delimited request and stops at EOF", async () => {
    const writer = collectingWriter()
    const input = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    )

    await startStdioTransport({
      handler: createHandler(),
      reader: stringReader(input),
      writer,
    })

    const lines = respondLines(writer.transcript())
    assertEquals(lines.length, 1)
    assertEquals(lines[0].id, 1)
    assertEquals((lines[0].result as { protocolVersion: string }).protocolVersion, "2024-11-05")
  })

  it("handles several requests on one line-separated read", async () => {
    const writer = collectingWriter()
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
    ]
    const input = encoder.encode(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""))

    await startStdioTransport({ handler: createHandler(), reader: stringReader(input), writer })

    const lines = respondLines(writer.transcript())
    assertEquals(lines.map((line) => line.id), [1, 2, 3])
    const call = lines[2].result as { content: Array<{ text: string }> }
    assertEquals(JSON.parse(call.content[0].text), { success: true, output: "hi" })
  })

  it("reassembles a message split across reads at an arbitrary byte boundary", async () => {
    const writer = collectingWriter()
    const input = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    )

    // One byte at a time: every boundary a network or pipe could produce.
    await startStdioTransport({
      handler: createHandler(),
      reader: stringReader(input, 1),
      writer,
    })

    const lines = respondLines(writer.transcript())
    assertEquals(lines.length, 1)
    assertEquals(lines[0].id, 1)
  })

  it("keeps a multi-byte character intact when the read splits it", async () => {
    const writer = collectingWriter()
    const payload = "héllo wörld ✓"
    const input = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n${
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "echo", arguments: { text: payload } },
        })
      }\n`,
    )

    // A 3-byte chunk splits the two-byte "é" and the three-byte "✓".
    await startStdioTransport({ handler: createHandler(), reader: stringReader(input, 3), writer })

    const line = respondLines(writer.transcript())[1]
    const result = line.result as { content: Array<{ text: string }> }
    assertEquals(JSON.parse(result.content[0].text).output, payload)
  })

  it("handles a final message that arrives without a trailing newline", async () => {
    const writer = collectingWriter()
    const input = encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize" }))

    await startStdioTransport({ handler: createHandler(), reader: stringReader(input), writer })

    const lines = respondLines(writer.transcript())
    assertEquals(lines.length, 1)
    assertEquals(lines[0].id, 5)
  })

  it("skips blank lines between frames", async () => {
    const writer = collectingWriter()
    const input = encoder.encode(
      `\n\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n\n`,
    )

    await startStdioTransport({ handler: createHandler(), reader: stringReader(input), writer })

    assertEquals(respondLines(writer.transcript()).length, 1)
  })

  it("answers a malformed frame with -32700 and keeps serving the next one", async () => {
    const writer = collectingWriter()
    const input = encoder.encode(
      `{not json\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" })}\n`,
    )

    await startStdioTransport({ handler: createHandler(), reader: stringReader(input), writer })

    const lines = respondLines(writer.transcript())
    assertEquals(lines.length, 2)
    assertEquals((lines[0].error as { code: number }).code, -32700)
    assertEquals(lines[0].id, null)
    assertEquals(lines[1].id, 2)
  })

  it("calls onEnd once at end of input", async () => {
    const writer = collectingWriter()
    let ended = 0
    await startStdioTransport({
      handler: createHandler(),
      reader: stringReader(new Uint8Array(0)),
      writer,
      onEnd: () => {
        ended += 1
      },
    })
    assertEquals(ended, 1)
    assertEquals(writer.transcript(), "")
  })

  it("throws on a reader failure rather than reporting an empty result", async () => {
    const writer = collectingWriter()
    const failing: SyncReader = {
      read(): number | null {
        throw new Error("device not configured")
      },
    }

    let thrown: unknown
    try {
      await startStdioTransport({ handler: createHandler(), reader: failing, writer })
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error)
    assert((thrown as Error).message.includes("stdio read failed: device not configured"))
  })
})
