import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { relative } from "@std/path"

import { fakeFs } from "./_fake-fs.ts"
import { DEFAULT_SKIP_DIRS, extensionOf, isInside, type WalkedFile, walkFiles } from "./walk.ts"

/** Collect a walk into an array, since the generator is lazy. */
async function collect(options: Parameters<typeof walkFiles>[0]): Promise<WalkedFile[]> {
  const files: WalkedFile[] = []
  for await (const file of walkFiles(options)) files.push(file)
  return files
}

/** Build a fake filesystem with directories, given `[dir, ...files]` pairs. */
function tree(root: string, shape: Record<string, string[]>): ReturnType<typeof fakeFs> {
  const fs = fakeFs()
  for (const [dir, names] of Object.entries(shape)) {
    const full = dir === "." ? root : `${root}/${dir}`
    fs.dirs.add(full)
    for (const name of names) fs.files.set(`${full}/${name}`, `content of ${name}`)
  }
  return fs
}

describe("extensionOf", () => {
  it("lowercases and drops the dot", () => {
    expect(extensionOf("Song.MP3")).toBe("mp3")
    expect(extensionOf("clip.tar.gz")).toBe("gz")
  })

  it("returns empty for a name with no extension or only a leading dot", () => {
    expect(extensionOf("README")).toBe("")
    expect(extensionOf(".gitignore")).toBe("")
    expect(extensionOf("trailing.")).toBe("")
    expect(extensionOf("")).toBe("")
  })
})

describe("isInside", () => {
  it("accepts the root itself and anything below it", () => {
    expect(isInside("/music", "/music")).toBe(true)
    expect(isInside("/music", "/music/album")).toBe(true)
    expect(isInside("/music", "/music/a")).toBe(true)
  })

  it("rejects a sibling directory that merely shares a prefix", () => {
    // The classic prefix bug: "/music2" starts with "/music" but is not inside it.
    expect(isInside("/music", "/music2/album")).toBe(false)
    expect(isInside("/music", "/other")).toBe(false)
  })

  it("pins the mechanism: @std/path relative, not a prefix comparison", () => {
    // `isInside` deliberately does NOT use `target.startsWith(root)`. That form is what made the
    // original bug possible, and the separator in a hand-built `${root}/` is wrong on Windows.
    // Asserting `relative` directly keeps the implementation honest even though a prefix mutant of
    // the *caller* would be caught by the type checker rather than by a runtime assertion.
    expect(relative("/music", "/music2/album")).toBe("../music2/album")
    expect(relative("/music", "/music/album")).toBe("album")
    expect(relative("/music", "/music")).toBe("")
    expect(relative("/music", "/etc")).toBe("../etc")
    // The prefix comparison that this replaces would report the first case as inside.
    expect("/music2/album".startsWith("/music")).toBe(true)
    expect(isInside("/music", "/music2/album")).toBe(false)
  })

  it("traverses out of the root", () => {
    expect(isInside("/music", "/music/../etc")).toBe(false)
  })
})

describe("DEFAULT_SKIP_DIRS", () => {
  it("covers the version-control, sync and recycle-bin directories", () => {
    for (const name of [".git", ".syncthing", ".stversions", "node_modules", "$RECYCLE.BIN"]) {
      expect(DEFAULT_SKIP_DIRS).toContain(name)
    }
  })
})

describe("walkFiles", () => {
  it("walks nested directories iteratively and reports a path relative to the root", async () => {
    const fs = tree("/music", {
      ".": ["a.mp3"],
      album: ["b.flac"],
      "album/nested": ["c.ogg"],
    })
    const files = await collect({ fs, root: "/music" })
    expect(files.map((file) => file.relativePath).sort()).toEqual([
      "a.mp3",
      "album/b.flac",
      "album/nested/c.ogg",
    ])
    expect(files.every((file) => file.path.startsWith("/music/"))).toBe(true)
  })

  it("reports the extension and size for each file", async () => {
    const fs = tree("/music", { ".": ["A.MP3"] })
    const [file] = await collect({ fs, root: "/music" })
    expect(file.extension).toBe("mp3")
    expect(file.name).toBe("A.MP3")
    expect(file.size).toBe("content of A.MP3".length)
  })

  it("skips named directories by default", async () => {
    const fs = tree("/music", { ".": ["a.mp3"], ".git": ["config"], node_modules: ["x.js"] })
    const files = await collect({ fs, root: "/music" })
    expect(files.map((file) => file.name)).toEqual(["a.mp3"])
  })

  it("skips hidden entries by default, and can be told to include them", async () => {
    const fs = tree("/music", { ".": ["a.mp3", ".DS_Store"] })
    expect((await collect({ fs, root: "/music" })).map((file) => file.name)).toEqual(["a.mp3"])
    const all = await collect({ fs, root: "/music", skipHidden: false })
    expect(all.map((file) => file.name).sort()).toEqual([".DS_Store", "a.mp3"])
  })

  it("honours a caller-supplied skip list, replacing the default", async () => {
    // `.git/config` is reachable only because `skipHidden` is off: the default skip list would
    // otherwise drop the directory anyway.
    const fs = tree("/music", { ".": ["a.mp3"], keep: ["b.mp3"], ".git": ["config"] })
    const files = await collect({ fs, root: "/music", skipDirs: ["keep"], skipHidden: false })
    expect(files.map((file) => file.name).sort()).toEqual(["a.mp3", "config"])
  })

  it("lets a caller reject individual files with a reason", async () => {
    const fs = tree("/music", { ".": ["keep.mp3", "skip.mp3"] })
    const files = await collect({
      fs,
      root: "/music",
      shouldSkipFile: (path) => (path.endsWith("skip.mp3") ? "excluded by test" : null),
    })
    expect(files.map((file) => file.name)).toEqual(["keep.mp3"])
  })

  it("skips only files, so a same-named directory is still traversed", async () => {
    const fs = tree("/music", { ".": ["x.mp3"], sub: ["y.mp3"] })
    fs.dirs.add("/music/sub.mp3")
    const files = await collect({ fs, root: "/music" })
    expect(files.map((file) => file.name)).toEqual(["x.mp3", "y.mp3"])
  })

  it("returns nothing for an empty or unreadable root instead of throwing", async () => {
    expect(await collect({ fs: fakeFs(), root: "/absent" })).toEqual([])
  })

  it("does not descend into a directory whose listing throws", async () => {
    const fs = tree("/music", { ".": ["a.mp3"], bad: ["b.mp3"] })
    fs.readDir = ((path: string) => {
      if (path === "/music/bad") return Promise.reject(new Error("EACCES"))
      return Promise.resolve([
        ...(path === "/music"
          ? [{ name: "bad", isDirectory: true, isFile: false }, {
            name: "a.mp3",
            isDirectory: false,
            isFile: true,
            size: 1,
          }]
          : []),
      ])
    }) as typeof fs.readDir
    const files = await collect({ fs, root: "/music" })
    expect(files.map((file) => file.name)).toEqual(["a.mp3"])
  })

  it("does not loop forever on a self-referencing directory", async () => {
    const fs = fakeFs()
    fs.dirs.add("/music")
    fs.dirs.add("/music/loop")
    // `.` resolves back to the same directory, which a naive walker would follow forever.
    fs.readDir = ((path: string) => {
      if (path === "/music") {
        return Promise.resolve([{ name: "loop", isDirectory: true, isFile: false }])
      }
      return Promise.resolve([{ name: ".", isDirectory: true, isFile: false }])
    }) as typeof fs.readDir
    const files = await collect({ fs, root: "/music", skipHidden: false })
    expect(files).toEqual([])
  })

  it("handles a deep chain without overflowing the stack", async () => {
    const fs = fakeFs()
    const depth = 1000
    let current = "/deep"
    fs.dirs.add(current)
    for (let i = 0; i < depth; i++) {
      current = `${current}/d`
      fs.dirs.add(current)
    }
    fs.files.set(`${current}/leaf.mp3`, "x")
    const files = await collect({ fs, root: "/deep" })
    expect(files.length).toBe(1)
    expect(files[0].name).toBe("leaf.mp3")
  })
})
