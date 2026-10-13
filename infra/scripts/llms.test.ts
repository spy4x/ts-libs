import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { fromFileUrl } from "@std/path"

import { loadEntries, resolveEntry } from "./contract.ts"
import {
  deprecatedSummary,
  describesParameters,
  exportLine,
  exportsFromDocJson,
  exportSurface,
  FINGERPRINT_PREFIX,
  firstSentence,
  HEADER,
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

  it("marks an export deprecated by its own tag or by its module's, the own tag first", () => {
    const deprecated = (doc: string) => ({
      tags: [{ kind: "deprecated", doc }, { kind: "module" }],
    })
    const json = {
      nodes: {
        "file:///old.ts": {
          module_doc: deprecated("Import from `@spy4x/tasks/model`. It stays until 2.0."),
          symbols: [
            { name: "a", declarations: [{ kind: "function", jsDoc: { doc: "Does A." } }] },
            {
              name: "b",
              declarations: [{
                kind: "function",
                jsDoc: { doc: "Does B.", ...deprecated("Use `c`") },
              }],
            },
          ],
        },
        "file:///new.ts": {
          module_doc: { tags: [{ kind: "module" }] },
          symbols: [{ name: "c", declarations: [{ kind: "function", jsDoc: { doc: "Does C." } }] }],
        },
      },
    }
    expect(exportsFromDocJson(json).map((item) => item.summary)).toEqual([
      "Deprecated: Import from `@spy4x/tasks/model`. Does A.",
      "Deprecated: Use `c`. Does B.",
      "Does C.",
    ])
  })
})

describe("deprecatedSummary", () => {
  it("says only Deprecated when the tag has no text and the export no summary", () => {
    expect(deprecatedSummary("", [{ kind: "deprecated" }])).toBe("Deprecated.")
  })

  it("leaves the summary alone without the tag", () => {
    expect(deprecatedSummary("Does A.", [{ kind: "example", doc: "a()" }])).toBe("Does A.")
    expect(deprecatedSummary("Does A.", undefined)).toBe("Does A.")
  })
})

describe("describesParameters", () => {
  const named = (name: string, kind: string) => ({ name, kind, summary: "" })
  const dropped = (...exports: { name: string; kind: string; summary: string }[]) =>
    [...describesParameters(exports)].sort()

  it("leaves out a type named after a listed export plus a parameter suffix", () => {
    expect(dropped(
      named("Notice", "function"),
      named("NoticeProps", "interface"),
      named("NoticeLabels", "type"),
      named("NoticeOptions", "interface"),
      named("NoticeConfig", "interface"),
      named("NoticeDeps", "interface"),
      named("NoticeInput", "type"),
    )).toEqual([
      "NoticeConfig",
      "NoticeDeps",
      "NoticeInput",
      "NoticeLabels",
      "NoticeOptions",
      "NoticeProps",
    ])
  })

  it("matches a function that starts in lower case or with create", () => {
    expect(dropped(
      named("safeFetch", "function"),
      named("SafeFetchOptions", "interface"),
      named("createStorage", "function"),
      named("StorageConfig", "type"),
    )).toEqual(["SafeFetchOptions", "StorageConfig"])
  })

  it("keeps a type whose name follows no listed export", () => {
    expect(dropped(named("parseIcal", "function"), named("IcalParseOptions", "interface")))
      .toEqual([])
    expect(dropped(named("Options", "interface"), named("Props", "type"))).toEqual([])
  })

  it("keeps a type with another ending, such as a result or a store", () => {
    expect(dropped(
      named("safeFetch", "function"),
      named("SafeFetchResult", "type"),
      named("Billing", "interface"),
      named("BillingProvider", "interface"),
      named("BillingStore", "interface"),
    )).toEqual([])
  })

  it("keeps a function, class, constant or enum whatever its name", () => {
    expect(dropped(
      named("Notice", "function"),
      named("NoticeOptions", "function"),
      named("NoticeConfig", "class"),
      named("NoticeInput", "constant"),
      named("NoticeLabels", "enum"),
    )).toEqual([])
  })

  it("keeps a type whose only namesake is itself left out", () => {
    expect(dropped(
      named("Notice", "function"),
      named("NoticeOptions", "interface"),
      named("NoticeOptionsInput", "type"),
    )).toEqual(["NoticeOptions"])
  })
})

describe("exportLine", () => {
  it("joins name, kind, import specifier and summary with one tab each", () => {
    const item = { name: "parseIp", kind: "function", summary: "Parse one address." }
    expect(exportLine(item, "@spy4x/net/ip")).toBe(
      "parseIp\tfunction\t@spy4x/net/ip\tParse one address.",
    )
  })

  it("keeps three tabs when there is no summary", () => {
    expect(exportLine({ name: "Bare", kind: "interface", summary: "" }, "@spy4x/net/ip")).toBe(
      "Bare\tinterface\t@spy4x/net/ip\t",
    )
  })

  it("turns a tab or a line break inside a summary into one space", () => {
    const item = { name: "f", kind: "function", summary: "One\ttwo\r\nthree. " }
    expect(exportLine(item, "@spy4x/net")).toBe("f\tfunction\t@spy4x/net\tOne two three.")
  })
})

describe("renderLlms", () => {
  const entry = { specifier: "@spy4x/net/ip", pkg: "net" }
  const exports = [
    { name: "ParseIpOptions", kind: "interface", summary: "What parseIp takes." },
    { name: "ParseIpResult", kind: "type", summary: "" },
    { name: "parseIp", kind: "function", summary: "Parse one address." },
  ]

  it("writes the header, one line per export and the fingerprint, and nothing else", () => {
    expect(renderLlms([{ entry, exports }], "abc").split("\n")).toEqual([
      ...HEADER,
      "ParseIpResult\ttype\t@spy4x/net/ip\t",
      "parseIp\tfunction\t@spy4x/net/ip\tParse one address.",
      `${FINGERPRINT_PREFIX}abc`,
      "",
    ])
  })

  it("starts every header line and the fingerprint line with #, so none reads as an export", () => {
    for (const line of [...HEADER, FINGERPRINT_PREFIX]) {
      expect(line.startsWith("# ")).toBe(true)
      expect(line).not.toContain("\t")
    }
  })

  it("leaves a parameter type out only in the entry point that lists its namesake", () => {
    const other = { specifier: "@spy4x/net/types", pkg: "net" }
    const text = renderLlms([
      { entry, exports },
      { entry: other, exports: [exports[0]] },
    ], "abc")
    expect(text).not.toContain("ParseIpOptions\tinterface\t@spy4x/net/ip\t")
    expect(text).toContain("ParseIpOptions\tinterface\t@spy4x/net/types\tWhat parseIp takes.\n")
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

  it("changes when a module's own JSDoc gains or loses @deprecated", () => {
    const module = (tag: string) =>
      `/**\n * Old home.\n *${tag}\n * @module\n */\n\nimport "./a.ts"\n`
    const plain = exportSurface(module(""))
    const deprecated = exportSurface(module(" @deprecated Import from `@spy4x/tasks`."))
    expect(deprecated).not.toBe(plain)
    expect(exportSurface(module(" @deprecated Import from `@spy4x/time`."))).not.toBe(deprecated)
  })

  it("reads a multi-line braced re-export in full", () => {
    const text = `export {\n  a,\n  b,\n} from "./x.ts"\n`
    expect(exportSurface(text)).toContain("b,")
  })
})

describe("generated files", () => {
  const root = fromFileUrl(import.meta.resolve("../../"))
  const fix = "Run `deno task llms` and commit llms.txt and llms-full.txt."

  it("llms.txt has a four-field line for every entry point and matches the export surface", async () => {
    const text = await Deno.readTextFile(`${root}/llms.txt`)
    const entries = await loadEntries(root)
    const lines = text.split("\n").filter((line) => line !== "" && !line.startsWith("#"))
    for (const line of lines) {
      if (line.split("\t").length !== 4) {
        throw new Error(`llms.txt: not four fields: ${line}. ${fix}`)
      }
    }
    const listed = new Set(lines.map((line) => line.split("\t")[2]))
    for (const entry of entries) {
      // An entry point that exports nothing (a command-line script) has no line.
      const source = await Deno.readTextFile(`${root}/${await resolveEntry(entry.specifier, root)}`)
      if (exportSurface(source) !== "" && !listed.has(entry.specifier)) {
        throw new Error(`llms.txt has no line for ${entry.specifier}. ${fix}`)
      }
    }
    expect(text.startsWith(`${HEADER.join("\n")}\n`)).toBe(true)
    const fingerprint = await surfaceFingerprint(root, entries)
    if (!text.endsWith(`\n${FINGERPRINT_PREFIX}${fingerprint}\n`)) {
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
