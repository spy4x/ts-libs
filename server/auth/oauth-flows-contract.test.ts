// The `OAuthFlowStore` contract, written once and run against every store: `oauth-flows.test.ts`
// runs it on the memory store and on the key-value store over a fake client, and
// `oauth-flows.integration.test.ts` on the key-value store over a real Redis.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeOAuthFlowStoreContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { OAuthFlowStore } from "./oauth-flows.ts"

/** A fresh, empty store, the clock it reads, and how to dispose of it. */
export interface FlowStoreFixture {
  store: OAuthFlowStore
  /** Moves the clock the store reads forward. */
  advance(ms: number): void
  /** The time the store reads now, in milliseconds. */
  now(): number
  close(): Promise<void>
}

const TEN_MINUTES = 600_000

/** PKCE verifiers of the shape `authorizationUrl()` makes: 43 base64url characters. */
const VERIFIER_A = "a".repeat(43)
const VERIFIER_B = "b".repeat(43)
const VERIFIER_EARLY = "early-".padEnd(43, "e")
const VERIFIER_LATE = "late-".padEnd(43, "l")

/**
 * Registers the contract suite for one store.
 *
 * @param label Names the store in every test name.
 * @param open Returns a fresh, empty store for each test.
 */
export function describeOAuthFlowStoreContract(
  label: string,
  open: () => Promise<FlowStoreFixture>,
): void {
  async function withStore(body: (fixture: FlowStoreFixture) => Promise<void>): Promise<void> {
    const fixture = await open()
    try {
      await body(fixture)
    } finally {
      await fixture.close()
    }
  }

  describe(`OAuthFlowStore contract: ${label}`, () => {
    it("returns the flow put under a state, and only once", () =>
      withStore(async ({ store, now }) => {
        const expiresAt = new Date(now() + TEN_MINUTES)
        await store.put("state-a", { verifier: VERIFIER_A }, expiresAt)
        expect(await store.take("state-a")).toEqual({ verifier: VERIFIER_A, expiresAt })
        expect(await store.take("state-a")).toBeNull()
      }))

    it("returns null for a state it was never given", () =>
      withStore(async ({ store }) => {
        expect(await store.take("never-put")).toBeNull()
      }))

    it("gives the flow to exactly one of many parallel takes", () =>
      withStore(async ({ store, now }) => {
        const expiresAt = new Date(now() + TEN_MINUTES)
        await store.put("state-a", { verifier: VERIFIER_A }, expiresAt)
        const taken = await Promise.all(Array.from({ length: 10 }, () => store.take("state-a")))
        expect(taken.filter((flow) => flow !== null)).toEqual([{
          verifier: VERIFIER_A,
          expiresAt,
        }])
      }))

    it("returns the flow a millisecond before its expiry and null at it", () =>
      withStore(async ({ store, now, advance }) => {
        const expiresAt = new Date(now() + TEN_MINUTES)
        await store.put("early", { verifier: VERIFIER_EARLY }, expiresAt)
        await store.put("late", { verifier: VERIFIER_LATE }, expiresAt)
        advance(TEN_MINUTES - 1)
        expect(await store.take("early")).toEqual({ verifier: VERIFIER_EARLY, expiresAt })
        advance(1)
        expect(await store.take("late")).toBeNull()
      }))

    it("keeps the flows of different states apart", () =>
      withStore(async ({ store, now }) => {
        const expiresAt = new Date(now() + TEN_MINUTES)
        await store.put("state-a", { verifier: VERIFIER_A }, expiresAt)
        await store.put("state-b", { verifier: VERIFIER_B }, expiresAt)
        expect(await store.take("state-b")).toEqual({ verifier: VERIFIER_B, expiresAt })
        expect(await store.take("state-a")).toEqual({ verifier: VERIFIER_A, expiresAt })
      }))
  })
}
