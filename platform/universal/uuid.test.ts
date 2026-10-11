import { assert, assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import { isUuid, UUID_PATTERN, UUID_V7_PATTERN, uuidV7 } from "./uuid.ts"

const V4 = `0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e`
const V7 = `017f22e2-79b0-7cc3-98c4-dc0c0c07398f`

describe(`uuidV7`, () => {
  it(`makes a lower-case id with version digit 7 and variant digit 8, 9, a or b`, () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidV7()
      assert(UUID_V7_PATTERN.test(id), id)
      assertEquals(id[14], `7`)
      assert(`89ab`.includes(id[19]), id)
      assertEquals(id, id.toLowerCase())
    }
  })

  it(`starts with the creation time in milliseconds`, () => {
    const before = Date.now()
    const id = uuidV7()
    const stamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    assert(stamp >= before && stamp <= Date.now() + 1000)
  })

  it(`sorts ids made inside one millisecond in creation order`, () => {
    const ids = Array.from({ length: 5000 }, () => uuidV7())
    assertEquals([...ids].sort(), ids)
    assertEquals(new Set(ids).size, ids.length)
  })

  it(`keeps order when the clock stands still or goes back`, () => {
    const realNow = Date.now
    try {
      const first = uuidV7()
      Date.now = () => realNow() - 60_000
      const second = uuidV7()
      Date.now = () => realNow() - 60_000
      const third = uuidV7()
      assertEquals([third, second, first].sort(), [first, second, third])
    } finally {
      Date.now = realNow
    }
  })
})

describe(`isUuid`, () => {
  it(`accepts a lower-case UUID of any version`, () => {
    assert(isUuid(V4))
    assert(isUuid(V7))
    assert(isUuid(crypto.randomUUID()))
  })

  it(`refuses upper case, wrong length, other shapes and non-strings`, () => {
    assert(!isUuid(V4.toUpperCase()))
    assert(!isUuid(V4.slice(1)))
    assert(!isUuid(`${V4}0`))
    assert(!isUuid(V4.replaceAll(`-`, ``)))
    assert(!isUuid(`g${V4.slice(1)}`))
    assert(!isUuid(``))
    assert(!isUuid(null))
    assert(!isUuid(7))
  })

  it(`accepts only the named version`, () => {
    assert(isUuid(V7, 7))
    assert(isUuid(uuidV7(), 7))
    assert(!isUuid(V4, 7))
    assert(isUuid(V4, 4))
    assert(!isUuid(V7, 4))
  })

  it(`refuses a version 7 id without the RFC variant bits`, () => {
    assert(!isUuid(`017f22e2-79b0-7cc3-c8c4-dc0c0c07398f`, 7))
    assert(!isUuid(`0b1c2d3e-4f5a-4b6c-cd7e-9f0a1b2c3d4e`, 4))
  })
})

describe(`UUID_PATTERN`, () => {
  it(`works as an arktype schema`, () => {
    const schema = type(UUID_PATTERN)
    assert(!(schema(V4) instanceof type.errors))
    assert(schema(`nope`) instanceof type.errors)
  })
})
