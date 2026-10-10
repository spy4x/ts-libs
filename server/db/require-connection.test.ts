import { assertEquals, assertThrows } from "@std/assert"
import { createEnvReader } from "../config/env.ts"
import { requireDbConnection } from "./require-connection.ts"

const FULL = { DB_HOST: "db.test", DB_USER: "u", DB_PASS: "p", DB_NAME: "n" }

Deno.test("requireDbConnection names every missing variable in one error", () => {
  const error = assertThrows(
    () => requireDbConnection({ env: createEnvReader({ DB_USER: "u" }) }),
    Error,
  )
  assertEquals(error.message, "integration test needs DB_HOST, DB_PASS, DB_NAME")
})

Deno.test("requireDbConnection treats a blank variable as missing", () => {
  // A reader that hands blanks through, unlike `createEnvReader`, which already hides them.
  const env = { get: (name: string) => name === "DB_PASS" ? "" : FULL[name as keyof typeof FULL] }
  const error = assertThrows(() => requireDbConnection({ env }), Error)
  assertEquals(error.message, "integration test needs DB_PASS")
})

Deno.test("requireDbConnection adds the caller's hint to the error", () => {
  const error = assertThrows(
    () => requireDbConnection({ env: createEnvReader({}), hint: "recipe in docs/handoff.md" }),
    Error,
  )
  assertEquals(error.message.endsWith("(recipe in docs/handoff.md)"), true)
})

Deno.test("requireDbConnection never puts a value in the error", () => {
  const error = assertThrows(
    () => requireDbConnection({ env: createEnvReader({ DB_PASS: "s3cret-value" }) }),
    Error,
  )
  assertEquals(error.message.includes("s3cret-value"), false)
})

Deno.test("requireDbConnection returns the connection, port 5432 and a 5 second timeout", () => {
  assertEquals(requireDbConnection({ env: createEnvReader(FULL) }), {
    connection: { host: "db.test", port: 5432, user: "u", password: "p", database: "n" },
    connectTimeout: 5,
  })
})

Deno.test("requireDbConnection reads DB_PORT when it is set", () => {
  const settings = requireDbConnection({ env: createEnvReader({ ...FULL, DB_PORT: "5433" }) })
  assertEquals(settings.connection.port, 5433)
})

Deno.test("requireDbConnection reads the process environment by default", () => {
  const names = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"]
  const saved = names.map((name) => Deno.env.get(name))
  try {
    for (const name of names) Deno.env.delete(name)
    assertThrows(() => requireDbConnection(), Error, "DB_HOST, DB_USER, DB_PASS, DB_NAME")
    for (const name of names) Deno.env.set(name, "x")
    assertEquals(requireDbConnection().connection.host, "x")
  } finally {
    names.forEach((name, i) => {
      const value = saved[i]
      if (value === undefined) Deno.env.delete(name)
      else Deno.env.set(name, value)
    })
  }
})
