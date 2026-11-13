import { assertThrows } from "@std/assert"
import type { Sql } from "../db/index.ts"
import { PostgresOutboxRepository } from "./postgres-repository.ts"

Deno.test("refuses an empty only list, which would claim nothing", () => {
  // The check runs before the client is touched, so no server is needed.
  const sql = (() => {
    throw new Error("the client must not be used")
  }) as unknown as Sql
  assertThrows(
    () => new PostgresOutboxRepository(sql, { kinds: { only: [] } }),
    RangeError,
    "kinds.only",
  )
})
