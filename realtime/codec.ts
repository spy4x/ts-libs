/**
 * Wire protocol for a hint-only socket.
 *
 * ADR 002: REST is the external application protocol and the socket is a hint lane. Nothing in this
 * protocol can mutate anything, which is what keeps the socket from becoming a second, weaker
 * application surface with its own validation and authorization.
 *
 * Two rules follow, and both are visible in the shapes below:
 *
 * 1. A push is a {@link ServerHintMessage} — group, aggregate and the sequence the change was
 *    committed at. It carries no entity payload, so a dropped or duplicated hint costs at most one
 *    redundant pull.
 * 2. The only client frames are liveness and a sync handshake carrying the client's real cursors.
 *
 * Validation is arktype, the repository's only validator: a hand-rolled shape check would be a
 * second validator, and zod is not used anywhere here. Parsing has no global side effects — it does
 * not mutate arktype's config — and throws nothing: {@link MessageCodec.decode} returns a result.
 * The message types are declared explicitly rather than inferred, so the published protocol shape is
 * readable without arktype's type machinery.
 */

import { type Type, type } from "arktype"

import type { CursorSnapshot } from "./cursor.ts"

/** A client liveness frame. */
export interface ClientLivenessMessage {
  kind: "client.ping" | "client.pong"
  id?: string
}

/** The sync handshake: the cursors the client holds, or an explicit cold start. */
export interface ClientSyncMessage {
  kind: "client.sync"
  cursors: CursorSnapshot[]
  /** True when the client holds no durable cursor at all. */
  fromStart: boolean
  id?: string
}

/** Frames a client sends. Nothing here mutates anything. */
export type ClientMessage = ClientLivenessMessage | ClientSyncMessage

/** A server liveness frame. */
export interface ServerLivenessMessage {
  kind: "server.ping" | "server.pong"
  id?: string
}

/** An acknowledgement, correlated to the `id` of the frame being acknowledged. */
export interface ServerAckMessage {
  kind: "server.ack"
  ackId: string
}

/** A hint that a group moved to `sequence`. Carries no payload by design. */
export interface ChangeHint {
  groupId: string
  aggregate: string
  /** Sequence the change was committed at; 1-based. */
  sequence: number
}

/** A server frame announcing a committed change. */
export type ServerHintMessage = ChangeHint & { kind: "change.hint" }

/** Frames a server sends. */
export type ServerMessage = ServerLivenessMessage | ServerAckMessage | ServerHintMessage

/** Any frame in either direction. */
export type WireMessage = ClientMessage | ServerMessage

const cursorSnapshotSchema = type({
  groupId: "string",
  sequence: "number",
})

/** Client half of the protocol. */
export const clientMessageSchema: Type<ClientMessage> = type({
  kind: "'client.ping' | 'client.pong'",
  "id?": "string",
}).or(
  type({
    kind: "'client.sync'",
    cursors: cursorSnapshotSchema.array(),
    fromStart: "boolean",
    "id?": "string",
  }),
)

/** Server half of the protocol. */
export const serverMessageSchema: Type<ServerMessage> = type({
  kind: "'server.ping' | 'server.pong'",
  "id?": "string",
}).or(
  type({
    kind: "'server.ack'",
    ackId: "string",
  }),
).or(
  type({
    kind: "'change.hint'",
    groupId: "string",
    aggregate: "string",
    sequence: "number",
  }),
)

const wireMessageSchema = serverMessageSchema.or(clientMessageSchema)

/** Outcome of decoding one text frame. A decode never throws. */
export type DecodeResult =
  | { ok: true; message: WireMessage }
  | { ok: false; reason: string }

/** Encodes and decodes frames. Injectable so a host can swap the wire format. */
export interface MessageCodec {
  /** Serialize a frame. Throws on a frame that does not match the protocol. */
  encode(message: WireMessage): string
  /** Parse a text frame. Returns a result; never throws. */
  decode(raw: string): DecodeResult
}

/** Build the hint a committed change is announced with. */
export function createHint(hint: ChangeHint): ServerMessage {
  return {
    kind: "change.hint",
    groupId: hint.groupId,
    aggregate: hint.aggregate,
    sequence: hint.sequence,
  }
}

/** Whether a frame is a change hint, narrowing it for a caller that has already decoded. */
export function isChangeHint(message: WireMessage): message is ServerHintMessage {
  return message.kind === "change.hint"
}

/**
 * JSON codec over the arktype schemas above.
 *
 * `decode` treats an unparsable frame, and a frame that is not one of the known kinds, as a
 * rejection with a reason string — the caller drops it and counts it. A transport that guesses at a
 * malformed frame is a transport that can act on it.
 */
export function createJsonCodec(): MessageCodec {
  return {
    encode(message) {
      const parsed = wireMessageSchema(message)
      if (parsed instanceof type.errors) {
        throw new Error(`Refusing to send a frame that is not protocol: ${parsed.summary}`)
      }
      return JSON.stringify(parsed)
    },
    decode(raw) {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch (error) {
        return { ok: false, reason: `frame is not JSON: ${describeError(error)}` }
      }
      const parsed = wireMessageSchema(json)
      if (parsed instanceof type.errors) {
        return { ok: false, reason: parsed.summary }
      }
      return { ok: true, message: parsed }
    },
  }
}

/** Snapshot of the cursors a handshake advertises, in wire form. */
export function toWireCursors(cursors: readonly CursorSnapshot[]): CursorSnapshot[] {
  return cursors.map((cursor) => ({ groupId: cursor.groupId, sequence: cursor.sequence }))
}

/** One-line rendering of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
