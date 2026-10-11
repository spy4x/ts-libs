/**
 * `announceJson` and `listenJson` against a real server.
 *
 * `notify.test.ts` covers the payload and channel rules against a fake client. What only a real
 * server answers: that a committed transaction's notification arrives and a rolled-back one's never does, that the
 * payload limit is the server's, and that the client subscribes again after its connection is
 * cut, and what its `unlisten` does after that.
 *
 * Isolation: a channel is a name every database connection shares, so each test takes a fresh
 * one. No table or schema is created. Every client is closed in a `finally`.
 */
import { assertEquals, assertRejects } from "@std/assert"
import { type } from "arktype"
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"
import { createSql, type Sql } from "./index.ts"
import { announceJson, listenJson, MAX_NOTIFY_PAYLOAD_BYTES } from "./notify.ts"

const note = type({ n: "number", "+": "reject" })
const text = type("string")

/** Runs `body` with a fresh channel name and `count` separate clients, closed afterwards. */
async function withClients(
  count: number,
  body: (channel: string, ...clients: Sql[]) => Promise<void>,
): Promise<void> {
  const settings = postgresSettings()
  await requireReachable(settings.address)
  const channel = uniqueIdentifier("it_notify")
  const clients = Array.from(
    { length: count },
    (_, index) =>
      createSql({
        connection: settings.connection,
        max: 2,
        applicationName: `${channel}_${index}`,
      }),
  )
  try {
    await body(channel, ...clients)
  } finally {
    await Promise.all(clients.map((client) => client.end()))
  }
}

/** Resolves when `done()` is true; fails after five seconds, so a lost notification is a red test. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

Deno.test("a listener hears what a committed transaction announced, and nothing from one that rolled back", async () => {
  await withClients(2, async (channel, listener, announcer) => {
    const heard: unknown[] = []
    const stop = await listenJson(listener, channel, {
      schema: note,
      onMessage: (message) => void heard.push(message),
    })

    await assertRejects(() =>
      announcer.begin(async (tx) => {
        await announceJson(tx, channel, { n: 1 })
        throw new Error("roll back")
      })
    )
    await announcer.begin((tx) => announceJson(tx, channel, { n: 2 }))
    await announceJson(announcer, channel, { n: 3 })
    await until(() => heard.length >= 2, "the two committed announcements")
    await stop()

    assertEquals(heard, [{ n: 2 }, { n: 3 }])
  })
})

Deno.test("a payload at the limit arrives whole, and the server refuses one byte more", async () => {
  await withClients(2, async (channel, listener, announcer) => {
    const heard: string[] = []
    const stop = await listenJson(listener, channel, {
      schema: text,
      onMessage: (message) => void heard.push(message),
    })
    // Two bytes for the quotes of the JSON string.
    const atLimit = "a".repeat(MAX_NOTIFY_PAYLOAD_BYTES - 2)

    await announceJson(announcer, channel, atLimit)
    await until(() => heard.length === 1, "the payload at the limit")
    await stop()

    assertEquals(heard[0], atLimit)
    await assertRejects(
      () => announcer`SELECT pg_notify(${channel}, ${"a".repeat(MAX_NOTIFY_PAYLOAD_BYTES + 1)})`,
      Error,
      "payload string too long",
    )
  })
})

Deno.test("it listens again after its connection is cut, and stop still silences it", async () => {
  await withClients(2, async (channel, listener, other) => {
    const heard: unknown[] = []
    let subscribed = 0
    const stop = await listenJson(listener, channel, {
      schema: note,
      onMessage: (message) => void heard.push(message),
      onListen: () => void subscribed++,
    })
    assertEquals(subscribed, 1)

    // The listening connection is the client's own; find it by the name this test gave it.
    const cut = await other<{ cut: boolean }[]>`
      SELECT pg_terminate_backend(pid) AS cut FROM pg_stat_activity
      WHERE application_name = ${`${channel}_0`} AND query ILIKE 'listen%'
    `
    assertEquals(cut.map((row) => row.cut), [true])
    await until(() => subscribed === 2, "the second subscription")

    await announceJson(other, channel, { n: 1 })
    await until(() => heard.length === 1, "the announcement after the reconnect")

    await stop()
    // A second handler on the same client is called after the first for each notification, so
    // once it has heard `n: 2` the stopped one has had its turn.
    const later: unknown[] = []
    const stopLater = await listenJson(listener, channel, {
      schema: note,
      onMessage: (message) => void later.push(message),
    })
    await announceJson(other, channel, { n: 2 })
    await until(() => later.length === 1, "the announcement after stop")
    await stopLater()

    assertEquals(later, [{ n: 2 }])
    assertEquals(heard, [{ n: 1 }])
    assertEquals(subscribed, 2)
  })
})
