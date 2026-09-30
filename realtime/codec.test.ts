/**
 * Wire protocol: what a frame may say, and what it may never say.
 *
 * The request frames carry an envelope only: the codec validates ids, names, keys and error codes,
 * never what a payload means.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { type } from "arktype"

import {
  createError,
  createHint,
  createJsonCodec,
  createResult,
  findUndeclaredKey,
  isChangeHint,
  type WireMessage,
} from "./codec.ts"

const codec = createJsonCodec()

/**
 * Every member name of `Object.prototype`.
 *
 * arktype cannot police these: it decides declaredness with `k in propsByKey`, and `in` walks the
 * prototype chain. They are therefore the regression set for this package's own allow-list check.
 */
const PROTOTYPE_MEMBER_NAMES = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]

/** A hint frame carrying `name` as an undeclared own property, built through JSON on purpose. */
function hintWithProperty(name: string): string {
  return `{"kind":"change.hint","groupId":"group-1","sequence":4,${JSON.stringify(name)}:1}`
}

/** Declared keys of an arktype object schema, read from its public JSON form. */
function declaredKeysOf(schema: { json: unknown }): string[] {
  const json = schema.json as {
    required?: { key: string }[]
    optional?: { key: string }[]
  }
  return [
    ...(json.required ?? []).map((entry) => entry.key),
    ...(json.optional ?? []).map((entry) => entry.key),
  ].sort()
}

describe("createJsonCodec", () => {
  it("round-trips a change hint with its sequence", () => {
    const hint = createHint({
      groupId: "group-1",
      aggregate: "invoice",
      sequence: 42,
    })

    const result = codec.decode(codec.encode(hint))

    expect(result).toEqual({ ok: true, message: hint })
  })

  it("round-trips a sync handshake carrying real cursors", () => {
    const frame = {
      kind: "client.sync" as const,
      cursors: [{ groupId: "group-1", sequence: 42 }],
      fromStart: false,
      id: "frame-1",
    }

    const result = codec.decode(codec.encode(frame))

    expect(result).toEqual({ ok: true, message: frame })
  })

  it("reports a frame that is not JSON instead of throwing", () => {
    const result = codec.decode("<html>gateway timeout</html>")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a rejection")
    expect(result.reason).toContain("frame is not JSON")
  })

  it("rejects an unknown frame kind, so a mutation cannot be smuggled over the socket", () => {
    const result = codec.decode(
      JSON.stringify({ kind: "invoice.create", payload: { total: 100 } }),
    )

    expect(result.ok).toBe(false)
  })

  it("accepts a hint without an aggregate, the minimal shape the design doc specifies", () => {
    const result = codec.decode(
      JSON.stringify({ kind: "change.hint", groupId: "group-1", sequence: 4 }),
    )

    expect(result).toEqual({
      ok: true,
      message: { kind: "change.hint", groupId: "group-1", sequence: 4 },
    })
  })

  it("round-trips a hint that names the aggregate", () => {
    const hint = createHint({ groupId: "group-1", aggregate: "invoice", sequence: 4 })

    expect(hint).toEqual({
      kind: "change.hint",
      groupId: "group-1",
      aggregate: "invoice",
      sequence: 4,
    })
  })

  it("omits the aggregate key entirely when the hint does not name one", () => {
    const hint = createHint({ groupId: "group-1", sequence: 4 })

    expect(Object.keys(hint).sort()).toEqual(["groupId", "kind", "sequence"])
    expect(codec.decode(codec.encode(hint))).toEqual({ ok: true, message: hint })
  })

  it("rejects an undeclared property on a hint frame", () => {
    const result = codec.decode(
      JSON.stringify({
        kind: "change.hint",
        groupId: "group-1",
        sequence: 4,
        payload: { total: 100 },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a rejection")
    expect(result.reason).toContain("payload")
  })

  it("rejects an undeclared property nested inside a handshake cursor", () => {
    const result = codec.decode(
      JSON.stringify({
        kind: "client.sync",
        cursors: [{ groupId: "group-1", sequence: 4, payload: { total: 100 } }],
        fromStart: false,
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a rejection")
    expect(result.reason).toContain("payload")
  })

  it("rejects an undeclared property on a liveness frame in either direction", () => {
    expect(codec.decode(JSON.stringify({ kind: "client.ping", payload: {} })).ok).toBe(false)
    expect(codec.decode(JSON.stringify({ kind: "server.ack", ackId: "frame-1", payload: {} })).ok)
      .toBe(false)
  })

  it("still accepts a well-formed frame, so the guard is not rejecting everything", () => {
    expect(codec.decode(JSON.stringify({ kind: "change.hint", groupId: "group-1", sequence: 4 })))
      .toEqual({
        ok: true,
        message: { kind: "change.hint", groupId: "group-1", sequence: 4 },
      })
    expect(
      codec.decode(
        JSON.stringify({
          kind: "client.sync",
          cursors: [{ groupId: "group-1", sequence: 4 }],
          fromStart: false,
          id: "frame-1",
        }),
      ).ok,
    ).toBe(true)
  })

  it("refuses to encode a frame that carries an undeclared property", () => {
    const withPayload = {
      kind: "change.hint",
      groupId: "group-1",
      sequence: 4,
      payload: { total: 100 },
    } as unknown as Parameters<typeof codec.encode>[0]

    expect(() => codec.encode(withPayload)).toThrow("Refusing to send a frame that is not protocol")
  })

  it("rejects every Object.prototype member name as an undeclared property on decode", () => {
    const accepted = PROTOTYPE_MEMBER_NAMES.filter((name) =>
      codec.decode(hintWithProperty(name)).ok
    )

    expect(accepted).toEqual([])
  })

  it("rejects every Object.prototype member name as an undeclared property on encode", () => {
    const accepted = PROTOTYPE_MEMBER_NAMES.filter((name) => {
      try {
        codec.encode(JSON.parse(hintWithProperty(name)) as WireMessage)
        return true
      } catch {
        return false
      }
    })

    expect(accepted).toEqual([])
  })

  it("rejects a prototype member name on every frame kind", () => {
    const frames: WireMessage[] = [
      { kind: "client.ping" },
      { kind: "client.sync", cursors: [{ groupId: "group-1", sequence: 4 }], fromStart: false },
      { kind: "server.ack", ackId: "frame-1" },
      { kind: "change.hint", groupId: "group-1", sequence: 4 },
    ]

    const accepted = frames.filter((frame) => {
      const withExtra = JSON.parse(
        `{${
          Object.entries(frame).map(([key, value]) =>
            `${JSON.stringify(key)}:${JSON.stringify(value)}`
          )
            .join(",")
        },"constructor":1}`,
      )
      return codec.decode(JSON.stringify(withExtra)).ok
    })

    expect(accepted).toEqual([])
  })

  it("rejects a prototype member name nested inside a handshake cursor", () => {
    const accepted = PROTOTYPE_MEMBER_NAMES.filter((name) => {
      const raw = `{"kind":"client.sync","cursors":[{"groupId":"group-1","sequence":4,` +
        `${JSON.stringify(name)}:1}],"fromStart":false}`
      return codec.decode(raw).ok
    })

    expect(accepted).toEqual([])
  })

  it("accepts a declared key whose name also exists on Object.prototype", () => {
    // The declared set is what decides, not the name: `toString` and `__proto__` are both members of
    // Object.prototype and both accepted here precisely because they are declared. A guard rewritten
    // as a prototype-name blacklist returns a non-null key for these and this test goes red, which is
    // the failure mode that would reopen the hole in a different shape.
    expect(findUndeclaredKey({ toString: 1 }, ["toString"])).toBeNull()
    expect(findUndeclaredKey(JSON.parse(`{"__proto__":1}`), ["__proto__"])).toBeNull()

    // And the converse, so the predicate is not vacuously permissive.
    expect(findUndeclaredKey({ toString: 1 }, ["groupId"])).toBe("toString")
    expect(findUndeclaredKey({}, ["toString"])).toBeNull()
  })

  it("accepts a schema-declared key that also exists on Object.prototype", () => {
    // Guards the failure mode where the declared-set check is replaced — or shadowed — by a list of
    // banned prototype names. That shape rejects a legitimate key (`toString`) the moment a schema
    // declares one, and it cannot be seen by the rejection test above, because every name that test
    // uses is undeclared under both rules. Measured: adding `PROTOTYPE_NAMES.has(key)` beside the
    // allow-list reddens this test and no other in the suite.
    const synthetic = type({ kind: "'client.ping'", toString: "string" })
    const declared = declaredKeysOf(synthetic)
    expect(declared).toEqual(["kind", "toString"])

    const frame = JSON.parse(`{"kind":"client.ping","toString":"declared"}`)
    expect(synthetic(frame) instanceof type.errors).toBe(false)
    expect(findUndeclaredKey(frame as object, declared)).toBeNull()

    // The same schema, a prototype name that is *not* declared: still rejected.
    const undeclared = JSON.parse(`{"kind":"client.ping","valueOf":"x"}`)
    expect(findUndeclaredKey(undeclared as object, declared)).toBe("valueOf")
  })

  it("accepts a frame whose undeclared-looking names exist only on Object.prototype", () => {
    const raw = `{"kind":"change.hint","groupId":"group-1","sequence":4}`
    const parsed = JSON.parse(raw) as WireMessage

    // Every one of these is reachable through `in`, and none of them is an own property: a check
    // that used `in` (which is what the validator does) would be reading the prototype chain here.
    expect("toString" in parsed).toBe(true)
    expect(Object.hasOwn(parsed, "toString")).toBe(false)

    expect(codec.decode(raw)).toEqual({
      ok: true,
      message: { kind: "change.hint", groupId: "group-1", sequence: 4 },
    })
    expect(JSON.parse(codec.encode(parsed))).toEqual({
      kind: "change.hint",
      groupId: "group-1",
      sequence: 4,
    })
  })

  it("refuses a frame that is not a plain object, so nothing is read through a prototype chain", () => {
    const hostile = JSON.parse(`{"kind":"change.hint","groupId":"group-1","sequence":4}`)
    Object.setPrototypeOf(hostile, { payload: { total: 100 } })

    expect(() => codec.encode(hostile)).toThrow("is not a plain object")
  })

  it("still decodes and encodes a well-formed frame of every kind", () => {
    const frames: WireMessage[] = [
      { kind: "client.ping" },
      { kind: "client.pong", id: "frame-1" },
      { kind: "client.sync", cursors: [{ groupId: "group-1", sequence: 4 }], fromStart: false },
      { kind: "client.sync", cursors: [], fromStart: true, id: "frame-2" },
      { kind: "server.ping" },
      { kind: "server.pong", id: "server-1" },
      { kind: "server.ack", ackId: "frame-1" },
      { kind: "change.hint", groupId: "group-1", sequence: 4 },
      { kind: "change.hint", groupId: "group-1", aggregate: "invoice", sequence: 42 },
    ]

    for (const frame of frames) {
      expect(codec.decode(codec.encode(frame))).toEqual({ ok: true, message: frame })
    }
  })

  it("rejects a hint whose sequence is not a number", () => {
    const result = codec.decode(
      JSON.stringify({
        kind: "change.hint",
        groupId: "group-1",
        aggregate: "invoice",
        sequence: "42",
      }),
    )

    expect(result.ok).toBe(false)
  })

  it("rejects a hint carrying a negative sequence", () => {
    // #74: a negative sequence reaching CursorTracker unrejected was a break the suite missed;
    // rejecting it here, at the wire boundary, means the cursor arithmetic never has to see one.
    const result = codec.decode(
      JSON.stringify({ kind: "change.hint", groupId: "group-1", sequence: -1 }),
    )

    expect(result.ok).toBe(false)
  })

  it("rejects a hint carrying a fractional sequence", () => {
    const result = codec.decode(
      JSON.stringify({ kind: "change.hint", groupId: "group-1", sequence: 1.5 }),
    )

    expect(result.ok).toBe(false)
  })

  it("rejects a negative sequence inside a handshake cursor", () => {
    const result = codec.decode(
      JSON.stringify({
        kind: "client.sync",
        cursors: [{ groupId: "group-1", sequence: -1 }],
        fromStart: false,
      }),
    )

    expect(result.ok).toBe(false)
  })

  it("still accepts the sentinel sequence of zero", () => {
    // SEQUENCE_START (cursor.ts) is 0 and is a real, meaningful value — a stored cursor of zero is
    // how "this group is at zero" stays distinguishable from "never seen this group" — so the
    // non-negative check must not reject it.
    const result = codec.decode(
      JSON.stringify({ kind: "change.hint", groupId: "group-1", sequence: 0 }),
    )

    expect(result.ok).toBe(true)
  })

  it("rejects a handshake with no cursor list", () => {
    const result = codec.decode(
      JSON.stringify({ kind: "client.sync", fromStart: true }),
    )

    expect(result.ok).toBe(false)
  })

  it("rejects a handshake that omits the cold-start flag", () => {
    const result = codec.decode(
      JSON.stringify({ kind: "client.sync", cursors: [] }),
    )

    expect(result.ok).toBe(false)
  })

  it("refuses to encode a frame that is not protocol", () => {
    const notProtocol = {
      kind: "invoice.create",
      payload: {},
    } as unknown as Parameters<
      typeof codec.encode
    >[0]

    expect(() => codec.encode(notProtocol)).toThrow(
      "Refusing to send a frame that is not protocol",
    )
  })

  it("refuses to encode a hint without a sequence", () => {
    const hint = {
      kind: "change.hint",
      groupId: "group-1",
      aggregate: "invoice",
    } as unknown as Parameters<typeof codec.encode>[0]

    expect(() => codec.encode(hint)).toThrow()
  })

  it("narrows a change hint", () => {
    const hint = createHint({
      groupId: "group-1",
      aggregate: "invoice",
      sequence: 7,
    })

    expect(isChangeHint(hint)).toBe(true)
    expect(isChangeHint({ kind: "server.ping" })).toBe(false)
  })
})

describe("request and response frames", () => {
  const command: WireMessage = {
    kind: "client.command",
    id: "req-1",
    name: "group.rename",
    payload: { groupId: 7, title: "Trip" },
    idempotencyKey: "key-1",
  }

  it("round-trips a command with a payload and an idempotency key", () => {
    expect(codec.decode(codec.encode(command))).toEqual({ ok: true, message: command })
  })

  it("round-trips a query, a result and an error", () => {
    const frames: WireMessage[] = [
      { kind: "client.query", id: "req-2", name: "group.list" },
      { kind: "server.result", requestId: "req-2", payload: [{ id: 1 }] },
      { kind: "server.result", requestId: "req-3" },
      {
        kind: "server.error",
        requestId: "req-2",
        code: "forbidden",
        message: "not your group",
        details: { groupId: 1 },
      },
    ]
    for (const frame of frames) {
      expect(codec.decode(codec.encode(frame))).toEqual({ ok: true, message: frame })
    }
  })

  it("refuses a request frame without an id", () => {
    const raw = JSON.stringify({ kind: "client.command", name: "group.rename" })
    expect(codec.decode(raw).ok).toBe(false)
  })

  it("refuses an empty or oversized request name and id", () => {
    for (
      const bad of [{ name: "" }, { name: "n".repeat(129) }, { id: "" }, { id: "i".repeat(129) }]
    ) {
      const raw = JSON.stringify({ kind: "client.query", id: "r", name: "n", ...bad })
      expect(codec.decode(raw).ok).toBe(false)
    }
  })

  it("refuses an idempotency key on a query because a read has no effect to deduplicate", () => {
    const raw = JSON.stringify({ kind: "client.query", id: "r", name: "n", idempotencyKey: "k" })
    const result = codec.decode(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("idempotencyKey")
  })

  it("refuses an empty or oversized idempotency key", () => {
    for (const key of ["", "k".repeat(257)]) {
      const raw = JSON.stringify({ ...command, idempotencyKey: key })
      expect(codec.decode(raw).ok).toBe(false)
    }
  })

  it("refuses an undeclared property on a request or response frame", () => {
    for (const frame of [command, createResult("r"), createError("r", "internal", "x")]) {
      const raw = JSON.stringify({ ...frame, extra: 1 })
      const result = codec.decode(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("extra")
    }
  })

  it("refuses an error code outside the closed set", () => {
    const raw = JSON.stringify({
      kind: "server.error",
      requestId: "r",
      code: "teapot",
      message: "x",
    })
    expect(codec.decode(raw).ok).toBe(false)
  })

  it("refuses to encode an error without a message", () => {
    const bad = { kind: "server.error", requestId: "r", code: "internal" } as unknown as WireMessage
    expect(() => codec.encode(bad)).toThrow("Refusing to send a frame that is not protocol")
  })

  it("builds the answer frames with the fields given and no undefined placeholders", () => {
    expect(createResult("r", 5)).toEqual({ kind: "server.result", requestId: "r", payload: 5 })
    expect(createError("r", "conflict", "stale", [1])).toEqual({
      kind: "server.error",
      requestId: "r",
      code: "conflict",
      message: "stale",
      details: [1],
    })
    expect("payload" in createResult("r")).toBe(false)
    expect("details" in createError("r", "internal", "x")).toBe(false)
  })

  it("does not build a payload key into a result that has none", () => {
    expect("payload" in createResult("r")).toBe(false)
    expect("details" in createError("r", "internal", "x")).toBe(false)
  })
})
