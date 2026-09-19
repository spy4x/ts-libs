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
 *
 * **Undeclared properties are rejected, not ignored — and that check is this package's, not the
 * validator's.** {@link protocolViolation} checks each parsed frame against an explicit declared-key
 * allow-list using *own-property* membership.
 *
 * The validator cannot do this on its own. arktype's default is `onUndeclaredKey: "ignore"`, which
 * accepts extra properties and *preserves* them on the parsed value, so `{"kind":"change.hint", …,
 * "payload":{…}}` decoded, survived {@link MessageCodec.encode} and reached a host's `onFrame`. Its
 * strict option does not close it either: `@ark/schema@0.56.2` decides declaredness with
 * `k in this.propsByKey` (`out/structure/structure.js`), and `in` walks the prototype chain, so all
 * twelve `Object.prototype` member names — `__proto__`, `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `__defineGetter__`,
 * `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` — read as *declared*, while
 * `@ark/util@0.56.2/out/flatMorph.js` starts its morph target from `{}` so they survive onto the
 * parsed value, own and enumerable. Measured: 12 of 12 passed both `decode` and `encode` and reached
 * `onFrame`, with or without `"+": "reject"` on the schemas.
 *
 * Hence one mechanism rather than two: the schemas carry no undeclared-key marker (it was tried, and
 * with the allow-list in place removing it leaves the whole suite green, which makes it a line no
 * test can distinguish), and every frame is checked by the allow-list instead.
 *
 * Own-property membership is the right test because it is the only thing that can travel: JSON
 * serialises own enumerable properties only, and `JSON.parse` never produces an inherited one. That
 * test is `Object.keys`, so it covers every own *string* key and does not examine an own *symbol* key:
 * a symbol is dropped by `JSON.stringify` and so never reaches the wire, but the guard does not claim
 * to close that gap. A frame whose prototype is neither `Object.prototype` nor `null` is refused too —
 * a class instance, or `Object.create({ evil: 1 })` — so a decoded frame can never carry data the
 * receiver would read through the prototype chain.

 * `validation/` leaves strictness to the host ("Strictness (`onUndeclaredKey`) is the host
 * application's decision, not a library's side effect" — `validation/validate.ts:7-8`). A wire
 * protocol is the opposite case: the library owns the wire, an unrecognised property is a protocol
 * violation, and a host that never sees it cannot act on it.
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

/**
 * A hint that a group moved to `sequence`. Carries no entity payload by design — the payload is what
 * the REST pull returns.
 *
 * `aggregate` is optional so the minimal frame the design doc specifies
 * (`sync.hint { groupId, sequence }`, `docs/design/realtime-websockets.md:90`) decodes here too. It
 * is an addition, not a requirement: a server that routes by aggregate server-side does not have to
 * name it on the wire.
 */
export interface ChangeHint {
  groupId: string
  aggregate?: string
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
    "aggregate?": "string",
    sequence: "number",
  }),
)

const wireMessageSchema = serverMessageSchema.or(clientMessageSchema)

/**
 * The keys each frame kind may carry, and nothing else.
 *
 * Data rather than something derived from arktype, because deriving it from the schema would inherit
 * the very prototype-chain defect this table exists to work around.
 */
const DECLARED_FRAME_KEYS: Record<WireMessage["kind"], readonly string[]> = {
  "client.ping": ["kind", "id"],
  "client.pong": ["kind", "id"],
  "client.sync": ["kind", "cursors", "fromStart", "id"],
  "server.ping": ["kind", "id"],
  "server.pong": ["kind", "id"],
  "server.ack": ["kind", "ackId"],
  "change.hint": ["kind", "groupId", "aggregate", "sequence"],
}

/** Keys a handshake cursor snapshot may carry. */
const DECLARED_CURSOR_KEYS: readonly string[] = ["groupId", "sequence"]

/**
 * First own string key of `value` that `declared` does not list, or `null`.
 *
 * This is the protocol rule itself, exported so it can be pinned on its own: membership is decided by
 * the *own* keys of the value against an explicit list. `Object.keys` walks the own string keys, so an
 * own *symbol* key is not examined here — `JSON.stringify` drops symbol-keyed properties, so no frame
 * carrying one reaches the wire, and the guard is described as covering string keys rather than
 * claimed to cover every own property.
 *
 * It must never be rewritten as a prototype-name blacklist — that shape would accept every future
 * declared key whose name happens to exist on `Object.prototype`, and would reject a declared one. The
 * test "accepts a declared key whose name also exists on Object.prototype" fails against a blacklist,
 * and replaces nothing: no frame in this protocol declares such a key today, so only a predicate-level
 * assertion can hold the property.
 */
export function findUndeclaredKey(value: object, declared: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!declared.includes(key)) return key
  }
  return null
}

/**
 * Whether a parsed node is a plain object, so nothing can be read through its prototype chain.
 *
 * `Object.prototype` and `null` are both accepted: a null-prototype object built by
 * `Object.create(null)` has no chain to read through, so it is a plain object here. A class instance,
 * an array, and `Object.create({ evil: 1 })` are refused, because each carries a prototype a receiver
 * could read data through.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Why a frame is not protocol, or `null` when it is.
 *
 * Runs after the schemas have checked types, so it only has to answer one question: is every own
 * *string* key of this frame, and of every cursor it carries, one the protocol declares? An own
 * *symbol* key is not examined (`Object.keys`), and cannot travel: `JSON.stringify` drops it.
 */
function protocolViolation(message: WireMessage): string | null {
  if (!isPlainObject(message)) return `frame of kind "${message.kind}" is not a plain object`

  const undeclared = findUndeclaredKey(message, DECLARED_FRAME_KEYS[message.kind])
  if (undeclared !== null) {
    return `undeclared property "${undeclared}" on ${message.kind}`
  }

  if (message.kind === "client.sync") {
    for (const cursor of message.cursors) {
      if (!isPlainObject(cursor)) return `cursors[] of ${message.kind} is not a plain object`
      const cursorKey = findUndeclaredKey(cursor, DECLARED_CURSOR_KEYS)
      if (cursorKey !== null) {
        return `undeclared property "${cursorKey}" on ${message.kind} cursors[]`
      }
    }
  }

  return null
}

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
    ...(hint.aggregate !== undefined ? { aggregate: hint.aggregate } : {}),
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
      const violation = protocolViolation(parsed)
      if (violation !== null) {
        throw new Error(`Refusing to send a frame that is not protocol: ${violation}`)
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
      const violation = protocolViolation(parsed)
      if (violation !== null) {
        return { ok: false, reason: violation }
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
