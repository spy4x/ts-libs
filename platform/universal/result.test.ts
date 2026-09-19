import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  CommandEnvelope,
  commandErr,
  commandFromError,
  commandOk,
  err,
  ok,
  Result,
  unwrap,
  unwrapOr,
} from "./result.ts"

describe("ok / err", () => {
  it("builds a success carrying the value", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
  })

  it("builds a failure carrying the error", () => {
    expect(err("nope")).toEqual({ ok: false, error: "nope" })
  })

  it("discriminates on ok", () => {
    const result: Result<number, string> = ok(2)
    expect(result.ok ? result.value : result.error).toBe(2)
  })
})

describe("unwrap", () => {
  it("returns the value on success", () => {
    expect(unwrap(ok("value"))).toBe("value")
  })

  it("throws the string error on failure", () => {
    expect(() => unwrap(err("exploded"))).toThrow("exploded")
  })

  it("serialises a non-string error rather than throwing [object Object]", () => {
    expect(() => unwrap(err({ code: 42 }))).toThrow(`{"code":42}`)
  })
})

describe("unwrapOr", () => {
  it("returns the value on success and the fallback on failure", () => {
    expect(unwrapOr(ok(1), 99)).toBe(1)
    expect(unwrapOr(err("x"), 99)).toBe(99)
  })
})

describe("CommandEnvelope", () => {
  it("builds a success arm with no error", () => {
    expect(commandOk({ rows: 3 })).toEqual({ success: true, output: { rows: 3 }, error: null })
  })

  it("builds a failure arm with no output", () => {
    expect(commandErr("disk full")).toEqual({ success: false, output: null, error: "disk full" })
  })

  it("turns a thrown Error into its message, keeping the stack out", () => {
    const envelope = commandFromError(new Error("kaboom"))
    expect(envelope.error).toBe("kaboom")
    expect(envelope.success).toBe(false)
  })

  it("stringifies a thrown non-Error", () => {
    expect(commandFromError("plain string").error).toBe("plain string")
    expect(commandFromError(42).error).toBe("42")
  })

  it("survives a JSON round trip, which is why the error is a string", () => {
    const envelope: CommandEnvelope<number> = commandOk(5)
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
  })
})
