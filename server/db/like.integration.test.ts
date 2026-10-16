/**
 * `likeContains` against a real Postgres, with its default `LIKE` escape. Only a `SELECT` of bound
 * parameters: nothing is created or written, so nothing shared is touched.
 */
import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { postgresSettings, requireReachable } from "@integration-testing"
import { createSql } from "./postgres.ts"
import { likeContains } from "./like.ts"
import { LIKE_CASES } from "./testing/like-cases.ts"

describe("likeContains on Postgres", () => {
  it("matches only literal text with the default escape, in LIKE and ILIKE", async () => {
    const settings = postgresSettings()
    await requireReachable(settings.address)
    const sql = createSql({ connection: settings.connection, max: 1 })
    try {
      for (const [search, text, matches] of LIKE_CASES) {
        const [row] = await sql<{ hit: boolean; insensitive: boolean }[]>`
          SELECT ${text}::text LIKE ${likeContains(search)} AS hit,
            upper(${text}::text) ILIKE ${likeContains(search)} AS insensitive
        `
        expect([search, text, row.hit, row.insensitive]).toEqual([search, text, matches, matches])
      }
    } finally {
      await sql.end()
    }
  })
})
