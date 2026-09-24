import { expect } from "@std/expect"
import { it } from "@std/testing/bdd"
import * as envAge64 from "./mod.ts"

it("exports exactly the runtime names 1.x freezes", () => {
  expect(Object.keys(envAge64).sort()).toEqual([
    "AGE64_PREFIX",
    "CrlfNotSupportedError",
    "UnsupportedEnvSyntaxError",
    "ageStatus",
    "decryptEnvFiles",
    "decryptValue",
    "encryptEnvFiles",
    "encryptValue",
    "generateAgeKey",
    "isAge64Value",
    "parseEnvFile",
    "readAgeKey",
  ])
})
