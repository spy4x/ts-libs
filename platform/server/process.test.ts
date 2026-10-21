import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { envReaderOver, processIdOf, type RuntimeHost } from "./_runtime-host.ts"
import { processEnv, processId, readEnvRecord } from "./process.ts"

const denoHost: RuntimeHost = {
  Deno: { env: { get: (name) => ({ A: "from-deno", BLANK: "" })[name] }, pid: 11 },
  process: { env: { A: "from-process" }, pid: 22 },
}
const nodeHost: RuntimeHost = { process: { env: { A: "from-process", BLANK: "" }, pid: 22 } }

describe("envReaderOver", () => {
  it("reads Deno.env on Deno, even where process is defined too", () => {
    expect(envReaderOver(() => denoHost).get("A")).toBe("from-deno")
  })

  it("reads process.env on Node and Bun", () => {
    expect(envReaderOver(() => nodeHost).get("A")).toBe("from-process")
  })

  it("reports a blank or unset variable as undefined on every runtime", () => {
    for (const host of [denoHost, nodeHost]) {
      const env = envReaderOver(() => host)
      expect(env.get("BLANK")).toBeUndefined()
      expect(env.get("UNSET")).toBeUndefined()
    }
  })

  it("throws on a runtime with no process environment instead of reporting every name unset", () => {
    expect(() => envReaderOver(() => ({})).get("A")).toThrow("no environment")
  })
})

describe("processIdOf", () => {
  it("prefers Deno.pid, falls back to process.pid, and is undefined without either", () => {
    expect(processIdOf(denoHost)).toBe(11)
    expect(processIdOf(nodeHost)).toBe(22)
    expect(processIdOf({})).toBeUndefined()
  })
})

describe("processEnv and processId", () => {
  it("read this process's environment and id", () => {
    expect(processEnv.get("PATH")).toBe(Deno.env.get("PATH") || undefined)
    expect(processId()).toBe(Deno.pid)
  })
})

describe("readEnvRecord", () => {
  it("reads only the names asked for, an unset one as undefined", () => {
    const asked: string[] = []
    const env = {
      get: (name: string) => {
        asked.push(name)
        return name === "A" ? "a" : undefined
      },
    }
    expect(readEnvRecord(["A", "B"], env)).toEqual({ A: "a", B: undefined })
    expect(asked).toEqual(["A", "B"])
  })
})
