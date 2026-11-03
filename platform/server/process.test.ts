import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import {
  argsOf,
  envReaderOver,
  exitOver,
  type NodeStdin,
  processIdOf,
  type RuntimeHost,
  signalListenersOver,
  standardInputOver,
  workingDirectoryOf,
  writeStderrOver,
} from "./_runtime-host.ts"
import {
  processArgs,
  processEnv,
  processId,
  processStdin,
  readEnvRecord,
  writeStderr,
} from "./process.ts"

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

describe("workingDirectoryOf", () => {
  it("asks Deno.cwd on Deno, even where process is defined too, and process.cwd on Node and Bun", () => {
    const deno: RuntimeHost = { Deno: { cwd: () => "/from-deno" }, process: { cwd: () => "/node" } }
    expect(workingDirectoryOf(deno)).toBe("/from-deno")
    expect(workingDirectoryOf({ process: { cwd: () => "/from-node" } })).toBe("/from-node")
  })

  it("throws on a runtime with neither, instead of resolving against an empty directory", () => {
    expect(() => workingDirectoryOf({})).toThrow("no working directory")
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

describe("argsOf", () => {
  it("takes Deno.args on Deno and process.argv after the runtime and script on Node and Bun", () => {
    expect(argsOf({ Deno: { args: ["a", "b"] }, process: { argv: ["node", "x.js", "c"] } }))
      .toEqual(["a", "b"])
    expect(argsOf({ process: { argv: ["/usr/bin/node", "/app/x.js", "c", "d"] } }))
      .toEqual(["c", "d"])
  })

  it("returns a copy, so a caller's change never reaches the process", () => {
    const host: RuntimeHost = { Deno: { args: ["a"] } }
    argsOf(host).push("b")
    expect(host.Deno!.args).toEqual(["a"])
  })

  it("throws on a runtime with neither", () => {
    expect(() => argsOf({})).toThrow("no arguments")
  })
})

describe("exitOver", () => {
  /** A host whose exit records the code instead of ending the test run. */
  const exiting = (side: "Deno" | "process") => {
    const codes: number[] = []
    const exit = (code: number): never => {
      codes.push(code)
      throw new Error("exited")
    }
    return { host: { [side]: { exit } } as RuntimeHost, codes }
  }

  it("exits through Deno.exit on Deno and process.exit on Node and Bun, with the code", () => {
    for (const side of ["Deno", "process"] as const) {
      const { host, codes } = exiting(side)
      expect(() => exitOver(host, 2)).toThrow("exited")
      expect(codes).toEqual([2])
    }
  })

  it("throws on a runtime that cannot exit, so the caller does not carry on", () => {
    expect(() => exitOver({}, 1)).toThrow("cannot exit")
  })
})

describe("writeStderrOver", () => {
  it("writes every byte on Deno, even when one writeSync takes only part of them", () => {
    const written: number[] = []
    const host: RuntimeHost = {
      Deno: {
        stderr: {
          writeSync(data) {
            const part = data.subarray(0, 2)
            written.push(...part)
            return part.byteLength
          },
        },
      },
    }
    writeStderrOver(host, "Password: ü")
    expect(new TextDecoder().decode(new Uint8Array(written))).toBe("Password: ü")
  })

  it("writes the text through process.stderr on Node and Bun, with no line break added", () => {
    const written: string[] = []
    writeStderrOver({ process: { stderr: { write: (text) => written.push(text) } } }, "Password: ")
    expect(written).toEqual(["Password: "])
  })

  it("throws instead of looping forever when Deno's standard error takes no bytes", () => {
    let calls = 0
    // A second call is the loop the guard prevents; failing then keeps this test from hanging.
    const writeSync = () => {
      if (++calls > 1) throw new Error("writeSync called again after it took no bytes")
      return 0
    }
    expect(() => writeStderrOver({ Deno: { stderr: { writeSync } } }, "x")).toThrow(
      "accepted no bytes",
    )
  })

  it("throws on a runtime with no standard error", () => {
    expect(() => writeStderrOver({}, "x")).toThrow("no standard error")
  })
})

/**
 * A paused Node stdin that emits `chunks`, one per `data` event, while it flows, or `fail` as an
 * `error` event once it is asked to flow. Like Node, it emits `end` on a later tick once the last
 * chunk is out, whether it flows then or not.
 */
function fakeNodeStdin(
  chunks: (string | Uint8Array)[],
  { isTTY = false, fail }: { isTTY?: boolean; fail?: Error } = {},
) {
  const listeners = {
    data: new Set<(chunk: string | Uint8Array) => void>(),
    end: new Set<() => void>(),
    error: new Set<(error: Error) => void>(),
  }
  const raw: boolean[] = []
  let flowing = false
  // Node's `ref` and `unref`: whether the stream keeps the process alive, and how often it was
  // resumed while it could not.
  let referenced = true
  let unreferencedResumes = 0
  let endScheduled = false
  const scheduleEnd = () => {
    if (endScheduled) return
    endScheduled = true
    setTimeout(() => {
      for (const listener of [...listeners.end]) listener()
    }, 0)
  }
  const pump = () =>
    queueMicrotask(() => {
      if (fail) {
        for (const listener of [...listeners.error]) listener(fail)
        return
      }
      while (flowing && chunks.length > 0) {
        const chunk = chunks.shift()!
        for (const listener of [...listeners.data]) listener(chunk)
      }
      if (chunks.length === 0) scheduleEnd()
    })
  const stdin: NodeStdin & {
    readonly flowing: boolean
    readonly referenced: boolean
    readonly unreferencedResumes: number
    raw: boolean[]
  } = {
    isTTY,
    raw,
    get flowing() {
      return flowing
    },
    get referenced() {
      return referenced
    },
    get unreferencedResumes() {
      return unreferencedResumes
    },
    ref: () => referenced = true,
    unref: () => referenced = false,
    setRawMode: (on: boolean) => raw.push(on),
    on: (event: "data" | "end" | "error", listener: never) => listeners[event].add(listener),
    off: (event: string, listener: never) => listeners[event as "data"].delete(listener),
    pause: () => flowing = false,
    resume: () => {
      if (!referenced) unreferencedResumes++
      flowing = true
      pump()
    },
  }
  return stdin
}

describe("standardInputOver on Node and Bun", () => {
  it("reads one chunk at a time, keeps what did not fit for the next read, and pauses and unrefs stdin between reads", async () => {
    const stdin = fakeNodeStdin(["hello", new TextEncoder().encode("!")])
    const input = standardInputOver(() => ({ process: { stdin } }))
    const buffer = new Uint8Array(3)
    const reads: (string | null)[] = []
    for (let count = await input.read(buffer); count !== null; count = await input.read(buffer)) {
      reads.push(new TextDecoder().decode(buffer.subarray(0, count)))
      expect(stdin.flowing).toBe(false)
      expect(stdin.referenced).toBe(false)
    }
    expect(reads).toEqual(["hel", "lo", "!"])
    expect(stdin.unreferencedResumes).toBe(0)
    expect(await input.read(buffer)).toBeNull()
  })

  it("returns null at the end of a pipe that ended while paused between reads", async () => {
    const stdin = fakeNodeStdin(["ab", "c"])
    const input = standardInputOver(() => ({ process: { stdin } }))
    const buffer = new Uint8Array(2)
    const reads: (number | null)[] = []
    for (let step = 0; step < 3; step++) {
      reads.push(await input.read(buffer))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(reads).toEqual([2, 1, null])
  })

  it("hands each chunk to one read when two reads overlap", async () => {
    const stdin = fakeNodeStdin(["ab", "cd"])
    const input = standardInputOver(() => ({ process: { stdin } }))
    const first = new Uint8Array(2)
    const second = new Uint8Array(2)
    expect(await Promise.all([input.read(first), input.read(second)])).toEqual([2, 2])
    expect(new TextDecoder().decode(first) + new TextDecoder().decode(second)).toBe("abcd")
    expect(await input.read(first)).toBeNull()
  })

  it("reads everything piped in as text", async () => {
    const stdin = fakeNodeStdin(["first line\n", new TextEncoder().encode("ü second")])
    expect(await standardInputOver(() => ({ process: { stdin } })).text()).toBe(
      "first line\nü second",
    )
  })

  it("reports a terminal and switches its raw mode, and refuses raw mode on a pipe", () => {
    const tty = fakeNodeStdin([], { isTTY: true })
    const input = standardInputOver(() => ({ process: { stdin: tty } }))
    expect(input.isTerminal()).toBe(true)
    input.setRaw(true)
    input.setRaw(false)
    expect(tty.raw).toEqual([true, false])

    const pipe = { ...fakeNodeStdin([]), setRawMode: undefined }
    const piped = standardInputOver(() => ({ process: { stdin: pipe } }))
    expect(piped.isTerminal()).toBe(false)
    expect(() => piped.setRaw(true)).toThrow("not a terminal")
  })

  it("rejects a read when the stream fails", async () => {
    const stdin = fakeNodeStdin([], { fail: new Error("EIO") })
    await expect(standardInputOver(() => ({ process: { stdin } })).read(new Uint8Array(1)))
      .rejects.toThrow("EIO")
  })
})

describe("standardInputOver on Deno", () => {
  it("hands every call to Deno.stdin, even where process is defined too", async () => {
    const calls: string[] = []
    const host: RuntimeHost = {
      Deno: {
        stdin: {
          isTerminal: () => true,
          setRaw: (raw) => void calls.push(`raw:${raw}`),
          read: (buffer) => {
            buffer.set([65])
            return Promise.resolve(1)
          },
          readable: ReadableStream.from([new TextEncoder().encode("piped")]),
        },
      },
      process: { stdin: fakeNodeStdin(["from node"]) },
    }
    const input = standardInputOver(() => host)
    expect(input.isTerminal()).toBe(true)
    input.setRaw(true)
    const buffer = new Uint8Array(4)
    expect(await input.read(buffer)).toBe(1)
    expect(buffer[0]).toBe(65)
    expect(await input.text()).toBe("piped")
    expect(calls).toEqual(["raw:true"])
  })

  it("throws on a runtime with no standard input", () => {
    expect(() => standardInputOver(() => ({})).isTerminal()).toThrow("no standard input")
  })
})

describe("processArgs, processStdin and writeStderr", () => {
  // `deno test` passes no arguments, so this shows the calls run here, not which host they read:
  // the host branches are the cases above.
  it("run on this Deno process without throwing", () => {
    expect(processArgs()).toEqual(Deno.args)
    expect(processStdin.isTerminal()).toBe(Deno.stdin.isTerminal())
    writeStderr("")
  })
})

describe("signalListenersOver", () => {
  const recorder = () => {
    const calls: string[] = []
    const record = (name: string) => (signal: string) => void calls.push(`${name} ${signal}`)
    return { calls, record }
  }

  it("uses Deno's signal listeners on Deno, even where process is defined too", () => {
    const { calls, record } = recorder()
    const signals = signalListenersOver({
      Deno: { addSignalListener: record("deno-add"), removeSignalListener: record("deno-remove") },
      process: { on: record("on"), off: record("off") },
    })
    signals.add("SIGTERM", () => {})
    signals.remove("SIGTERM", () => {})
    expect(calls).toEqual(["deno-add SIGTERM", "deno-remove SIGTERM"])
  })

  it("uses process.on and process.off on Node and Bun", () => {
    const { calls, record } = recorder()
    const signals = signalListenersOver({ process: { on: record("on"), off: record("off") } })
    signals.add("SIGINT", () => {})
    signals.remove("SIGINT", () => {})
    expect(calls).toEqual(["on SIGINT", "off SIGINT"])
  })

  it("throws on a runtime with neither", () => {
    expect(() => signalListenersOver({})).toThrow("no signals")
  })
})
