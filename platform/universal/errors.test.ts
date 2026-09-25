import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"
import { ErrType as ValidationErrType, validate } from "@spy4x/validation"

import {
  ConnectionError,
  connectionError,
  ERR_MESSAGE,
  ErrType,
  idleOperationState,
  isSilentError,
  OperationResult,
  OperationState,
  responseError,
  ServerError,
  ValidationError,
} from "./errors.ts"

describe("ErrType", () => {
  it("is a numeric enum whose members start at one", () => {
    expect(ErrType.Validation).toBe(1)
    expect(ErrType.Connection).toBe(2)
    expect(ErrType.Server).toBe(3)
    expect(ErrType.Other).toBe(4)
    expect(ErrType.Payload).toBe(5)
  })

  it("exposes exactly the five categories as forward mappings", () => {
    // A TypeScript enum is reverse-mapped too, so `Object.values` is twice the member count.
    const forward = new Set(Object.values(ErrType).filter((v) => typeof v === "number"))
    expect(forward).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(Object.values(ErrType).length).toBe(10)
  })

  it("is the same enum @spy4x/validation tags its error with", () => {
    expect(ErrType).toBe(ValidationErrType)
  })
})

describe("ERR_MESSAGE", () => {
  it("carries one canonical message per category", () => {
    expect(ERR_MESSAGE.validation).toContain("doesn't seem valid")
    expect(ERR_MESSAGE.connection).toContain("internet connection")
  })
})

describe("error shapes", () => {
  it("discriminates a connection error from a server error on type", () => {
    const connection: ConnectionError = {
      type: ErrType.Connection,
      message: ERR_MESSAGE.connection,
    }
    const server: ServerError = {
      type: ErrType.Server,
      status: 503,
      message: "Service Unavailable",
    }

    const describeError = (error: ConnectionError | ServerError): string =>
      error.type === ErrType.Server ? `HTTP ${error.status}` : "offline"

    expect(describeError(connection)).toBe("offline")
    expect(describeError(server)).toBe("HTTP 503")
  })

  it("accepts a ValidationError from @spy4x/validation without adaptation", () => {
    // The envelope is owned by @spy4x/validation. If this package ever declares its own
    // validation error again, assigning the one `validate` returns stops compiling.
    const { error: rejected } = validate(type({ name: "string" }), { name: 5 })
    if (rejected === null) throw new Error("expected a validation error")
    const error: ValidationError = rejected

    expect(error.type).toBe(ErrType.Validation)
    expect(error.message).toBe(ERR_MESSAGE.validation)
    expect(error.errors.name?.[0]?.message).toBe("must be a string (was a number)")
  })
})

describe("idleOperationState", () => {
  it("starts idle with no result and no error", () => {
    expect(idleOperationState<number>()).toEqual({ inProgress: false, result: null, error: null })
  })

  it("is the shape an OperationState consumer can narrow", () => {
    const state: OperationState<number, ConnectionError> = idleOperationState()
    expect(state.inProgress).toBe(false)
    expect(state.result).toBeNull()
  })
})

describe("OperationResult", () => {
  it("narrows to the value when there is no error", () => {
    const result: OperationResult<number, ServerError> = { error: null, result: 7 }
    if (result.error === null) expect(result.result).toBe(7)
  })

  it("narrows to the error when there is no value", () => {
    const result: OperationResult<number, ServerError> = {
      error: { type: ErrType.Server, status: 500, message: "boom" },
      result: null,
    }
    if (result.error !== null) expect(result.error.status).toBe(500)
  })
})

describe("connectionError", () => {
  it("wraps a message in a connection error", () => {
    expect(connectionError("offline")).toEqual({ type: ErrType.Connection, message: "offline" })
  })
})

describe("responseError", () => {
  it("treats status 0 as a connection error with the canonical message", async () => {
    const error = await responseError(Response.error())
    expect(error).toEqual({ type: ErrType.Connection, message: ERR_MESSAGE.connection })
  })

  it("carries the status and the server's message from an error key", async () => {
    // A status text is present too: the server's own message must win over it.
    const error = await responseError(
      Response.json({ error: "Email taken" }, { status: 409, statusText: "Conflict" }),
    )
    expect(error).toEqual({ type: ErrType.Server, status: 409, message: "Email taken" })
  })

  it("prefers the error key over the message key when the body has both", async () => {
    const error = await responseError(Response.json({ message: "m", error: "e" }, { status: 400 }))
    expect(error.message).toBe("e")
  })

  it("reads the server's message from a message key", async () => {
    const error = await responseError(Response.json({ message: "nope" }, { status: 422 }))
    expect(error.message).toBe("nope")
  })

  it("reads the server's message from a detail key", async () => {
    const error = await responseError(Response.json({ detail: "gone" }, { status: 410 }))
    expect(error.message).toBe("gone")
  })

  it("reads the server's message from a bare JSON string", async () => {
    const error = await responseError(Response.json("quota exceeded", { status: 429 }))
    expect(error.message).toBe("quota exceeded")
  })

  it("falls back to the status text when the body is not JSON", async () => {
    const error = await responseError(
      new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }),
    )
    expect(error).toEqual({ type: ErrType.Server, status: 502, message: "Bad Gateway" })
  })

  it("falls back to the status text when the JSON body has no message", async () => {
    const error = await responseError(
      Response.json({ error: "" }, { status: 400, statusText: "Bad Request" }),
    )
    expect(error.message).toBe("Bad Request")
  })

  it("falls back to the status code when there is no body and no status text", async () => {
    const error = await responseError(new Response(null, { status: 503 }))
    expect(error).toEqual({ type: ErrType.Server, status: 503, message: "HTTP 503" })
  })
})

describe("isSilentError", () => {
  it("is true for a connection error", () => {
    expect(isSilentError(connectionError("offline"))).toBe(true)
  })

  it("is true for a server error with status 500", () => {
    expect(isSilentError({ type: ErrType.Server, status: 500, message: "boom" })).toBe(true)
  })

  it("is false for a server error with any other status", () => {
    expect(isSilentError({ type: ErrType.Server, status: 409, message: "taken" })).toBe(false)
    expect(isSilentError({ type: ErrType.Server, status: 503, message: "busy" })).toBe(false)
  })

  it("is false for a payload error and a validation error", () => {
    expect(isSilentError({ type: ErrType.Payload, message: "malformed" })).toBe(false)
    const { error } = validate(type({ name: "string" }), {})
    if (error === null) throw new Error("expected a validation error")
    expect(isSilentError(error)).toBe(false)
  })
})
