import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { isUuid } from "@spy4x/platform/universal/uuid"
import type { Sql } from "../db/index.ts"
import { PostgresIdempotencyStore } from "./postgres.ts"

/**
 * A stand-in for the driver that answers each statement of `begin` by its first keyword and keeps
 * what was sent. `rowExists` decides whether the insert finds the key free or already claimed by a
 * run whose lease has ended.
 */
function fakeSql(rowExists: boolean): { sql: Sql; sent: { text: string; values: unknown[] }[] } {
  const sent: { text: string; values: unknown[] }[] = []
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").trim()
    sent.push({ text, values })
    if (text.startsWith("INSERT")) return Promise.resolve(rowExists ? [] : [{ claimed: 1 }])
    if (text.startsWith("SELECT")) {
      return Promise.resolve([
        { commandName: "C", requestHash: "h", status: 1, result: null, leaseExpired: true },
      ])
    }
    if (text.startsWith("UPDATE")) return Promise.resolve([{ claimed: 1 }])
    return Promise.resolve([])
  }
  return { sql: sql as unknown as Sql, sent }
}

describe("PostgresIdempotencyStore claim token", () => {
  const claim = { userId: 1, key: "k", commandName: "C", requestHash: "h" }

  it("claims a free key with a version 7 UUID and writes that same token to the row", async () => {
    const { sql, sent } = fakeSql(false)
    const outcome = await new PostgresIdempotencyStore(sql).begin(claim)
    if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
    expect(isUuid(outcome.token, 7)).toBe(true)
    const insert = sent.find((statement) => statement.text.startsWith("INSERT"))
    expect(insert?.values).toContain(outcome.token)
  })

  it("takes over an expired claim with a version 7 UUID and writes that same token to the row", async () => {
    const { sql, sent } = fakeSql(true)
    const outcome = await new PostgresIdempotencyStore(sql).begin(claim)
    if (outcome.status !== "claimed") throw new Error(`expected a claim, got ${outcome.status}`)
    expect(isUuid(outcome.token, 7)).toBe(true)
    const update = sent.find((statement) => statement.text.startsWith("UPDATE"))
    expect(update?.values).toContain(outcome.token)
  })
})
