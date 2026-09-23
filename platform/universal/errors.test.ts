import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  ConnectionError,
  ERR_MESSAGE,
  ErrType,
  idleOperationState,
  OperationResult,
  OperationState,
  ServerError,
  ValidationError,
} from "./errors.ts"

describe("ErrType", () => {
  it("is a numeric enum whose members start at one", () => {
    expect(ErrType.Validation).toBe(1)
    expect(ErrType.Connection).toBe(2)
    expect(ErrType.Server).toBe(3)
    expect(ErrType.Other).toBe(4)
  })

  it("exposes exactly the four categories as forward mappings", () => {
    // A TypeScript enum is reverse-mapped too, so `Object.values` is twice the member count.
    const forward = new Set(Object.values(ErrType).filter((v) => typeof v === "number"))
    expect(forward).toEqual(new Set([1, 2, 3, 4]))
    expect(Object.values(ErrType).length).toBe(8)
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
    // The envelope is owned by @spy4x/validation: `{ description, details }`. If this package
    // ever grows its own `errors` map again, this assignment stops compiling.
    const error: ValidationError = {
      description: "name must be a string",
      details: { summary: "name must be a string" } as ValidationError["details"],
    }
    expect(error.description).toBe("name must be a string")
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
