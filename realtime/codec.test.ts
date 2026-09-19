/**
 * Wire protocol: what a frame may say, and what it may never say.
 *
 * The cases below are also the wire-level half of the ADR 002 invariant — there is no frame kind in
 * this protocol that mutates anything, so a socket cannot become a second, weaker application path.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { createHint, createJsonCodec, isChangeHint } from "./codec.ts"

const codec = createJsonCodec()

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
