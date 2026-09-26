import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { fakeFs } from "./_fake-fs.ts"
import { FileLock, FileLockWaitError, LockState, LockUnavailableError } from "./file-lock.ts"

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

  it("keeps a lock taken before runExclusive held after the body finishes", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/data/.job.lock" })
    await lock.acquire()
    expect(await lock.runExclusive(() => "compacted")).toBe("compacted")
    expect(lock.state).toBe(LockState.Owned)
    expect(await new FileLock({ fs, path: "/data/.job.lock" }).tryAcquire()).toBe(false)
    await lock.release()
    expect(await new FileLock({ fs, path: "/data/.job.lock" }).tryAcquire()).toBe(true)
  })

  it("keeps a lock taken before runExclusive held when the body throws", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    await lock.acquire()
    await expect(lock.runExclusive(() => Promise.reject(new Error("inside")))).rejects.toThrow(
      "inside",
    )
    expect(lock.state).toBe(LockState.Owned)
    expect(fs.locks.has("/l")).toBe(true)
  })

  it("never runs two runExclusive bodies on one lock at the same time", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l" })
    let inside = 0
    let most = 0
    const order: string[] = []
    const body = (name: string) => async () => {
      inside++
      most = Math.max(most, inside)
      order.push(`${name} start`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      // Each body must still own the file lock at its end: an overlapping sibling that finished
      // first would have released it.
      expect(fs.locks.has("/l")).toBe(true)
      order.push(`${name} end`)
      inside--
    }
    const first = lock.runExclusive(body("first"))
    const second = lock.runExclusive(body("second"))
    await Promise.all([first, second])
    expect(most).toBe(1)
    expect(order).toEqual(["first start", "first end", "second start", "second end"])
    expect(lock.state).toBe(LockState.Free)
    expect(fs.locks.size).toBe(0)
  })

  it("lets a queued runExclusive run after the one before it failed to take the lock", async () => {
    const fs = fakeFs()
    const realMkdirp = fs.mkdirp
    fs.mkdirp = () => {
      fs.mkdirp = realMkdirp
      return Promise.reject(new Error("mkdir refused once"))
    }
    const lock = new FileLock({ fs, path: "/l" })
    const refused = lock.runExclusive(() => "never")
    const queued = lock.runExclusive(() => "ran")
    await expect(refused).rejects.toThrow("mkdir refused once")
    await expect(queued).resolves.toBe("ran")
    expect(lock.state).toBe(LockState.Free)
  })

  it("waits without a bound for an earlier runExclusive when waitMs is Infinity", async () => {
    const lock = new FileLock({ fs: fakeFs(), path: "/l", waitMs: Infinity })
    const first = lock.runExclusive(() => new Promise((resolve) => setTimeout(resolve, 20)))
    await expect(lock.runExclusive(() => "second")).resolves.toBe("second")
    await first
  })

  it("fails a nested runExclusive with FileLockWaitError instead of hanging", async () => {
    const fs = fakeFs()
    const lock = new FileLock({ fs, path: "/l", waitMs: 10 })
    const error = await lock.runExclusive(() => lock.runExclusive(() => "inner")).catch((e) => e)
    expect(error).toBeInstanceOf(FileLockWaitError)
    expect((error as FileLockWaitError).path).toBe("/l")
    expect((error as Error).message).toContain("nested")
    expect((error as Error).message).toContain("still running")
    // The outer call still cleans up, and the timed-out waiter does not keep the lock afterwards.
    expect(lock.state).toBe(LockState.Free)
    expect(await lock.runExclusive(() => "after")).toBe("after")
  })

  it("waits without a bound when waitMs is longer than a timer can hold", async () => {
    const lock = new FileLock({ fs: fakeFs(), path: "/l", waitMs: Number.MAX_SAFE_INTEGER })
    const first = lock.runExclusive(() => new Promise((resolve) => setTimeout(resolve, 20)))
    await expect(lock.runExclusive(() => "second")).resolves.toBe("second")
    await first
  })

  it("rejects a NaN or negative waitMs when constructed", () => {
    expect(() => new FileLock({ fs: fakeFs(), path: "/l", waitMs: NaN })).toThrow(RangeError)
    expect(() => new FileLock({ fs: fakeFs(), path: "/l", waitMs: -1 })).toThrow(
      "FileLock waitMs must be a number of 0 or more, got -1",
    )
    expect(() => new FileLock({ fs: fakeFs(), path: "/l", waitMs: 0 })).not.toThrow()
  })
})

// Top level on purpose: a `describe` step does not enforce `sanitizeOps`, so a leaked timer would
// pass unnoticed there.
Deno.test({
  name: "FileLock leaves no wait timer behind after an uncontended call and a queued call",
  sanitizeOps: true,
  fn: async () => {
    const lock = new FileLock({ fs: fakeFs(), path: "/l", waitMs: 60_000 })
    expect(await lock.runExclusive(() => "alone")).toBe("alone")
    const first = lock.runExclusive(() => Promise.resolve("first"))
    const queued = lock.runExclusive(() => "queued")
    expect(await Promise.all([first, queued])).toEqual(["first", "queued"])
  },
})
