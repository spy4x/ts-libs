import { assertEquals, assertRejects } from "@std/assert"
import { cacheUntilRejected } from "./cache-until-rejected.ts"

Deno.test("runs the loader once and shares its result", async () => {
  let calls = 0
  const get = cacheUntilRejected(() => Promise.resolve(++calls))
  assertEquals(await Promise.all([get(), get()]), [1, 1])
  assertEquals(await get(), 1)
  assertEquals(calls, 1)
})

Deno.test("runs the loader again after it rejected", async () => {
  let calls = 0
  const get = cacheUntilRejected(() => {
    calls++
    return calls === 1 ? Promise.reject(new Error("import failed")) : Promise.resolve(calls)
  })
  await assertRejects(get, Error, "import failed")
  assertEquals(await get(), 2)
  assertEquals(await get(), 2)
  assertEquals(calls, 2)
})
