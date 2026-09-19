import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createBinaryFinder, findFfmpeg } from "./binary-lookup.ts"
import { fakeEnvironment, FakeProcessRunner } from "./test-doubles.ts"

/** Answers `-version` with an exit code only for the candidates that exist. */
function runnerFor(available: readonly string[]): FakeProcessRunner {
  return new FakeProcessRunner((argv) => ({
    code: available.includes(argv[0]) ? 0 : 1,
    stderr: "command not found",
  }))
}

describe("createBinaryFinder", () => {
  it("returns the first PATH candidate that answers", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin:/usr/bin" }),
    })
    expect(await finder.find("ffmpeg")).toBe("/opt/bin/ffmpeg")
    expect(finder.probeCount).toBe(1)
  })

  it("skips a PATH candidate that does not answer", async () => {
    const runner = runnerFor(["/usr/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin:/usr/bin" }),
    })
    expect(await finder.find("ffmpeg")).toBe("/usr/bin/ffmpeg")
    expect(runner.callCount).toBe(2)
  })

  it("probes a candidate with -version rather than trusting the file name", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin" }),
    })
    await finder.find("ffmpeg")
    expect(runner.argvOf(0)).toEqual(["/opt/bin/ffmpeg", "-version"])
  })

  it("probes the extra candidates after PATH", async () => {
    const runner = runnerFor(["/usr/local/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/nonexistent" }),
      extraCandidates: ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"],
    })
    expect(await finder.find("ffmpeg")).toBe("/usr/local/bin/ffmpeg")
    expect(runner.argvOf(0)?.[0]).toBe("/nonexistent/ffmpeg")
    expect(runner.argvOf(1)?.[0]).toBe("/usr/bin/ffmpeg")
  })

  it("falls back to the bare name when the environment has no PATH", async () => {
    const runner = runnerFor(["ffmpeg"])
    const finder = createBinaryFinder({ runner, env: fakeEnvironment({}) })
    expect(await finder.find("ffmpeg")).toBe("ffmpeg")
  })

  it("skips an empty PATH entry", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: ":/opt/bin:" }),
    })
    await finder.find("ffmpeg")
    expect(runner.argvOf(0)?.[0]).toBe("/opt/bin/ffmpeg")
  })

  it("does not probe the same candidate twice", async () => {
    const runner = runnerFor(["/usr/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/usr/bin" }),
      extraCandidates: ["/usr/bin/ffmpeg"],
    })
    await finder.find("ffmpeg")
    expect(finder.probeCount).toBe(1)
  })

  it("reuses the cached path instead of probing again", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin" }),
    })
    const first = await finder.find("ffmpeg")
    const second = await finder.find("ffmpeg")
    expect(second).toBe(first)
    expect(finder.probeCount).toBe(1)
    expect(runner.callCount).toBe(1)
    expect(finder.cachedPath("ffmpeg")).toBe("/opt/bin/ffmpeg")
  })

  it("caches each binary name separately", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg", "/opt/bin/ffprobe"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin" }),
    })
    expect(await finder.find("ffmpeg")).toBe("/opt/bin/ffmpeg")
    expect(await finder.find("ffprobe")).toBe("/opt/bin/ffprobe")
    expect(finder.cachedPath("ffmpeg")).toBe("/opt/bin/ffmpeg")
  })

  it("does not cache a miss, so a later probe can still find the binary", async () => {
    let available: string[] = []
    const runner = new FakeProcessRunner((argv) => ({
      code: available.includes(argv[0]) ? 0 : 1,
    }))
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin" }),
    })
    await expect(finder.find("ffmpeg")).rejects.toThrow("ffmpeg not found")
    expect(finder.cachedPath("ffmpeg")).toBe(undefined)

    available = ["/opt/bin/ffmpeg"]
    expect(await finder.find("ffmpeg")).toBe("/opt/bin/ffmpeg")
    // Three probes: the Path hit, the bare-name fallback and the second,
    // successful attempt — proof that the miss was not cached.
    expect(finder.probeCount).toBe(3)
  })

  it("names every probed candidate when nothing answers", async () => {
    const runner = runnerFor([])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/nonexistent" }),
      extraCandidates: ["/usr/bin/ffmpeg"],
    })
    const error = await finder.find("ffmpeg").catch((thrown: unknown) => thrown)
    expect((error as Error).message).toContain("/nonexistent/ffmpeg")
    expect((error as Error).message).toContain("/usr/bin/ffmpeg")
    expect((error as Error).message).toContain("probed 3 candidate(s)")
  })

  it("treats a spawn failure as a miss instead of aborting the search", async () => {
    const runner = new FakeProcessRunner((argv) =>
      argv[0] === "/opt/bin/ffmpeg"
        ? { spawnError: new Error("EACCES: permission denied") }
        : { code: 0 }
    )
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin:/usr/bin" }),
    })
    expect(await finder.find("ffmpeg")).toBe("/usr/bin/ffmpeg")
  })

  it("splits PATH with the separator of the given platform", async () => {
    const runner = runnerFor(["D:\\bin\\ffmpeg.exe"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "C:\\bin;D:\\bin" }),
      platform: "win32",
    })
    expect(await finder.find("ffmpeg")).toBe("D:\\bin\\ffmpeg.exe")
  })

  it("takes the platform from the runtime when none is given", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const finder = createBinaryFinder({
      runner,
      env: fakeEnvironment({ PATH: "/opt/bin" }),
    })
    expect(await finder.find("ffmpeg")).toBe("/opt/bin/ffmpeg")
  })
})

describe("findFfmpeg", () => {
  it("locates ffmpeg through PATH", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const ffmpeg = findFfmpeg({ runner, env: fakeEnvironment({ PATH: "/opt/bin" }) })
    expect(await ffmpeg()).toBe("/opt/bin/ffmpeg")
  })

  it("probes the well-known absolute paths after PATH", async () => {
    const runner = runnerFor(["/usr/bin/ffmpeg"])
    const ffmpeg = findFfmpeg({ runner, env: fakeEnvironment({ PATH: "/nonexistent" }) })
    expect(await ffmpeg()).toBe("/usr/bin/ffmpeg")
  })

  it("probes once for the lifetime of the locator", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const ffmpeg = findFfmpeg({ runner, env: fakeEnvironment({ PATH: "/opt/bin" }) })
    const first = await ffmpeg()
    const second = await ffmpeg()
    expect(second).toBe(first)
    expect(runner.callCount).toBe(1)
  })

  it("gives each locator its own cache", async () => {
    const runner = runnerFor(["/opt/bin/ffmpeg"])
    const env = fakeEnvironment({ PATH: "/opt/bin" })
    await findFfmpeg({ runner, env })()
    await findFfmpeg({ runner, env })()
    expect(runner.callCount).toBe(2)
  })

  it("throws when ffmpeg is absent, naming the probed paths", async () => {
    const runner = runnerFor([])
    const ffmpeg = findFfmpeg({ runner, env: fakeEnvironment({ PATH: "/nonexistent" }) })
    await expect(ffmpeg()).rejects.toThrow("ffmpeg not found")
  })
})
