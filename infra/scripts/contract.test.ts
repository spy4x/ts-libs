import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { fromFileUrl } from "@std/path"

import { assertWorkspaceComplete, entriesFrom, loadEntries, workspaceDirs } from "./contract.ts"

describe("workspaceDirs", () => {
  it("reads the member directories from the root config's workspace list", () => {
    const text = `{ // comment\n  "workspace": [\n    "./net",\n    "./time"\n  ],\n  "tasks": {} }`
    expect(workspaceDirs(text)).toEqual(["net", "time"])
  })

  it("throws when the root config has no workspace list", () => {
    expect(() => workspaceDirs(`{ "tasks": {} }`)).toThrow(`no "workspace" list`)
  })
})

describe("assertWorkspaceComplete", () => {
  it("throws naming a directory with a deno.json that the list dropped", () => {
    expect(() => assertWorkspaceComplete(["net"], ["net", "time"])).toThrow("time")
  })

  it("accepts a listed directory that does not exist, as Deno does", () => {
    expect(() => assertWorkspaceComplete(["ai", "net"], ["net"])).not.toThrow()
  })

  it("catches the silent drop a comment with a bracket causes in the workspace read", () => {
    const listed = workspaceDirs(`{ "workspace": [ "./net", // see [#22]\n "./time" ] }`)
    expect(() => assertWorkspaceComplete(listed, ["net", "time"])).toThrow("time")
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

  it("accepts the string form of exports as the `.` entry", () => {
    const entries = entriesFrom(["net"], () => ({ exports: "./mod.ts" }))
    expect(entries.map((entry) => entry.specifier)).toEqual(["@spy4x/net"])
  })

  it("skips a member whose directory does not exist", () => {
    const entries = entriesFrom(["ghost", "net"], (dir) => configs[dir])
    expect(entries.map((entry) => entry.specifier)).toEqual(["@spy4x/net/ip"])
  })
})

describe("loadEntries", () => {
  it("throws when a comment with a bracket in the workspace list hides a member", async () => {
    const root = fromFileUrl(import.meta.resolve("./contract-fixtures/dropped-member"))
    await expect(loadEntries(root)).rejects.toThrow("time")
  })

  it("throws naming the file when a member's deno.json does not parse as JSON", async () => {
    const root = fromFileUrl(import.meta.resolve("./contract-fixtures/invalid-json"))
    await expect(loadEntries(root)).rejects.toThrow(`${root}/time/deno.json: `)
  })
})

describe("docs/1.0-contract.md", () => {
  it("has one heading per entry point the workspace's exports maps publish", async () => {
    const root = fromFileUrl(import.meta.resolve("../../"))
    const document = await Deno.readTextFile(`${root}/docs/1.0-contract.md`)
    const headings = [...document.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])
    const entries = await loadEntries(root)
    expect(entries.length).toBeGreaterThan(100)
    expect(headings).toEqual(entries.map((entry) => entry.specifier))
  })
})
