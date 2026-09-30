import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { fromFileUrl } from "@std/path"

import { loadEntries } from "./contract.ts"
import {
  exportsFromDocJson,
  exportSurface,
  FINGERPRINT_PREFIX,
  firstSentence,
  importSpecifier,
  loadReadmes,
  renderLlms,
  renderLlmsFull,
  surfaceFingerprint,
} from "./llms.ts"

describe("firstSentence", () => {
  it("takes the text up to the first full stop and joins wrapped lines", () => {
    expect(firstSentence("Parse an address\nand return it. Second sentence.")).toBe(
      "Parse an address and return it.",
    )
  })

  it("reads a link tag as the name it points at", () => {
    expect(firstSentence("Outcome of {@link parseIp}.")).toBe("Outcome of parseIp.")
  })

  it("stays blank when there is no JSDoc rather than inventing a summary", () => {
    expect(firstSentence(undefined)).toBe("")
    expect(firstSentence("  ")).toBe("")
  })

  it("does not end a sentence at e.g. or i.e.", () => {
    expect(firstSentence("Fetch a URL, e.g. a feed, safely. More.")).toBe(
      "Fetch a URL, e.g. a feed, safely.",
    )
    expect(firstSentence("Small, i.e. bounded. More.")).toBe("Small, i.e. bounded.")
  })

  it("does not end a sentence at a dot inside a name", () => {
    expect(firstSentence("Reads `Deno.env` once")).toBe("Reads `Deno.env` once")
  })
})

describe("exportsFromDocJson", () => {
  it("names each export's kind in library terms and sorts by name", () => {
    const json = {
      nodes: {
        "file:///a.ts": {
          symbols: [
            { name: "zed", declarations: [{ kind: "function", jsDoc: { doc: "Does Z." } }] },
            { name: "LIMIT", declarations: [{ kind: "variable" }] },
            { name: "Shape", declarations: [{ kind: "typeAlias", jsDoc: { doc: "A shape." } }] },
          ],
        },
      },
    }
    expect(exportsFromDocJson(json)).toEqual([
      { name: "LIMIT", kind: "constant", summary: "" },
      { name: "Shape", kind: "type", summary: "A shape." },
      { name: "zed", kind: "function", summary: "Does Z." },
    ])
  })

  it("takes an overloaded function's summary from the declaration that has one", () => {
    const json = {
      nodes: {
        "file:///a.ts": {
          symbols: [{
            name: "f",
            declarations: [{ kind: "function" }, { kind: "function", jsDoc: { doc: "Docs." } }],
          }],
        },
      },
    }
    expect(exportsFromDocJson(json)[0].summary).toBe("Docs.")
  })
})

describe("renderLlms", () => {
  const entry = { specifier: "@spy4x/net/ip", pkg: "net" }
  const exports = [{ name: "parseIp", kind: "function", summary: "Parse one address." }, {
    name: "Bare",
    kind: "interface",
    summary: "",
  }]

  it("lists each export with its kind, import specifier and summary", () => {
    const text = renderLlms([{ entry, exports }], "abc")
    expect(text).toContain("## @spy4x/net\n\n### `jsr:@spy4x/net/ip`")
    expect(text).toContain("- `parseIp` (function), `jsr:@spy4x/net/ip`: Parse one address.\n")
    expect(text).toContain("- `Bare` (interface), `jsr:@spy4x/net/ip`\n")
  })

  it("is byte-stable and ends with the fingerprint", () => {
    const one = renderLlms([{ entry, exports }], "abc")
    expect(renderLlms([{ entry, exports }], "abc")).toBe(one)
    expect(one.endsWith(`${FINGERPRINT_PREFIX}abc -->\n`)).toBe(true)
  })

  it("prefixes the import specifier with jsr:", () => {
    expect(importSpecifier(entry)).toBe("jsr:@spy4x/net/ip")
  })
})

describe("exportSurface", () => {
  it("changes when an export is added or its summary changes, not when a body changes", () => {
    const base = `/** Adds. */\nexport function add(a: number) {\n  return a + 1\n}\n`
    const surface = exportSurface(base)
    expect(exportSurface(base.replace("a + 1", "a + 2"))).toBe(surface)
    expect(exportSurface(base + `export const X = 1\n`)).not.toBe(surface)
    expect(exportSurface(base.replace("Adds.", "Adds one."))).not.toBe(surface)
  })

  it("reads a multi-line braced re-export in full", () => {
    const text = `export {\n  a,\n  b,\n} from "./x.ts"\n`
    expect(exportSurface(text)).toContain("b,")
  })
})

describe("generated files", () => {
  const root = fromFileUrl(import.meta.resolve("../../"))
  const fix = "Run `deno task llms` and commit llms.txt and llms-full.txt."

  it("llms.txt lists every entry point and matches the current export surface", async () => {
    const text = await Deno.readTextFile(`${root}/llms.txt`)
    const entries = await loadEntries(root)
    for (const entry of entries) {
      if (!text.includes(`### \`${importSpecifier(entry)}\`\n`)) {
        throw new Error(`llms.txt has no section for ${entry.specifier}. ${fix}`)
      }
    }
    const fingerprint = await surfaceFingerprint(root, entries)
    if (!text.endsWith(`${FINGERPRINT_PREFIX}${fingerprint} -->\n`)) {
      throw new Error(
        `llms.txt is out of date: an export, its JSDoc or an entry point changed. ${fix}`,
      )
    }
  })

  it("llms-full.txt holds the root README and every package README as they are now", async () => {
    const entries = await loadEntries(root)
    const expected = renderLlmsFull(await loadReadmes(root, entries))
    const actual = await Deno.readTextFile(`${root}/llms-full.txt`)
    if (actual !== expected) throw new Error(`llms-full.txt is out of date. ${fix}`)
    expect(actual.startsWith("# README.md\n")).toBe(true)
    expect(actual).toContain("# net/README.md\n")
    expect(actual).toContain("# platform/rate-limit/README.md\n")
    expect(actual).toContain("# server/env-age64/README.md\n")
  })
})
