// The `ObjectFs` contract, written once and run against both filesystems: `memory-fs.test.ts` runs it
// against `createMemoryObjectFs` in the unit tier, `local.integration.test.ts` against
// `createDenoObjectFs` on a real scratch folder. It is how the in-memory fake is shown to behave
// like real disk on every rule a caller's tests rely on.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeObjectFsContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { ObjectFs } from "./ports.ts"

/** A filesystem, the folder every test writes under, and how to dispose of both. */
export interface ObjectFsFixture {
  fs: ObjectFs
  /** An existing, empty folder. Paths are built as `${root}/…`. */
  root: string
  close(): Promise<void>
}

/** The error a promise rejects with, or a failure when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    (value) => ({ resolved: true, value }),
    (error: unknown) => ({ resolved: false, value: error }),
  )
  if (outcome.resolved) throw new Error(`expected a rejection, got ${String(outcome.value)}`)
  expect(outcome.value).toBeInstanceOf(Error)
  return outcome.value as Error
}

/** A stream that yields `chunks` one per read. */
function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close()
      else controller.enqueue(new Uint8Array(chunks[index++]))
    },
  })
}

/**
 * Registers the contract suite for one filesystem.
 *
 * @param label Names the filesystem in every test name.
 * @param open Returns a filesystem and a fresh, empty folder for each test.
 */
export function describeObjectFsContract(
  label: string,
  open: () => Promise<ObjectFsFixture>,
): void {
  async function withFs(body: (fixture: ObjectFsFixture) => Promise<void>): Promise<void> {
    const fixture = await open()
    try {
      await body(fixture)
    } finally {
      await fixture.close()
    }
  }

  describe(`${label}: writing and reading`, () => {
    it("reads back the exact bytes written, including 0 and 255", () =>
      withFs(async ({ fs, root }) => {
        const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
        expect(await fs.writeObject(`${root}/binary.bin`, bytes)).toBe(6)
        expect(await fs.readObject(`${root}/binary.bin`)).toEqual(bytes)
      }))

    it("creates every missing parent folder on write", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/a/b/c/deep.txt`, new Uint8Array([1]))
        expect(await fs.readObject(`${root}/a/b/c/deep.txt`)).toEqual(new Uint8Array([1]))
      }))

    it("replaces a longer object with a shorter one, leaving no old bytes behind", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/x.bin`, new Uint8Array([1, 2, 3, 4, 5]))
        await fs.writeObject(`${root}/x.bin`, new Uint8Array([9]))
        expect(await fs.readObject(`${root}/x.bin`)).toEqual(new Uint8Array([9]))
      }))

    it("writes an empty object that exists and reads back as zero bytes", () =>
      withFs(async ({ fs, root }) => {
        expect(await fs.writeObject(`${root}/empty`, new Uint8Array())).toBe(0)
        expect(await fs.existsObject(`${root}/empty`)).toBe(true)
        expect(await fs.readObject(`${root}/empty`)).toEqual(new Uint8Array())
      }))

    it("returns the byte count of a streamed write and stores the chunks joined", () =>
      withFs(async ({ fs, root }) => {
        const written = await fs.writeObject(`${root}/s.bin`, streamOf([[1, 2], [], [3, 4, 5]]))
        expect(written).toBe(5)
        expect(await fs.readObject(`${root}/s.bin`)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      }))

    it("keeps the stored bytes when the caller changes its buffer after the write", () =>
      withFs(async ({ fs, root }) => {
        const bytes = new Uint8Array([1, 2, 3])
        await fs.writeObject(`${root}/x.bin`, bytes)
        bytes[0] = 99
        expect(await fs.readObject(`${root}/x.bin`)).toEqual(new Uint8Array([1, 2, 3]))
      }))

    it("hands out a copy, so changing what was read leaves the object as it was", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/x.bin`, new Uint8Array([1, 2, 3]))
        const read = await fs.readObject(`${root}/x.bin`)
        read[0] = 99
        expect(await fs.readObject(`${root}/x.bin`)).toEqual(new Uint8Array([1, 2, 3]))
      }))

    it("rejects a stream that fails midway, keeping only the bytes it delivered", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/x.bin`, new Uint8Array([1, 2, 3, 4, 5]))
        let reads = 0
        const failing = new ReadableStream<Uint8Array>({
          pull(controller) {
            reads += 1
            if (reads === 1) controller.enqueue(new Uint8Array([9, 9]))
            else throw new Error("source broke")
          },
        })
        expect((await rejection(fs.writeObject(`${root}/x.bin`, failing))).message).toBe(
          "source broke",
        )
        expect(await fs.readObject(`${root}/x.bin`)).toEqual(new Uint8Array([9, 9]))
      }))

    it("treats a doubled slash and a `.` segment as the plain path", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/a//./b.txt`, new Uint8Array([7]))
        expect(await fs.readObject(`${root}/a/b.txt`)).toEqual(new Uint8Array([7]))
        expect(await fs.existsObject(`${root}/./a/b.txt`)).toBe(true)
      }))
  })

  describe(`${label}: missing objects and folders`, () => {
    it("rejects reading a missing object with NotFound", () =>
      withFs(async ({ fs, root }) => {
        const error = await rejection(fs.readObject(`${root}/missing.txt`))
        expect(error).toBeInstanceOf(Deno.errors.NotFound)
      }))

    it("answers false for a missing object beside a present one and below a missing folder", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/present.txt`, new Uint8Array([1]))
        expect(await fs.existsObject(`${root}/missing.txt`)).toBe(false)
        expect(await fs.existsObject(`${root}/nowhere/missing.txt`)).toBe(false)
      }))

    it("answers true for a folder that holds an object", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/dir/file.txt`, new Uint8Array([1]))
        expect(await fs.existsObject(`${root}/dir`)).toBe(true)
        expect(await fs.existsObject(`${root}/dir/`)).toBe(true)
      }))

    it("rejects reading a folder with IsADirectory", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/dir/file.txt`, new Uint8Array([1]))
        const error = await rejection(fs.readObject(`${root}/dir`))
        expect(error).toBeInstanceOf(Deno.errors.IsADirectory)
      }))

    it("rejects writing over a folder with IsADirectory and keeps what it holds", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/dir/file.txt`, new Uint8Array([1]))
        const error = await rejection(fs.writeObject(`${root}/dir`, new Uint8Array([2])))
        expect(error).toBeInstanceOf(Deno.errors.IsADirectory)
        expect(await fs.readObject(`${root}/dir/file.txt`)).toEqual(new Uint8Array([1]))
      }))

    it("rejects every call on a path below an object with NotADirectory", () =>
      withFs(async ({ fs, root }) => {
        await fs.writeObject(`${root}/file.txt`, new Uint8Array([1]))
        const below = `${root}/file.txt/inner`
        const calls = [
          () => fs.writeObject(below, new Uint8Array([2])),
          () => fs.readObject(below),
          () => fs.existsObject(below),
        ]
        for (const call of calls) {
          expect(await rejection(call())).toBeInstanceOf(Deno.errors.NotADirectory)
        }
        expect(await fs.readObject(`${root}/file.txt`)).toEqual(new Uint8Array([1]))
      }))
  })
}
