import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Sql } from "../db/index.ts"
import {
  createPostgresSendLog,
  createPostgresSubscriberStore,
  SUBSCRIBERS_POSTGRES_SCHEMA,
} from "./postgres.ts"

// Neither factory touches the database while it validates its options.
const noDatabase = {} as unknown as Sql

describe("SUBSCRIBERS_POSTGRES_SCHEMA", () => {
  it("keys every table by list and makes the subscriber key unique per list", () => {
    expect(SUBSCRIBERS_POSTGRES_SCHEMA).toContain(`PRIMARY KEY (list_id, email)`)
    expect(SUBSCRIBERS_POSTGRES_SCHEMA).toContain(`UNIQUE (list_id, key)`)
    expect(SUBSCRIBERS_POSTGRES_SCHEMA).toContain(`PRIMARY KEY (list_id, mark)`)
    expect(SUBSCRIBERS_POSTGRES_SCHEMA).toContain(`PRIMARY KEY (list_id, issue)`)
  })

  it("creates the subscriber, unsubscribe-mark and send-log tables", () => {
    for (const table of [`subscribers`, `subscriber_unsubscribes`, `subscriber_sends`]) {
      expect(SUBSCRIBERS_POSTGRES_SCHEMA).toContain(`CREATE TABLE ${table} (`)
    }
  })
})

describe("the Postgres subscriber store and send log options", () => {
  const factories = {
    createPostgresSubscriberStore,
    createPostgresSendLog,
  }
  for (const [name, create] of Object.entries(factories)) {
    it(`${name} refuses a missing or empty listId`, () => {
      expect(() => create(noDatabase, { listId: `` })).toThrow(TypeError)
      expect(() => create(noDatabase, { listId: undefined as unknown as string })).toThrow(
        TypeError,
      )
      expect(() => create(noDatabase, undefined as unknown as { listId: string })).toThrow(
        TypeError,
      )
    })

    it(`${name} accepts a non-empty listId`, () => {
      expect(() => create(noDatabase, { listId: `news` })).not.toThrow()
    })
  }
})
