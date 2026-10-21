import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { Sql } from "./ports.ts"
import { ENV_NAME, PROD_FLAG, purgeDatabase } from "./postgres-purge.ts"

/** A client that records a query instead of running one, so a refusal is visible as no call. */
function recordingSql() {
  let queries = 0
  const sql = (() => {
    queries += 1
    throw new Error("purgeDatabase sent a query")
  }) as unknown as Sql
  return { sql, queries: () => queries }
}

describe("purgeDatabase allowed option", () => {
  it("refuses with allowed: false, even for a safe ENV and --prod, and sends no query", async () => {
    const { sql, queries } = recordingSql()

    const result = await purgeDatabase({
      sql,
      allowed: false,
      environment: { [ENV_NAME]: "test" },
      args: [PROD_FLAG],
    })

    assertEquals(result, { dropped: [], refused: true })
    assertEquals(queries(), 0)
  })

  it("keeps the ENV guard when allowed is omitted", async () => {
    const { sql, queries } = recordingSql()

    const result = await purgeDatabase({ sql, environment: { [ENV_NAME]: "production" } })

    assertEquals(result, { dropped: [], refused: true })
    assertEquals(queries(), 0)
  })
})
