import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { fakeFs } from "./_fake-fs.ts"
import { FileLock, LockState, LockUnavailableError } from "./file-lock.ts"

describe("FileLock", () => {
  it("reports free before acquiring and owned afterwards", async () => {
    const lock = new FileLock({ fs: fakeFs(), path: "/dir/job.lock" })
    expect(lock.state).toBe(LockState.Free)
    await lock.acquire()
    expect(lock.state).toBe(LockState.Owned)
    await lock.release()
    expect(lock.state).toBe(LockState.Free)
  })

  it("creates the parent directory before taking the lock", async () => {
    const fs = fakeFs()
    await new FileLock({ fs, path: "/deep/nested/job.lock" }).acquire()
    expect(fs.dirs.has("/deep/nested")).toBe(true)
  })

  it("throws a diagnosable error naming the contended path", async () => {
    const fs = fakeFs()
    await new FileLock({ fs, path: "/dir/job.lock" }).acquire()
    const error = await new FileLock({ fs, path: "/dir/job.lock" }).acquire().catch((e) => e)
    expect(error).toBeInstanceOf(LockUnavailableError)
    expect((error as LockUnavailableError).path).toBe("/dir/job.lock")
    expect((error as Error).message).toContain("another instance is running for /dir/job.lock")
  })

  it("reports contention through tryAcquire instead of throwing", async () => {
    const fs = fakeFs()
    await new FileLock({ fs, path: "/l" }).acquire()
    expect(await new FileLock({ fs, path: "/l" }).tryAcquire()).toBe(false)
    expect(await new FileLock({ fs, path: "/other" }).tryAcquire()).toBe(true)
  })

  it("is idempotent, so a double release cannot free another holder's lock", async () => {
    const fs = fakeFs()
    const first = new FileLock({ fs, path: "/l" })
    await first.acquire()
    const second = new FileLock({ fs, path: "/l" })
    // Steal by releasing the first twice: the second acquire must still work only after a real release.
    await first.release()
    await first.release()
    await expect(second.acquire()).resolves.toBeUndefined()
  })

  it("does not re-acquire when already held", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    await lock.acquire()
    await lock.acquire()
    expect(fs.calls.filter((call) => call.op === "lock").length).toBe(1)
  })

  it("releases even when the critical section throws", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    await expect(lock.runExclusive(() => Promise.reject(new Error("inside")))).rejects.toThrow(
      "inside",
    )
    expect(lock.state).toBe(LockState.Free)
    expect(fs.locks.size).toBe(0)
  })

  it("runs the body and returns its value when free", async () => {
    const lock = new FileLock({ fs: fakeFs(), path: "/l" })
    expect(await lock.runExclusive(() => 42)).toBe(42)
    expect(lock.state).toBe(LockState.Free)
  })

  it("short-circuits a second tryAcquire on a held lock without touching the port", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    expect(await lock.tryAcquire()).toBe(true)
    const locksBefore = fs.calls.filter((call) => call.op === "lock").length
    // Already owned: no second syscall, no chance of a self-contention failure.
    expect(await lock.tryAcquire()).toBe(true)
    expect(fs.calls.filter((call) => call.op === "lock").length).toBe(locksBefore)
  })

  it("reports a revoked lock as unavailable on the next tryAcquire after release", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    await lock.tryAcquire()
    await lock.release()
    // Someone else took it between the two calls.
    await new FileLock({ fs, path: "/l" }).acquire()
    expect(await lock.tryAcquire()).toBe(false)
    expect(lock.state).toBe(LockState.Free)
  })

  it("propagates a directory-creation failure instead of calling it contention", async () => {
    const fs = fakeFs()
    const realMkdirp = fs.mkdirp
    fs.mkdirp = () => Promise.reject(new Error("mkdir refused"))
    const lock = new FileLock({ fs, path: "/deep/job.lock" })
    // Reporting an unusable directory as `LockUnavailableError` would send the caller hunting for a
    // competing process that does not exist.
    await expect(lock.acquire()).rejects.toThrow("mkdir refused")
    await expect(lock.tryAcquire()).rejects.toThrow("mkdir refused")
    expect(lock.state).toBe(LockState.Free)
    fs.mkdirp = realMkdirp
  })

  it("exposes the path it guards", () => {
    expect(new FileLock({ fs: fakeFs(), path: "/dir/job.lock" }).path).toBe("/dir/job.lock")
  })

  it("never runs the body when the lock is unavailable", async () => {
    const fs = fakeFs()
    await new FileLock({ fs, path: "/l" }).acquire()
    let ran = false
    await expect(
      new FileLock({ fs, path: "/l" }).runExclusive(() => {
        ran = true
      }),
    ).rejects.toThrow(LockUnavailableError)
    expect(ran).toBe(false)
  })
})
