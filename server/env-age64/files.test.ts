import { assertEquals, assertThrows } from "@std/assert"
import { classifyFileEntry } from "./files.ts"

// A real named pipe (`mkfifo`) can't be created in either test tier — the unit tier has no write
// permission at all, and the integration tier's `--allow-write=.volumes` grant covers no
// `--allow-run` to shell out to `mkfifo`, nor is there a Deno API to create one directly. This
// pure function is what lets the "never hangs on a non-regular file" behaviour be tested at all:
// a fake `Deno.DirEntry`-shaped object stands in for the pipe.

function fakeEntry(name: string, shape: { isFile: boolean; isSymlink: boolean }) {
  return { name, ...shape }
}

Deno.test("classifyFileEntry: skips a name the caller's filter doesn't match", () => {
  const entry = fakeEntry("README.md", { isFile: true, isSymlink: false })
  assertEquals(classifyFileEntry(entry, () => false), "skip")
})

Deno.test("classifyFileEntry: collects a regular file the filter matches", () => {
  const entry = fakeEntry(".env", { isFile: true, isSymlink: false })
  assertEquals(classifyFileEntry(entry, () => true), "collect")
})

Deno.test("classifyFileEntry: throws for a symlink the filter matches, before ever opening it", () => {
  const entry = fakeEntry(".env", { isFile: false, isSymlink: true })
  assertThrows(() => classifyFileEntry(entry, () => true), Error, "symlink")
})

Deno.test("classifyFileEntry: skips a matching name that is neither a symlink nor a regular file", () => {
  // Stands in for a named pipe, a socket, or a device node: `Deno.DirEntry.isFile` is false for
  // all of them, same as this fake. Opening a FIFO with nothing writing to it blocks forever —
  // this must be skipped silently, never collected, never thrown.
  const entry = fakeEntry(".env.local", { isFile: false, isSymlink: false })
  assertEquals(classifyFileEntry(entry, () => true), "skip")
})
