import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { MissingBuildEnvError, readBuildEnvVar } from "./build-env.ts"

describe("readBuildEnvVar", () => {
  it("reads a value by its name", () => {
    expect(readBuildEnvVar({ ENV: `prod` }, `ENV`)).toBe(`prod`)
  })

  it("falls back to the prefixed name when a prefix is given", () => {
    expect(readBuildEnvVar({ VITE_ENV: `dev` }, `ENV`, { prefix: `VITE_` })).toBe(`dev`)
  })

  it("prefers the plain name over the prefixed one", () => {
    const env = { ENV: `plain`, VITE_ENV: `prefixed` }
    expect(readBuildEnvVar(env, `ENV`, { prefix: `VITE_` })).toBe(`plain`)
  })

  it("ignores the prefixed name when no prefix is given", () => {
    expect(readBuildEnvVar({ VITE_ENV: `dev` }, `ENV`, { optional: true })).toBe(``)
  })

  it("throws for a required value that is missing or empty", () => {
    for (const env of [{}, { ENV: `` }, { ENV: undefined }]) {
      expect(() => readBuildEnvVar(env, `ENV`)).toThrow(MissingBuildEnvError)
    }
    expect(() => readBuildEnvVar({}, `API_URL`)).toThrow(
      `Environment variable API_URL is required but not set.`,
    )
  })

  it("gives an empty string for an optional value that is missing", () => {
    expect(readBuildEnvVar({}, `ENV`, { optional: true })).toBe(``)
  })

  it("does not treat a bundler flag as a value", () => {
    expect(readBuildEnvVar({ DEV: true }, `DEV`, { optional: true })).toBe(``)
  })

  it("falls through an empty plain value to the prefixed one", () => {
    expect(readBuildEnvVar({ ENV: ``, VITE_ENV: `dev` }, `ENV`, { prefix: `VITE_` })).toBe(`dev`)
  })
})
