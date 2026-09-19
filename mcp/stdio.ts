// ── stdio transport ──
// The source's synchronous loop, with the reader and writer injected so the framing
// is testable in-process. A caller that wants real stdio passes the two Deno-backed
// adapters at the bottom of this file; tests pass in-memory equivalents.

import type { McpHandler } from "./handler.ts"

/** Synchronous byte source. `read` returning `null` means end of input. */
export interface SyncReader {
  read(buffer: Uint8Array): number | null
}

/** Synchronous byte sink. */
export interface SyncWriter {
  write(bytes: Uint8Array): void
}

/** Options for {@link startStdioTransport}. */
export interface StdioTransportOptions {
  handler: McpHandler
  reader: SyncReader
  writer: SyncWriter
  /** Read buffer size in bytes. Defaults to 64 KiB, as the source used. */
  bufferSize?: number
  /** Called once when the reader signals end of input. */
  onEnd?: () => void
}

/** Default read buffer: 64 KiB, matching the source. */
export const STDIO_BUFFER_SIZE = 65_536

/**
 * Serve newline-delimited JSON-RPC until the reader is exhausted. Framing is exact: a
 * chunk boundary inside a message or inside a multi-byte character is preserved by the
 * streaming decoder plus the carry-over buffer. Messages are handled strictly in
 * order — each response is awaited before more input is read, so a slow tool handler
 * cannot let a later request overtake an earlier one.
 *
 * A malformed message is answered with `-32700` by `handler.handleMessage`, so this
 * loop throws only on a reader failure: that is a transport failure, not "no data".
 */
export async function startStdioTransport(options: StdioTransportOptions): Promise<void> {
  const { handler, reader, writer } = options
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const buffer = new Uint8Array(options.bufferSize ?? STDIO_BUFFER_SIZE)
  let pending = ""

  while (true) {
    let read: number | null
    try {
      read = reader.read(buffer)
    } catch (error) {
      throw new Error(`stdio read failed: ${message(error)}`)
    }
    if (read === null) break

    pending += decoder.decode(buffer.subarray(0, read), { stream: true })

    let newline = pending.indexOf("\n")
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")

      if (line.length === 0) continue

      const response = await handler.handleMessage(line)
      writer.write(encoder.encode(`${JSON.stringify(response)}\n`))
    }
  }

  // Flush a final message that arrived without a trailing newline.
  const tail = `${pending}${decoder.decode()}`.trim()
  if (tail.length > 0) {
    const response = await handler.handleMessage(tail)
    writer.write(encoder.encode(`${JSON.stringify(response)}\n`))
  }

  options.onEnd?.()
}

/** Production wiring for stdin. */
export function stdinReader(): SyncReader {
  return {
    read(buffer: Uint8Array): number | null {
      return Deno.stdin.readSync(buffer)
    },
  }
}

/** Production wiring for stdout. Writes until the whole buffer is flushed. */
export function stdoutWriter(): SyncWriter {
  return {
    write(bytes: Uint8Array): void {
      let offset = 0
      while (offset < bytes.byteLength) {
        offset += Deno.stdout.writeSync(bytes.subarray(offset))
      }
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
