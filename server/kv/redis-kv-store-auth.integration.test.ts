/**
 * `RedisKvStore`'s AUTH handshake against a real Redis started with `requirepass`
 * (`redis-auth` in `infra/compose.integration.yml`), the path the unit tests only
 * exercise against scripted replies (#360).
 *
 * Keys sit under a unique prefix and are removed in a `finally`; nothing flushes the
 * server.
 */
import { assertEquals, assertInstanceOf, assertRejects, assertStrictEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { redisAuthSettings, requireReachable, uniqueKeyPrefix } from "@integration-testing"
import { RedisKvStore, RedisKvStoreAuthError } from "./redis-kv-store.ts"

/** Connects with `password` and returns the error the server's refusal turned into. */
async function refusal(password: string | undefined): Promise<RedisKvStoreAuthError> {
  const settings = redisAuthSettings()
  await requireReachable(settings.address)
  const error = await assertRejects(
    () =>
      RedisKvStore.connect(
        settings.hostname,
        settings.port,
        uniqueKeyPrefix("it_kv_auth"),
        password === undefined ? {} : { password },
      ),
  )
  assertInstanceOf(error, RedisKvStoreAuthError)
  return error
}

describe("RedisKvStore against a password-protected server", () => {
  it("connects and stores a value when the password is correct", async () => {
    const settings = redisAuthSettings()
    await requireReachable(settings.address)
    const store = await RedisKvStore.connect(
      settings.hostname,
      settings.port,
      uniqueKeyPrefix("it_kv_auth"),
      { password: settings.password },
    )
    try {
      await store.set("greeting", "hello through AUTH", 60)
      assertEquals(await store.get("greeting"), "hello through AUTH")
    } finally {
      try {
        await store.reset()
      } finally {
        store.close()
      }
    }
  })

  it("rejects a wrong password with WRONGPASS and never repeats the password", async () => {
    const wrong = "not-the-password"
    const error = await refusal(wrong)
    assertStrictEquals(error.code, "WRONGPASS")
    assertStrictEquals(error.message.includes(wrong), false)
    assertStrictEquals(error.message.includes(redisAuthSettings().password), false)
  })

  it("rejects a connection without a password with NOAUTH", async () => {
    assertStrictEquals((await refusal(undefined)).code, "NOAUTH")
  })
})
