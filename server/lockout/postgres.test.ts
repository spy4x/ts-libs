import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import type { Sql } from "../db/index.ts"
import { createPostgresLockoutStore } from "./postgres.ts"

/** A client that never connects: building the store sends no statement. */
function client(options: postgres.Options<Record<string, never>> = {}): Sql {
  return postgres({
    host: "127.0.0.1",
    port: 1,
    user: "nobody",
    database: "none",
    ...options,
  }) as unknown as Sql
}

describe("createPostgresLockoutStore", () => {
  it("accepts lower-case table, schema and column names", () => {
    expect(() =>
      createPostgresLockoutStore({
        sql: client(),
        table: "user_totp",
        schema: "app_1",
        columns: { subject: "user_id" },
      })
    ).not.toThrow()
  })

  it("refuses a table, schema or column name that is not a plain lower-case identifier", () => {
    const sql = client()
    for (const name of [`x"; DROP TABLE users; --`, "Users", "a.b", "1table", "", "a".repeat(64)]) {
      expect(() => createPostgresLockoutStore({ sql, table: name })).toThrow(TypeError)
      expect(() => createPostgresLockoutStore({ sql, table: "t", schema: name })).toThrow(TypeError)
      expect(() => createPostgresLockoutStore({ sql, table: "t", columns: { failures: name } }))
        .toThrow(TypeError)
    }
  })

  it("refuses a name the client's column transform would rewrite", () => {
    const sql = client({ transform: { column: { to: (name: string) => `${name}_x` } } })
    expect(() => createPostgresLockoutStore({ sql, table: "lockouts" })).toThrow(
      /transform\.column\.to/,
    )
  })
})
