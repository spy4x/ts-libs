import {
  assertPositiveFinite,
  type BeginOutcome,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_RETENTION_DAYS,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.ts"

/** What {@link MemoryIdempotencyStore} reads from outside. */
export interface MemoryIdempotencyStoreOptions {
  /** Seconds an unfinished claim holds before a retry may take it over. Default 30. */
  leaseSeconds?: number
  /** Days a key is kept. Default 7. */
  retentionDays?: number
  /** Milliseconds since the epoch; replaced in tests to move time without waiting. */
  now?: () => number
}

interface Row {
  token: string
  claim: IdempotencyClaim
  done: boolean
  result: unknown
  createdAt: number
  updatedAt: number
}

/**
 * An {@link IdempotencyStore} that keeps rows in memory, for tests and single-process tools. It
 * follows the same rules as `PostgresIdempotencyStore` (the shared contract suite holds both to
 * them), but forgets everything when the process ends.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, Row>()
  private readonly leaseMs: number
  private readonly retentionMs: number
  private readonly now: () => number

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    const leaseSeconds = options.leaseSeconds ?? IDEMPOTENCY_LEASE_SECONDS
    const retentionDays = options.retentionDays ?? IDEMPOTENCY_RETENTION_DAYS
    assertPositiveFinite("leaseSeconds", leaseSeconds)
    assertPositiveFinite("retentionDays", retentionDays)
    this.leaseMs = leaseSeconds * 1000
    this.retentionMs = retentionDays * 86_400_000
    this.now = options.now ?? Date.now
  }

  begin(claim: IdempotencyClaim): Promise<BeginOutcome> {
    const id = rowId(claim.userId, claim.key)
    const now = this.now()
    let row = this.rows.get(id)
    if (row && row.createdAt < now - this.retentionMs) {
      this.rows.delete(id)
      row = undefined
    }
    if (!row) {
      const token = crypto.randomUUID()
      this.rows.set(id, { token, claim, done: false, result: null, createdAt: now, updatedAt: now })
      return Promise.resolve({ status: "claimed", token })
    }
    if (
      row.claim.commandName !== claim.commandName || row.claim.requestHash !== claim.requestHash
    ) {
      return Promise.resolve({ status: "reused" })
    }
    if (row.done) return Promise.resolve({ status: "replay", result: clone(row.result) })
    if (row.updatedAt >= now - this.leaseMs) return Promise.resolve({ status: "in_progress" })
    row.updatedAt = now
    row.token = crypto.randomUUID()
    return Promise.resolve({ status: "claimed", token: row.token })
  }

  complete(userId: number, key: string, token: string, result: unknown): Promise<void> {
    const row = this.rows.get(rowId(userId, key))
    if (row && !row.done && row.token === token) {
      row.done = true
      row.result = clone(result)
      row.updatedAt = this.now()
    }
    return Promise.resolve()
  }

  release(userId: number, key: string, token: string): Promise<void> {
    const id = rowId(userId, key)
    const row = this.rows.get(id)
    if (row?.done === false && row.token === token) this.rows.delete(id)
    return Promise.resolve()
  }

  sweep(): Promise<number> {
    const cutoff = this.now() - this.retentionMs
    let removed = 0
    for (const [id, row] of this.rows) {
      if (row.createdAt < cutoff) {
        this.rows.delete(id)
        removed++
      }
    }
    return Promise.resolve(removed)
  }
}

function rowId(userId: number, key: string): string {
  return `${userId}:${key}`
}

/** What a JSON column would hold: the value as JSON, `undefined` as `null`. */
function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}
