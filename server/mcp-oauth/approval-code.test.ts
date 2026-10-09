import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { sha256Hex } from "@spy4x/platform/tokens"
import {
  createApprovalCode,
  DEFAULT_APPROVAL_CODE_TTL_MS,
  MAX_APPROVAL_CODE_TTL_MS,
} from "./approval-code.ts"
import { MemoryOAuthStore } from "./memory-store.ts"
import type { ApprovalCodeRecord, OAuthStore } from "./model.ts"
import { manualClock } from "./store-contract.test.ts"

describe("createApprovalCode", () => {
  it("saves only the code's digest, expiring after five minutes by default", async () => {
    const clock = manualClock()
    const saved: [string, ApprovalCodeRecord][] = []
    const store = {
      saveApprovalCode: (key: string, record: ApprovalCodeRecord) => {
        saved.push([key, record])
        return Promise.resolve()
      },
    } as unknown as OAuthStore
    const { code, expiresAt } = await createApprovalCode(store, { clock })
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt).toBe(1_000 + DEFAULT_APPROVAL_CODE_TTL_MS)
    expect(DEFAULT_APPROVAL_CODE_TTL_MS).toBe(5 * 60_000)
    expect(saved).toEqual([[await sha256Hex(code), { expiresAt }]])
  })

  it("makes a different code every time", async () => {
    const store = new MemoryOAuthStore()
    const first = await createApprovalCode(store)
    const second = await createApprovalCode(store)
    expect(first.code).not.toBe(second.code)
  })

  it("refuses a lifetime that is not positive or is longer than fifteen minutes", async () => {
    const store = new MemoryOAuthStore()
    for (const ttlMs of [0, -1, Number.NaN, MAX_APPROVAL_CODE_TTL_MS + 1]) {
      await expect(createApprovalCode(store, { ttlMs })).rejects.toThrow(RangeError)
    }
    expect(MAX_APPROVAL_CODE_TTL_MS).toBe(15 * 60_000)
    await createApprovalCode(store, { ttlMs: MAX_APPROVAL_CODE_TTL_MS })
  })
})
