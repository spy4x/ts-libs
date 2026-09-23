import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { createEnvReader, MissingEnvError, readEnvVar } from "./env.ts"

describe("createEnvReader", () => {
  it("returns the value of a set variable", () => {
    const env = createEnvReader({ NAME: "value" })

    expect(env.get("NAME")).toBe("value")
  })

  it("returns undefined for a variable that was never set", () => {
    const env = createEnvReader({})

    expect(env.get("MISSING")).toBeUndefined()
  })

  it("treats an empty string the same as an unset variable", () => {
    const env = createEnvReader({ BLANK: "" })

    expect(env.get("BLANK")).toBeUndefined()
  })
})

describe("readEnvVar", () => {
  it("returns the value when the variable is set", () => {
    const env = createEnvReader({ NAME: "value" })

    expect(readEnvVar(env, "NAME")).toBe("value")
  })

  it("throws MissingEnvError, naming the variable, when it is unset", () => {
    const env = createEnvReader({})

    expect(() => readEnvVar(env, "SECRET_TOKEN")).toThrow(MissingEnvError)
    try {
      readEnvVar(env, "SECRET_TOKEN")
      throw new Error("expected readEnvVar to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError)
      expect((error as Error).message).toContain("SECRET_TOKEN")
    }
  })

  it("throws MissingEnvError for a blank variable exactly as for an unset one", () => {
    const env = createEnvReader({ SECRET_TOKEN: "" })

    expect(() => readEnvVar(env, "SECRET_TOKEN")).toThrow(MissingEnvError)
  })

  it("returns an empty string for an unset optional variable instead of throwing", () => {
    const env = createEnvReader({})

    expect(readEnvVar(env, "OPTIONAL", { optional: true })).toBe("")
  })
})
