/**
 * The Postgres subscriber store and send log against a real server, held to the shared contracts,
 * plus what only a database can show: concurrent add and remove, and the send lock.
 *
 * Isolation: every test creates its own schema, points a pool at it with `search_path`, and drops
 * the schema in a `finally`. Nothing shared is touched.
 */
import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import postgres from "postgres"
import { buildPostgresOptions, type Sql } from "../db/index.ts"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import {
  createPostgresSendLog,
  createPostgresSubscriberStore,
  SUBSCRIBERS_POSTGRES_SCHEMA,
} from "./postgres.ts"
import { describeSubscriberStoreContract } from "./store-contract.test.ts"
import { describeSendLogContract } from "./send-log-contract.test.ts"

/** A fresh schema holding the tables, a pool of `max` connections on it, and the cleanup. */
async function openSchema(max = 12): Promise<{ sql: Sql; close(): Promise<void> }> {
  const settings = postgresSettings()
  await requireReachable(settings.address)

  const schema = uniqueIdentifier("it_subs")
  const admin = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max: 1 }),
    onnotice: () => {},
  }) as unknown as Sql
  await admin`CREATE SCHEMA ${admin(schema)}`
  const sql = postgres({
    ...buildPostgresOptions({ connection: settings.connection, max }),
    connection: { application_name: schema, search_path: schema },
    onnotice: () => {},
  }) as unknown as Sql
  const close = async () => {
    await sql.end()
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
    await admin.end()
  }
  try {
    await sql.unsafe(SUBSCRIBERS_POSTGRES_SCHEMA)
  } catch (error) {
    await close()
    throw error
  }
  return { sql, close }
}

describeSubscriberStoreContract("createPostgresSubscriberStore", async () => {
  const { sql, close } = await openSchema()
  return { store: createPostgresSubscriberStore(sql, { listId: `news` }), close }
})

describeSendLogContract("createPostgresSendLog", async () => {
  const { sql, close } = await openSchema()
  return { log: createPostgresSendLog(sql, { listId: `news` }), close }
})

const NOW = Date.UTC(2001, 0, 1)

describe("createPostgresSubscriberStore on a real server", () => {
  it("keeps two lists in one schema apart", async () => {
    const { sql, close } = await openSchema()
    try {
      const news = createPostgresSubscriberStore(sql, { listId: `news` })
      const promo = createPostgresSubscriberStore(sql, { listId: `promo` })
      const input = {
        email: `ann@example.com`,
        key: `ann-key`,
        mark: `ann-mark`,
        issuedAt: NOW,
        at: new Date(NOW),
      }
      expect(await news.add(input)).toBe(`added`)
      expect(await promo.list()).toEqual([])
      expect(await promo.count()).toBe(0)
      expect(await promo.findByKey(`ann-key`)).toBeUndefined()
      // The same address joins the other list, and leaving one list does not leave the other.
      expect(await promo.add(input)).toBe(`added`)
      await news.remove({ ...input, at: new Date(NOW + 1), pruneBefore: new Date(0) })
      expect(await news.count()).toBe(0)
      expect(await promo.count()).toBe(1)
      // The unsubscribe is recorded on `news` only.
      expect(await news.add({ ...input, issuedAt: NOW })).toBe(`replay`)
      await promo.remove({ ...input, email: `other@example.com`, pruneBefore: new Date(0) })
      expect(await promo.add({ ...input, email: `bob@example.com`, key: `bob-key` })).toBe(`replay`)
    } finally {
      await close()
    }
  })

  it("refuses two addresses that carry one key", async () => {
    const { sql, close } = await openSchema()
    try {
      const store = createPostgresSubscriberStore(sql, { listId: `news` })
      const at = new Date(NOW)
      await store.add({ email: `ann@example.com`, key: `same`, mark: `a`, issuedAt: NOW, at })
      await expect(
        store.add({ email: `bob@example.com`, key: `same`, mark: `b`, issuedAt: NOW, at }),
      ).rejects.toThrow()
      expect(await store.count()).toBe(1)
    } finally {
      await close()
    }
  })

  it("never brings an address back when a replayed confirm link races its removal", async () => {
    const { sql, close } = await openSchema()
    try {
      const store = createPostgresSubscriberStore(sql, { listId: `news` })
      const names = Array.from({ length: 120 }, (_, i) => `user${i}`)
      // Every link was issued before the removal, so each one is a replay if the removal ran first,
      // and the removal deletes the row if the add ran first. The address ends up absent either way.
      await Promise.all(names.flatMap((name) => [
        store.add({
          email: `${name}@example.com`,
          key: `${name}-key`,
          mark: `${name}-mark`,
          issuedAt: NOW,
          at: new Date(NOW + 1),
        }),
        store.remove({
          email: `${name}@example.com`,
          mark: `${name}-mark`,
          at: new Date(NOW + 2),
          pruneBefore: new Date(0),
        }),
      ]))
      expect(await store.list()).toEqual([])
      expect(await store.count()).toBe(0)
    } finally {
      await close()
    }
  })
})

describe("createPostgresSendLog on a real server", () => {
  it("grants one of several simultaneous locks on an issue", async () => {
    const { sql, close } = await openSchema()
    try {
      const log = createPostgresSendLog(sql, { listId: `news` })
      const locks = await Promise.all(Array.from({ length: 6 }, () => log.lock(`post`)))
      try {
        expect(locks.filter((lock) => lock !== undefined).length).toBe(1)
      } finally {
        for (const lock of locks) await lock?.release()
      }
    } finally {
      await close()
    }
  })

  it("keeps refusing a second lock while the holder's pool is busy with other queries", async () => {
    const { sql, close } = await openSchema()
    try {
      const log = createPostgresSendLog(sql, { listId: `news` })
      const held = await log.lock(`post`)
      try {
        expect(held).toBeDefined()
        await Promise.all(Array.from({ length: 30 }, () => log.find(`post`)))
        expect(await log.lock(`post`)).toBeUndefined()
      } finally {
        await held?.release()
      }
      const again = await log.lock(`post`)
      expect(again).toBeDefined()
      await again?.release()
    } finally {
      await close()
    }
  })

  it("locks one issue at a time and another list's issue separately", async () => {
    const { sql, close } = await openSchema()
    try {
      const news = createPostgresSendLog(sql, { listId: `news` })
      const promo = createPostgresSendLog(sql, { listId: `promo` })
      const first = await news.lock(`post`)
      const other = await news.lock(`other`)
      const sameName = await promo.lock(`post`)
      try {
        expect(first).toBeDefined()
        expect(other).toBeDefined()
        expect(sameName).toBeDefined()
      } finally {
        await first?.release()
        await other?.release()
        await sameName?.release()
      }
    } finally {
      await close()
    }
  })

  it("keeps two lists' entries for one issue apart", async () => {
    const { sql, close } = await openSchema()
    try {
      const news = createPostgresSendLog(sql, { listId: `news` })
      const promo = createPostgresSendLog(sql, { listId: `promo` })
      await news.start({ issue: `post`, subject: `S`, audience: [`a1`], at: new Date(NOW) })
      await news.record(`post`, `a1`)
      expect(await promo.find(`post`)).toBeUndefined()
      await expect(promo.record(`post`, `a1`)).rejects.toThrow(`never started`)
    } finally {
      await close()
    }
  })

  it("treats an entry with no recipients as legacy and gives an audience only to a recorded one", async () => {
    const { sql, close } = await openSchema()
    try {
      const log = createPostgresSendLog(sql, { listId: `news` })
      const at = new Date(NOW)
      await sql`
        INSERT INTO subscriber_sends (list_id, issue, subject, started_at)
        VALUES ('news', 'legacy', 'L', ${at})
      `
      await sql`
        INSERT INTO subscriber_sends (list_id, issue, subject, started_at, recipients)
        VALUES ('news', 'noaudience', 'N', ${at}, ARRAY['a1'])
      `
      const legacy = await log.start({ issue: `legacy`, subject: `X`, audience: [`z`], at })
      expect(legacy).toEqual({ issue: `legacy`, subject: `L`, startedAt: at })
      const noAudience = await log.start({ issue: `noaudience`, subject: `X`, audience: [`z`], at })
      expect(noAudience.audience).toEqual([`z`])
      expect(noAudience.recipients).toEqual([`a1`])
    } finally {
      await close()
    }
  })
})
