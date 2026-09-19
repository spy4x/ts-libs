import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  sizeDeltaBounds,
  tempSiblingPath,
  verdictSizeDelta,
  withAtomicRewrite,
} from "./atomic-rewrite.ts"
import { FakeFileSystem } from "./test-doubles.ts"

const encoder = new TextEncoder()

describe("tempSiblingPath", () => {
  it("places the working copy beside its target, so the rename stays on one filesystem", () => {
    expect(tempSiblingPath("/music/album/track.mp3", "abc")).toBe("/music/album/track.mp3.abc.tmp")
  })

  it("works for a relative path", () => {
    expect(tempSiblingPath("track.mp3", "abc")).toBe("track.mp3.abc.tmp")
  })

  it("rejects a token that would escape the target's directory", () => {
    expect(() => tempSiblingPath("/music/track.mp3", "../../etc/passwd")).toThrow(TypeError)
  })

  it("rejects a token containing a separator", () => {
    expect(() => tempSiblingPath("/music/track.mp3", "a/b")).toThrow(TypeError)
    expect(() => tempSiblingPath("/music/track.mp3", "a\\b")).toThrow(TypeError)
  })

  it("rejects an empty token", () => {
    expect(() => tempSiblingPath("/music/track.mp3", "")).toThrow(TypeError)
  })

  it("rejects the directory-walk tokens", () => {
    expect(() => tempSiblingPath("/music/track.mp3", ".")).toThrow(TypeError)
    expect(() => tempSiblingPath("/music/track.mp3", "..")).toThrow(TypeError)
  })
})

describe("withAtomicRewrite", () => {
  const target = "/music/track.mp3"
  const options = { path: target, tempToken: () => "fixed" }
  const tempPath = `${target}.fixed.tmp`

  it("renames the mutated content over the target", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.ok).toBe(true)
    expect(fs.textOf(target)).toBe("new bytes")
    expect(await fs.exists(tempPath)).toBe(false)
  })

  it("reports the size of the rewritten file", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("newer bytes"),
    })
    expect(result.size).toBe(11)
  })

  it("hands the working copy's path to the mutator", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    let seen = ""
    await withAtomicRewrite(fs, {
      ...options,
      mutate: (candidate) => {
        seen = candidate
        return encoder.encode("new bytes")
      },
    })
    expect(seen).toBe(tempPath)
  })

  it("keeps the original untouched when verification rejects the candidate", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("truncated"),
      verify: () => Promise.resolve({ ok: false, error: "verification: duration changed" }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("verification: duration changed")
    expect(fs.textOf(target)).toBe("old bytes")
    expect(fs.files.has(tempPath)).toBe(false)
  })

  it("reports a verification failure that carries no message", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("new"),
      verify: () => Promise.resolve({ ok: false }),
    })
    expect(result.error).toBe("verification failed")
  })

  it("passes the candidate path and bytes to the verifier", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    let verifiedPath = ""
    let verifiedSize = 0
    await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("new bytes"),
      verify: (candidate, bytes) => {
        verifiedPath = candidate
        verifiedSize = bytes.length
        return Promise.resolve({ ok: true })
      },
    })
    expect(verifiedPath).toBe(tempPath)
    expect(verifiedSize).toBe(9)
  })

  it("removes the working copy and keeps the original when the mutator throws", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => {
        throw new Error("node-id3 write failed")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("node-id3 write failed")
    expect(fs.textOf(target)).toBe("old bytes")
    expect(fs.files.has(tempPath)).toBe(false)
  })

  it("removes the working copy and keeps the original when the rename fails", async () => {
    const failures = new Map([[`rename:${tempPath}`, new Error("EXDEV: cross-device link")]])
    const fs = new FakeFileSystem({ [target]: "old bytes" }, failures)
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("EXDEV")
    expect(fs.textOf(target)).toBe("old bytes")
    expect(fs.files.has(tempPath)).toBe(false)
  })

  it("reports a failure to copy the original without leaving a partial rewrite", async () => {
    const fs = new FakeFileSystem({}, new Map([[`copyFile:${target}`, new Error("ENOENT")]]))
    const result = await withAtomicRewrite(fs, {
      ...options,
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("copy failed: ENOENT")
    expect(fs.files.has(tempPath)).toBe(false)
  })

  it("keeps a backup of the original when asked", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      keepBackup: true,
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.backupPath).toBe(`${target}.bak`)
    expect(fs.textOf(`${target}.bak`)).toBe("old bytes")
    expect(fs.textOf(target)).toBe("new bytes")
  })

  it("keeps the existing backup rather than overwriting it", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes", [`${target}.bak`]: "first backup" })
    const result = await withAtomicRewrite(fs, {
      ...options,
      keepBackup: true,
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.backupPath).toBe(undefined)
    expect(fs.textOf(`${target}.bak`)).toBe("first backup")
  })

  it("writes no backup unless asked", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    await withAtomicRewrite(fs, { ...options, mutate: () => encoder.encode("new bytes") })
    expect(fs.files.has(`${target}.bak`)).toBe(false)
  })

  it("returns a failure instead of throwing when the token is unusable", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    const result = await withAtomicRewrite(fs, {
      path: target,
      tempToken: () => "../escape",
      mutate: () => encoder.encode("new bytes"),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("plain name fragment")
    expect(fs.textOf(target)).toBe("old bytes")
  })

  it("writes the mutated bytes under the working copy before the rename", async () => {
    const fs = new FakeFileSystem({ [target]: "old bytes" })
    await withAtomicRewrite(fs, { ...options, mutate: () => encoder.encode("new bytes") })
    expect(fs.ops).toEqual([
      `copyFile:${target}`,
      `writeFile:${tempPath}`,
      `rename:${tempPath}`,
      `size:${target}`,
    ])
  })
})

describe("verdictSizeDelta", () => {
  const original = 8 * 1024 * 1024

  it("accepts a small change", () => {
    expect(verdictSizeDelta(original, original + 1024).ok).toBe(true)
    expect(verdictSizeDelta(original, original - 1024).ok).toBe(true)
  })

  it("accepts an unchanged size", () => {
    expect(verdictSizeDelta(original, original).ok).toBe(true)
  })

  it("rejects a loss beyond the allowed range", () => {
    const verdict = verdictSizeDelta(original, Math.floor(original / 2))
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toContain("size delta")
  })

  it("rejects a gain beyond the allowed range", () => {
    expect(verdictSizeDelta(original, original + 4 * 1024 * 1024).ok).toBe(false)
  })

  it("allows a cover image's worth of growth in the extra megabyte of headroom", () => {
    expect(verdictSizeDelta(original, original + 900 * 1024).ok).toBe(true)
  })

  it("gives a small file the same absolute floor as a large one", () => {
    expect(sizeDeltaBounds(1024)).toEqual({
      maxLossBytes: 64 * 1024,
      maxGainBytes: 64 * 1024 + 1024 * 1024,
    })
    expect(verdictSizeDelta(1024, 1024 + 32 * 1024).ok).toBe(true)
  })
})
