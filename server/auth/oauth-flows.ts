/**
 * Where `createOAuthSignIn` keeps a started flow between `authorizationUrl()` and the callback
 * (#150).
 *
 * A flow is written once with `put` and read back once with `take`, which deletes it in the same
 * step, so two parallel callbacks with the same `state` never both receive it. Two stores ship:
 *
 * - {@link createMemoryOAuthFlowStore}, the default: a map inside the process, capped at
 *   {@link MAX_PENDING_OAUTH_FLOWS}. The callback must reach the process that started the flow.
 * - {@link createKvOAuthFlowStore}: any key-value client with `set` and an atomic `take`, such as
 *   Redis. Every process that shares it can complete any flow, and there is no cap.
 *
 * @module
 */

import { type Clock, systemClock } from "@spy4x/platform/universal/time"

/** Most flows the memory store keeps pending at once; the oldest is dropped beyond this. */
export const MAX_PENDING_OAUTH_FLOWS = 10_000

/** The key prefix {@link createKvOAuthFlowStore} writes under by default. */
export const DEFAULT_OAUTH_FLOW_KEY_PREFIX = "oauth-flow:"

/** What a started flow needs at its callback. */
export interface OAuthPendingFlow {
  /** The PKCE verifier the code is redeemed with. A secret: it never leaves the server. */
  verifier: string
}

/** A flow {@link OAuthFlowStore.take} returns: the flow as it was put, and its expiry. */
export interface OAuthTakenFlow extends OAuthPendingFlow {
  /** The `expiresAt` the flow was put with. `createOAuthSignIn` checks it again after `take`. */
  expiresAt: Date
}

/** Keeps started flows until their callback. Every method may reject; the caller's call fails. */
export interface OAuthFlowStore {
  /** Keeps `flow` under `state` until `expiresAt`. A `state` is never reused. */
  put(state: string, flow: OAuthPendingFlow, expiresAt: Date): Promise<void>
  /**
   * Returns the flow kept under `state`, with the `expiresAt` it was put with, and deletes it in one
   * atomic step. Null when there is none, when it was already taken, or when its `expiresAt` has
   * passed. Of several parallel calls for one `state`, at most one receives the flow.
   */
  take(state: string): Promise<OAuthTakenFlow | null>
}

/** Options of {@link createMemoryOAuthFlowStore}. */
export interface MemoryOAuthFlowStoreOptions {
  /** Reads the time a flow expires against. Defaults to the system clock. */
  clock?: Clock
  /** Most flows kept at once, a positive integer. Defaults to {@link MAX_PENDING_OAUTH_FLOWS}. */
  maxFlows?: number
}

/**
 * The in-process store `createOAuthSignIn` uses when it is given none. Each `put` first drops the
 * expired flows and, while the store is full, the oldest ones, so at most `maxFlows` are kept. A
 * flood of started flows therefore pushes out older pending ones; rate-limit the route that calls
 * `authorizationUrl()`, or use {@link createKvOAuthFlowStore}.
 *
 * @throws {TypeError} When `maxFlows` is not a positive integer.
 */
export function createMemoryOAuthFlowStore(
  options: MemoryOAuthFlowStoreOptions = {},
): OAuthFlowStore {
  const clock = options.clock ?? systemClock
  const maxFlows = options.maxFlows ?? MAX_PENDING_OAUTH_FLOWS
  if (!Number.isSafeInteger(maxFlows) || maxFlows < 1) {
    throw new TypeError("maxFlows must be a positive integer")
  }
  /** state → flow, oldest first. */
  const flows = new Map<string, { verifier: string; expiresAt: number }>()

  return {
    put(state, flow, expiresAt) {
      const now = clock.now()
      for (const [kept, entry] of flows) {
        if (entry.expiresAt > now && flows.size < maxFlows) break
        flows.delete(kept)
      }
      flows.set(state, { verifier: flow.verifier, expiresAt: expiresAt.getTime() })
      return Promise.resolve()
    },
    take(state) {
      const entry = flows.get(state)
      flows.delete(state)
      if (!entry || entry.expiresAt <= clock.now()) return Promise.resolve(null)
      return Promise.resolve({ verifier: entry.verifier, expiresAt: new Date(entry.expiresAt) })
    },
  }
}

/**
 * The key-value client {@link createKvOAuthFlowStore} needs. `RedisKvStore` from
 * `@spy4x/server/kv` has this shape once it has `take` (`GETDEL`).
 */
export interface OAuthFlowKv {
  /** Stores `value` under `key`, removed after `ttlSec` whole seconds. */
  set(key: string, value: string, ttlSec: number): Promise<void>
  /**
   * Returns the value under `key` and deletes the key in one atomic step, or null. Must be atomic:
   * a `get` followed by a `del` lets two parallel callbacks complete one flow.
   */
  take(key: string): Promise<string | null>
}

/** Options of {@link createKvOAuthFlowStore}. */
export interface KvOAuthFlowStoreOptions {
  /** Reads the time a flow expires against. Defaults to the system clock. */
  clock?: Clock
  /** Put before every `state` in a key. Defaults to {@link DEFAULT_OAUTH_FLOW_KEY_PREFIX}. */
  keyPrefix?: string
}

/**
 * A flow store on a shared key-value client, so a callback can land on any process that shares it.
 *
 * `take` is the client's own atomic `take`, so single use holds across processes. The flow's expiry
 * is stored with it and checked against `clock` on `take`; the key's time to live, rounded up to a
 * whole second, only removes flows nobody completed. A value that is not a flow this store wrote
 * reads as no flow.
 */
export function createKvOAuthFlowStore(
  kv: OAuthFlowKv,
  options: KvOAuthFlowStoreOptions = {},
): OAuthFlowStore {
  const clock = options.clock ?? systemClock
  const prefix = options.keyPrefix ?? DEFAULT_OAUTH_FLOW_KEY_PREFIX

  return {
    async put(state, flow, expiresAt) {
      const lifetimeMs = expiresAt.getTime() - clock.now()
      if (!(lifetimeMs > 0)) return
      const value = JSON.stringify({ verifier: flow.verifier, expiresAt: expiresAt.getTime() })
      await kv.set(`${prefix}${state}`, value, Math.ceil(lifetimeMs / 1000))
    },
    async take(state) {
      const value = await kv.take(`${prefix}${state}`)
      const entry = value === null ? null : parseEntry(value)
      if (!entry || entry.expiresAt <= clock.now()) return null
      return { verifier: entry.verifier, expiresAt: new Date(entry.expiresAt) }
    },
  }
}

function parseEntry(value: string): { verifier: string; expiresAt: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const { verifier, expiresAt } = parsed as Record<string, unknown>
  if (typeof verifier !== "string" || typeof expiresAt !== "number") return null
  if (!Number.isFinite(expiresAt)) return null
  return { verifier, expiresAt }
}
