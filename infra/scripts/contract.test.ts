import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { entriesFrom, workspaceDirs } from "./contract.ts"

describe("workspaceDirs", () => {
  it("reads the member directories from the root config's workspace list", () => {
    const text = `{ // comment\n  "workspace": [\n    "./net",\n    "./time"\n  ],\n  "tasks": {} }`
    expect(workspaceDirs(text)).toEqual(["net", "time"])
  })
})

describe("entriesFrom", () => {
  const configs: Record<string, { exports: Record<string, string> }> = {
    time: { exports: { ".": "./mod.ts", "./tz": "./tz.ts" } },
    net: { exports: { "./ip": "./ip.ts" } },
  }

  it("maps `.` to the bare package name and other keys to a subpath, sorted", () => {
    const entries = entriesFrom(["time", "net"], (dir) => configs[dir])
    expect(entries.map((entry) => entry.specifier)).toEqual([
      "@spy4x/net/ip",
      "@spy4x/time",
      "@spy4x/time/tz",
    ])
    expect(entries.map((entry) => entry.pkg)).toEqual(["net", "time", "time"])
  })

  it("lists an export key added to a member's deno.json without any script edit", () => {
    const before = entriesFrom(["time"], (dir) => configs[dir]).map((entry) => entry.specifier)
    const grown = { time: { exports: { ...configs.time.exports, "./ics": "./ics.ts" } } }
    const after = entriesFrom(["time"], (dir) => grown[dir as "time"]).map((entry) =>
      entry.specifier
    )
    expect(before).not.toContain("@spy4x/time/ics")
    expect(after).toContain("@spy4x/time/ics")
  })

  it("skips a member whose directory does not exist", () => {
    const entries = entriesFrom(["ghost", "net"], (dir) => configs[dir])
    expect(entries.map((entry) => entry.specifier)).toEqual(["@spy4x/net/ip"])
  })
})
