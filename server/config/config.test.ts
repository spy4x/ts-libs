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

  it("rejects a schema that is not an object at all", () => {
    const stringSchema = type("string")

    expect(() => loadConfig(stringSchema, createEnvReader({}))).toThrow(TypeError)
  })

  it("rejects a union schema instead of reading nothing from it", () => {
    const unionSchema = type("string | number")

    expect(() => loadConfig(unionSchema, createEnvReader({}))).toThrow(TypeError)
  })

  it("rejects a piped (morphed) root schema instead of reading nothing from it", () => {
    const pipedSchema = type("string").pipe((value) => value.length)

    expect(() => loadConfig(pipedSchema, createEnvReader({}))).toThrow(TypeError)
  })

  it("rejects an index-signature-only schema instead of silently reading nothing", () => {
    const indexOnlySchema = type({ "[/^APP_/]": "string" })

    expect(() => loadConfig(indexOnlySchema, createEnvReader({ APP_NAME: "x" }))).toThrow(
      TypeError,
    )
  })

  it("reads its keys from a schema that carries a .describe()", () => {
    const describedSchema = type({ AUTH_PEPPER: "string > 0" }).describe("app config")

    const config = loadConfig(describedSchema, createEnvReader({ AUTH_PEPPER: "pepper" }))

    expect(config).toEqual({ AUTH_PEPPER: "pepper" })
  })

  it("reads its keys from a schema that carries a .configure()", () => {
    const configuredSchema = type({ AUTH_PEPPER: "string > 0" }).configure({
      description: "app config",
    })

    const config = loadConfig(configuredSchema, createEnvReader({ AUTH_PEPPER: "pepper" }))

    expect(config).toEqual({ AUTH_PEPPER: "pepper" })
  })

  it("fills a defaulted key from the schema when its variable is absent", () => {
    const defaultedSchema = type({
      AUTH_PEPPER: "string > 0",
      PORT: "string.integer.parse = '3000'",
    })

    const config = loadConfig(defaultedSchema, createEnvReader({ AUTH_PEPPER: "pepper" }))

    expect(config).toEqual({ AUTH_PEPPER: "pepper", PORT: 3000 })
  })

  it("names a value-free label, not an empty string, when a root-level check fails", () => {
    // financy's shape: TELEGRAM_WEBHOOK_URL is required outside dev, checked across two fields.
    const telegramSchema = type({
      ENV: "'dev' | 'prod'",
      "TELEGRAM_WEBHOOK_URL?": "string",
    }).narrow((data, ctx) => {
      if (data.ENV !== "dev" && !data.TELEGRAM_WEBHOOK_URL) {
        return ctx.reject({ expected: "TELEGRAM_WEBHOOK_URL is required outside dev" })
      }
      return true
    })
    const env = createEnvReader({ ENV: "prod" })

    try {
      loadConfig(telegramSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      const configError = error as ConfigError
      expect(configError.variables).toEqual(["TELEGRAM_WEBHOOK_URL is required outside dev"])
      expect(configError.message.split(":")[1]?.trim()).not.toBe("")
      expect(configError.message).not.toContain("prod")
    }
  })

  it("names only the declared field, never a key from inside a parsed value", () => {
    // A token-to-role map: a failure on one entry must not report the token as a path segment.
    const tokensSchema = type({
      API_TOKENS: type("string.json.parse").to({ "[string]": "'admin' | 'reader'" }),
    })
    const env = createEnvReader({
      API_TOKENS: JSON.stringify({ "LEAKED-KEY-7": "owner" }), // "owner" is not admin | reader
    })

    try {
      loadConfig(tokensSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      const configError = error as ConfigError
      expect(configError.variables).toEqual(["API_TOKENS"])
      expect(configError.message).not.toContain("LEAKED-KEY-7")
    }
  })

  it("falls back to the cross-field label instead of crashing on ctx.reject({ message })", () => {
    // arktype's own documented style for a narrow rejection — no expected field at all.
    const schema = type({
      ENV: "'dev' | 'prod'",
      "URL?": "string",
    }).narrow((data, ctx) => {
      if (data.ENV !== "dev" && !data.URL) {
        return ctx.reject({ message: "URL is required outside dev" })
      }
      return true
    })
    const env = createEnvReader({ ENV: "prod" })

    let thrown: unknown
    try {
      loadConfig(schema, env)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).variables).toEqual(["(cross-field check)"])
  })

  it("never names a path segment the schema did not declare, even one set by hand", () => {
    // A cross-field rule may point its rejection at a path; one built from a value must not print.
    const schema = type({ A: "string", B: "string" }).narrow((data, ctx) =>
      ctx.reject({ path: [data.A], expected: "A and B must differ" })
    )
    const env = createEnvReader({ A: "LEAKED-PATH-8", B: "x" })

    let thrown: unknown
    try {
      loadConfig(schema, env)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).variables).toEqual(["A and B must differ"])
    expect((thrown as ConfigError).message).not.toContain("LEAKED-PATH-8")
  })

  it("never leaks the value when a schema's morph throws instead of rejecting", () => {
    const throwingSchema = type({
      SECRET: type("string").pipe((value) => {
        if (value.length < 40) throw new Error(`bad ${value}`)
        return value
      }),
    })
    const env = createEnvReader({ SECRET: "LEAKED-SECRET-3" })

    try {
      loadConfig(throwingSchema, env)
      throw new Error("expected loadConfig to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as Error).message).not.toContain("LEAKED-SECRET-3")
      expect((error as ConfigError).cause).toBeUndefined()
    }
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
