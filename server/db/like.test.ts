import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { likeContains } from "./like.ts"
import { createNodeSqliteDriver } from "./testing/node-sqlite-driver.ts"
import { LIKE_CASES } from "./testing/like-cases.ts"

describe("likeContains", () => {
  it("escapes backslash, percent and underscore and wraps the text in wildcards", () => {
    expect(likeContains(`ann`)).toBe(`%ann%`)
    expect(likeContains(`100%`)).toBe(`%100\\%%`)
    expect(likeContains(`a_b`)).toBe(`%a\\_b%`)
    expect(likeContains(`C:\\temp`)).toBe(`%C:\\\\temp%`)
    expect(likeContains(`\\%_`)).toBe(`%\\\\\\%\\_%`)
    expect(likeContains(``)).toBe(`%%`)
  })

  it("leaves every other character as it is", () => {
    const others = `abc ABC 123 .*+?^$()[]{}|/'"\`;:-–💸`
    expect(likeContains(others)).toBe(`%${others}%`)
  })

  it("escapes every character of a long run of wildcards", () => {
    const hostile = `%_`.repeat(50_000)
    const pattern = likeContains(hostile)
    expect(pattern.length).toBe(hostile.length * 2 + 2)
    expect(pattern.slice(1, 9)).toBe(`\\%\\_\\%\\_`)
  })

  it("matches only literal text in SQLite, given ESCAPE '\\'", async () => {
    const driver = await createNodeSqliteDriver({ path: `:memory:` })
    try {
      const statement = await driver.prepare(`SELECT ? LIKE ? ESCAPE '\\' AS hit`)
      for (const [search, text, matches] of LIKE_CASES) {
        const row = await statement.get(text, likeContains(search)) as { hit: number }
        expect([search, text, row.hit === 1]).toEqual([search, text, matches])
      }
    } finally {
      await driver.close()
    }
  })
})
