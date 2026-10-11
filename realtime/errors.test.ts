/** The closed error-code set a client switches on. */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import {
  describeError,
  isRealtimeErrorCode,
  REALTIME_ERROR_CODES,
  RealtimeRequestError,
} from "./errors.ts"

describe("realtime error codes", () => {
  it("names the eight codes a client can switch on", () => {
    expect([...REALTIME_ERROR_CODES]).toEqual([
      "bad_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "rate_limited",
      "internal",
      "timeout",
    ])
  })

  it("recognises a code and refuses anything else, including prototype names", () => {
    expect(isRealtimeErrorCode("conflict")).toBe(true)
    expect(isRealtimeErrorCode("teapot")).toBe(false)
    expect(isRealtimeErrorCode("toString")).toBe(false)
    expect(isRealtimeErrorCode(7)).toBe(false)
  })

  it("carries its code and details, with undefined details when none are given", () => {
    const withDetails = new RealtimeRequestError("bad_request", "invalid", { field: "title" })
    const without = new RealtimeRequestError("not_found", "gone")

    expect(withDetails).toBeInstanceOf(Error)
    expect(withDetails.code).toBe("bad_request")
    expect(withDetails.details).toEqual({ field: "title" })
    expect(without.details).toBeUndefined()
  })
})

describe("describeError", () => {
  it("gives the server's message for an error the server answered with", () => {
    const error = new RealtimeRequestError("conflict", "Title is taken")

    expect(describeError(error, "Something went wrong")).toBe("Title is taken")
  })

  it("gives the fallback for an error that is not a server answer", () => {
    expect(describeError(new Error("socket hang up"), "Something went wrong")).toBe(
      "Something went wrong",
    )
    expect(describeError("boom", "Something went wrong")).toBe("Something went wrong")
    expect(describeError(undefined, "Something went wrong")).toBe("Something went wrong")
  })
})
