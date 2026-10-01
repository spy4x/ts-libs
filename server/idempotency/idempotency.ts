import type { Command, CqrsMiddleware, Query } from "@spy4x/platform/cqrs"
import { sha256Hex } from "@spy4x/platform/tokens"

/** Default for how long a stored key stays usable: the longest a client may be offline. */
export const IDEMPOTENCY_RETENTION_DAYS = 7

/**
 * Default for how long an unfinished run keeps its claim. A run that has not finished by then is
 * taken to have died with its process, and the next retry runs the command again. Pick a lease
 * longer than the slowest run you expect, so a run that is merely slow is never taken over.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 30

/** The longest command name the stores accept; the Postgres column is `VARCHAR(100)`. */
export const MAX_IDEMPOTENCY_COMMAND_NAME_LENGTH = 100

/** The longest key the stores accept; the Postgres column is `VARCHAR(128)`. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128

/** The user, key and input a command was sent with. */
export interface IdempotencyClaim {
  userId: number
  key: string
  /** The command's class name; a key belongs to one kind of command. */
  commandName: string
  /** Fingerprint of the command's input; see {@link fingerprint}. */
  requestHash: string
}

/** What {@link IdempotencyStore.begin} found for a key. */
export type BeginOutcome =
  /**
   * The key is new (or its earlier run died): run the command, then `complete` or `release`, both
   * with `token`. The token fences the claim: a run whose claim was taken over after its lease
   * ran out holds a stale token, and its `complete` and `release` change nothing.
   */
  | { status: "claimed"; token: string }
  /** The command already ran; `result` is what it returned. */
  | { status: "replay"; result: unknown }
  /** The first run is still going. */
  | { status: "in_progress" }
  /** The key was used for a different command or different input. */
  | { status: "reused" }

/** Keeps the outcome of every command that carried an idempotency key. */
export interface IdempotencyStore {
  /** Claims the key for the caller, or says what the earlier claim left. */
  begin(claim: IdempotencyClaim): Promise<BeginOutcome>
  /**
   * Stores the result of a claimed run, so the next `begin` answers `replay`. Does nothing when
   * `token` is not the key's current claim token.
   */
  complete(userId: number, key: string, token: string, result: unknown): Promise<void>
  /**
   * Gives up an unfinished claim, so a retry may run the command. Does nothing when `token` is not
   * the key's current claim token.
   */
  release(userId: number, key: string, token: string): Promise<void>
  /** Removes keys older than the retention. Returns how many were removed. */
  sweep(): Promise<number>
}

export type IdempotencyErrorCode =
  | "INVALID_KEY"
  | "INVALID_COMMAND"
  | "KEY_REUSED"
  | "IN_PROGRESS"

/** Why a command with an idempotency key was refused before it ran. */
export class IdempotencyError extends Error {
  constructor(public readonly code: IdempotencyErrorCode, message: string) {
    super(message)
    this.name = "IdempotencyError"
  }
}

/** Whether `key` is usable: 1 to 128 printable ASCII characters. */
export function isIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    /^[\x21-\x7e]+$/.test(key)
}

/** The fields of a command's data that describe who asked and how, not what was asked. */
const NOT_INPUT = new Set(["actor", "idempotencyKey", "requestId", "request"])

/**
 * A stable SHA-256 hex fingerprint of a command's name and input.
 *
 * Two sends of the same command produce the same fingerprint even though their request ids and
 * request info differ; a different name or different input produces a different one. Object keys
 * are sorted, so the order a client wrote them in does not matter. A value with `toJSON` counts as
 * what it returns; a `Map`, `Set` or other non-plain object without one makes this throw a
 * `TypeError`, because it cannot be told apart from another one.
 */
export async function fingerprint(
  commandName: string,
  data: Record<string, unknown>,
): Promise<string> {
  const input: Record<string, unknown> = {}
  for (const name of Object.keys(data)) {
    if (!NOT_INPUT.has(name)) input[name] = data[name]
  }
  return await sha256Hex(stableStringify({ commandName, input }) as string)
}

/**
 * `JSON.stringify` with sorted object keys. Like it, a value with a `toJSON` method (a `Date`, a
 * Temporal value) is replaced by what `toJSON` returns, and an object property that is `undefined`
 * or a function is left out. Unlike it, an object that is neither a plain object, an array nor
 * has a `toJSON` (a `Map`, a `Set`, a class instance) throws: it would otherwise serialise as `{}`
 * and two different inputs would share a fingerprint.
 */
function stableStringify(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const { toJSON } = value as { toJSON?: unknown }
  if (typeof toJSON === "function") return stableStringify(toJSON.call(value))
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `Cannot fingerprint a ${
        prototype.constructor?.name ?? "non-plain object"
      }: use plain data or give it a toJSON method`,
    )
  }
  const entries: string[] = []
  for (const name of Object.keys(value).sort()) {
    const text = stableStringify((value as Record<string, unknown>)[name])
    if (text !== undefined) entries.push(`${JSON.stringify(name)}:${text}`)
  }
  return `{${entries.join(",")}}`
}

/** What {@link createIdempotencyMiddleware} needs. */
export interface IdempotencyOptions {
  store: IdempotencyStore
  /** How long a retry waits for a run that is still in flight before it is refused. */
  waitMs?: number
  /** How often a waiting retry looks again. */
  pollMs?: number
  /** Waits `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Reports a failure of the store after the command ran (storing the result or releasing the
   * claim), which the caller cannot act on. The caller still gets the command's own result or
   * error.
   */
  onStoreFailure?: (error: unknown) => void
}

const DEFAULT_WAIT_MS = 8_000
const DEFAULT_POLL_MS = 100

/**
 * Makes a command safe to send twice. A command whose data carries an `idempotencyKey` and an
 * `actor` runs once per (user, key): a repeat returns the first run's result and changes nothing.
 * A command without a key passes through, so a transport that requires keys (a socket, say) refuses
 * the command itself, before it reaches the bus.
 *
 * - A repeat that arrives while the first run is in flight waits for it and returns its result;
 *   if the run has not finished within `waitMs`, the repeat fails with `IN_PROGRESS` and the
 *   client retries. It never runs the command a second time beside the first.
 * - The same key with a different command or different input fails with `KEY_REUSED`.
 * - A run that throws leaves nothing behind (its claim is released), so the retry runs it again.
 *   That is safe because a failed command changed nothing.
 * - The stored result is the command's result as JSON. A transport sends JSON anyway; an
 *   in-process caller of a replayed command sees dates as ISO strings.
 * - If the store fails after the command ran, the command's own result (or error) still reaches the
 *   caller and the failure goes to `onStoreFailure`. A result that cannot be stored leaves the claim
 *   to expire, as below.
 * - The claim and the command are not one transaction. A process that dies after the command
 *   committed and before the result was stored leaves a claim that expires after
 *   {@link IDEMPOTENCY_LEASE_SECONDS}; a retry after that runs the command again. So does a run
 *   that outlives its lease: the retry takes the claim over and runs the command a second time, but
 *   the first run's claim token is then stale, so it can neither release nor complete the new
 *   claim. Closing the duplicate window needs the command to write its result in its own
 *   transaction.
 */
export function createIdempotencyMiddleware(options: IdempotencyOptions): CqrsMiddleware {
  const { store } = options
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))

  return async (message: Command<unknown, unknown> | Query<unknown, unknown>, next) => {
    const data = message.data as { actor?: { userId?: unknown }; idempotencyKey?: unknown } | null
    const key = data?.idempotencyKey
    if (key === undefined) return await next()
    if (!isIdempotencyKey(key)) {
      throw new IdempotencyError("INVALID_KEY", "The idempotency key must be 1 to 128 characters")
    }
    const userId = data?.actor?.userId
    if (typeof userId !== "number") {
      throw new IdempotencyError("INVALID_KEY", "An idempotency key needs a signed-in user")
    }
    const commandName = message.constructor.name
    if (commandName.length > MAX_IDEMPOTENCY_COMMAND_NAME_LENGTH) {
      throw new IdempotencyError(
        "INVALID_COMMAND",
        `The command name is longer than ${MAX_IDEMPOTENCY_COMMAND_NAME_LENGTH} characters`,
      )
    }
    const claim: IdempotencyClaim = {
      userId,
      key,
      commandName,
      requestHash: await fingerprint(commandName, data as Record<string, unknown>),
    }

    let token: string
    let waited = 0
    while (true) {
      const outcome = await store.begin(claim)
      if (outcome.status === "replay") return outcome.result
      if (outcome.status === "reused") {
        throw new IdempotencyError(
          "KEY_REUSED",
          "The idempotency key was already used for a different request",
        )
      }
      if (outcome.status === "claimed") {
        token = outcome.token
        break
      }
      if (waited >= waitMs) {
        throw new IdempotencyError(
          "IN_PROGRESS",
          "The first request with this key is still running",
        )
      }
      await sleep(pollMs)
      waited += pollMs
    }

    const report = (error: unknown) => {
      try {
        options.onStoreFailure?.(error)
      } catch {
        // A failing reporter must not replace the command's own result or error.
      }
    }
    let result: unknown
    try {
      result = await next()
    } catch (error) {
      await store.release(userId, key, token).catch(report)
      throw error
    }
    try {
      await store.complete(userId, key, token, JSON.parse(JSON.stringify(result ?? null)))
    } catch (error) {
      report(error)
    }
    return result
  }
}

/** Throws unless `value` is a finite number above zero; the stores call it on their options. */
export function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number above zero, got ${value}`)
  }
}
