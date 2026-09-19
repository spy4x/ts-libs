/**
 * `text/event-stream` frame formatting.
 *
 * Server-sent events are a line protocol: a frame ends at a blank line, and a
 * field's value ends at the newline. The source built frames with
 * `controller.enqueue(\`event: ${name}\ndata:${JSON.stringify(data)}\n\n\`)`
 * (`roley/.../helpers.ts:184`), which happened to be safe only because
 * `JSON.stringify` escapes newlines. This module splits the payload into one
 * `data:` line per line instead, so a payload that is a plain text block — a
 * log, a stack trace — cannot terminate the frame early.
 */

/** One SSE frame. */
export interface SseFrame {
  /** Event name; omit for the client's default `message` event. */
  event?: string
  /** Payload. Newlines become additional `data:` lines. */
  data: string
  /** Event id, echoed back as `Last-Event-ID` on reconnect. */
  id?: string
  /** Client reconnect delay in milliseconds. */
  retry?: number
}

/**
 * Formats one frame, terminator included.
 *
 * A carriage return inside a field value is treated as a line break: the SSE
 * grammar forbids CR and LF in a value, and a stray CR from a Windows-produced
 * log would otherwise corrupt the frame on the wire.
 */
export function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = []
  if (frame.event !== undefined) {
    lines.push(`event: ${frame.event}`)
  }
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`)
  }
  if (frame.retry !== undefined) {
    lines.push(`retry: ${frame.retry}`)
  }
  for (const line of frame.data.split(/\r\n|\n|\r/)) {
    lines.push(`data: ${line}`)
  }
  return `${lines.join("\n")}\n\n`
}
