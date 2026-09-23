import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { createEnvReader, MissingEnvError, readEnvVar, systemEnv } from "./env.ts"

describe("systemEnv", () => {
  it("treats a blank real environment variable as unset, not as a set-but-blank value", () => {
    // A uniquely named variable: the unit tier's --allow-env is unscoped here, but this must not
    // read or clobber anything a real deployment already set.
    const name = "TS_LIBS_SERVER_CONFIG_ENV_TEST_BLANK_VARIABLE"
    Deno.env.set(name, "")
    try {
      expect(systemEnv.get(name)).toBeUndefined()
    } finally {
      Deno.env.delete(name)
    }
  })

  it("returns the value of a real, non-blank environment variable", () => {
    const name = "TS_LIBS_SERVER_CONFIG_ENV_TEST_SET_VARIABLE"
    Deno.env.set(name, "a-real-value")
    try {
      expect(systemEnv.get(name)).toBe("a-real-value")
    } finally {
      Deno.env.delete(name)
    }
  })
})

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
