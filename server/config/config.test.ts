import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"
import { createEnvReader } from "./env.ts"
import { ConfigError, loadConfig, stringBoolean } from "./config.ts"

const exampleSchema = type({
  ENV: "'dev' | 'prod'",
  AUTH_PEPPER: "string > 0",
  PORT: "string.integer.parse",
  "FEATURE_FLAG?": stringBoolean,
})

describe("loadConfig", () => {
  it("returns a fully parsed, typed config when every variable is valid", () => {
    const env = createEnvReader({
      ENV: "prod",
      AUTH_PEPPER: "correct-horse-battery-staple",
      PORT: "8080",
      FEATURE_FLAG: "true",
    })

    const config = loadConfig(exampleSchema, env)

    expect(config).toEqual({
      ENV: "prod",
      AUTH_PEPPER: "correct-horse-battery-staple",
      PORT: 8080,
      FEATURE_FLAG: true,
    })
  })

  it("accepts an absent optional variable and simply omits it", () => {
    const env = createEnvReader({
      ENV: "dev",
      AUTH_PEPPER: "pepper",
      PORT: "3000",
    })

    const config = loadConfig(exampleSchema, env)

    expect(config).toEqual({ ENV: "dev", AUTH_PEPPER: "pepper", PORT: 3000 })
  })

  it("throws ConfigError naming a required variable that is missing", () => {
    const env = createEnvReader({ ENV: "dev", PORT: "3000" })

    expect(() => loadConfig(exampleSchema, env)).toThrow(ConfigError)
    try {
      loadConfig(exampleSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).variables).toEqual(["AUTH_PEPPER"])
    }
  })

  it("throws ConfigError naming every variable that fails, and only those", () => {
    const env = createEnvReader({
      ENV: "staging", // not "dev" | "prod"
      AUTH_PEPPER: "pepper",
      PORT: "not-a-number",
    })

    try {
      loadConfig(exampleSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      expect((error as ConfigError).variables).toEqual(["ENV", "PORT"])
    }
  })

  it("never echoes the invalid value in the error", () => {
    const env = createEnvReader({
      ENV: "dev",
      AUTH_PEPPER: "a-very-secret-pepper-value",
      PORT: "not-a-number",
    })

    try {
      loadConfig(exampleSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain("not-a-number")
      expect(message).not.toContain("a-very-secret-pepper-value")
      expect(message).toContain("PORT")
    }
  })

  it("treats a blank variable exactly as a missing one", () => {
    const env = createEnvReader({ ENV: "dev", AUTH_PEPPER: "", PORT: "3000" })

    try {
      loadConfig(exampleSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      expect((error as ConfigError).variables).toEqual(["AUTH_PEPPER"])
    }
  })

  it("rejects a boolean spelling other than the literal true or false", () => {
    const env = createEnvReader({
      ENV: "dev",
      AUTH_PEPPER: "pepper",
      PORT: "3000",
      FEATURE_FLAG: "yes",
    })

    try {
      loadConfig(exampleSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      expect((error as ConfigError).variables).toEqual(["FEATURE_FLAG"])
    }
  })

  it("rejects a schema that is not a flat object schema", () => {
    const stringSchema = type("string")

    expect(() => loadConfig(stringSchema, createEnvReader({}))).toThrow(TypeError)
  })
})

describe("stringBoolean", () => {
  it("parses the literal string true to the boolean true", () => {
    expect(stringBoolean("true")).toBe(true)
  })

  it("parses the literal string false to the boolean false", () => {
    expect(stringBoolean("false")).toBe(false)
  })
})
