/**
 * `openAuthSchema` ends the admin connection when setup fails (#347). A fake driver records every
 * statement and every `end()`, so no database is needed.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Sql } from "../db/index.ts"
import { type ConnectPostgres, openAuthSchema } from "./postgres-schema-fixture.test.ts"

const CONNECTION = { host: `127.0.0.1`, port: 1, user: `u`, password: `p`, database: `d` }

interface FakePool {
  statements: string[]
  ended: boolean
}

/** Pools made in order: the admin first, then the schema pool. `failOn` throws on a statement. */
function fakeDriver(failOn: RegExp | null): { connect: ConnectPostgres; pools: FakePool[] } {
  const pools: FakePool[] = []
  const connect: ConnectPostgres = () => {
    const pool: FakePool = { statements: [], ended: false }
    pools.push(pool)
    const run = (text: string) => {
      pool.statements.push(text)
      if (failOn?.test(text)) return Promise.reject(new Error(`boom`))
      return Promise.resolve([])
    }
    // `admin(schema)` is an identifier helper; a template call is a statement.
    const sql =
      ((strings: TemplateStringsArray | string) =>
        Array.isArray(strings) ? run(strings.join(`?`)) : `ident`) as unknown as Sql
    Object.assign(sql, {
      unsafe: (text: string) => run(text),
      end: () => {
        pool.ended = true
        return Promise.resolve()
      },
    })
    return sql
  }
  return { connect, pools }
}

const options = (connect: ConnectPostgres) => ({
  prefix: `it_fake`,
  connection: CONNECTION,
  poolSize: 2,
  connect,
})

describe(`openAuthSchema`, () => {
  it(`ends the admin connection when CREATE SCHEMA fails`, async () => {
    const { connect, pools } = fakeDriver(/CREATE SCHEMA/)
    await expect(openAuthSchema(options(connect))).rejects.toThrow(`boom`)
    expect(pools[0].ended).toBe(true)
  })

  it(`ends both connections and drops the schema when the auth tables fail to apply`, async () => {
    const { connect, pools } = fakeDriver(/CREATE TABLE/i)
    await expect(openAuthSchema(options(connect))).rejects.toThrow(`boom`)
    expect(pools.map((p) => p.ended)).toEqual([true, true])
    expect(pools[0].statements.some((s) => /DROP SCHEMA/.test(s))).toBe(true)
  })

  it(`ends both connections and drops the schema on close`, async () => {
    const { connect, pools } = fakeDriver(null)
    const database = await openAuthSchema(options(connect))
    expect(pools.map((p) => p.ended)).toEqual([false, false])
    await database.close()
    expect(pools.map((p) => p.ended)).toEqual([true, true])
    expect(pools[0].statements.some((s) => /DROP SCHEMA/.test(s))).toBe(true)
  })
})
