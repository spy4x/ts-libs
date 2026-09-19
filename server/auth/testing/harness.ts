/**
 * Test harness for the auth package.
 *
 * Two properties matter more than convenience here:
 *
 *  - **Nothing real.** No network, no database and no environment. The adapter is
 *    in-memory, the clock is a counter the test advances, and the pepper is an
 *    obviously fake constant. The package's test task grants only `--allow-read`
 *    and `--allow-env`, so a test that reached for anything else would fail loudly.
 *  - **Everything injectable is injected.** The clock, the random byte source, the
 *    HTTP client and the cookie jar all exist as options precisely so a test can
 *    drive an adversarial value through the production path instead of
 *    approximating it.
 */

import { MemoryAdapter } from "../testing/memory-adapter.ts"
import { type Auth, type AuthOptions, createAuth } from "../lib.ts"
import type { CookieJar, CookieOptions, Session, SessionSink } from "../types.ts"

/** An obviously fake pepper. Never a real value from any deployment. */
export const TEST_PEPPER = "test-pepper-not-real"

/** A second, different pepper, for proving two deployments cannot read each other's hashes. */
export const OTHER_TEST_PEPPER = "test-pepper-other-not-real"

/**
 * PBKDF2 iterations for tests. The production count makes a suite take minutes and
 * proves nothing extra: the properties under test are about *where* hashing is
 * applied, not about its cost.
 */
export const TEST_ITERATIONS = 1_000

/** A clock a test moves by hand, so "expired" never depends on the wall. */
export class TestClock {
  private current: number

  constructor(start = Date.parse("2026-01-01T00:00:00.000Z")) {
    this.current = start
  }

  /** The clock function to inject. */
  readonly now = (): number => this.current

  /** Advance by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms
  }
}

/** Options for `createTestAuth`, on top of the ones a test wants to vary. */
export type TestAuthOptions = Partial<Omit<AuthOptions, "adapter">> & { adapter?: MemoryAdapter }

/** An assembled auth instance plus the fakes it was built from. */
export interface TestAuth {
  auth: Auth
  adapter: MemoryAdapter
  clock: TestClock
  sink: RecordingSessionSink
}

/** Records what a transport would have written, without writing anything. */
export class RecordingSessionSink implements SessionSink {
  readonly sessions: Session[] = []
  readonly idTokens: string[] = []

  setSession(session: Session): void {
    this.sessions.push(session)
  }

  getIdToken(session: Session): string {
    const token = `${session.id}:${session.token}`
    this.idTokens.push(token)
    return token
  }

  reset(): void {
    this.sessions.length = 0
    this.idTokens.length = 0
  }
}

/** A cookie jar that remembers, so an OAuth2 test can supply the state it stored. */
export class FakeCookieJar implements CookieJar {
  private readonly cookies = new Map<string, string>()

  get(name: string): string | undefined {
    return this.cookies.get(name)
  }

  set(name: string, value: string, _options?: CookieOptions): void {
    this.cookies.set(name, value)
  }

  delete(name: string): void {
    this.cookies.delete(name)
  }

  /** Seed a cookie without going through a provider, to test a bad state. */
  seed(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  has(name: string): boolean {
    return this.cookies.has(name)
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.cookies)
  }
}

/**
 * Build an auth instance over a fresh in-memory adapter.
 *
 * Defaults are chosen to make a test short: a fake pepper, the test iteration
 * count, and a `TestClock` the caller can advance.
 */
export function createTestAuth(options: TestAuthOptions = {}): TestAuth {
  const clock = new TestClock()
  const sink = new RecordingSessionSink()
  const adapter = options.adapter ?? new MemoryAdapter(clock.now)
  const auth = createAuth({
    passwordPepper: TEST_PEPPER,
    hashIterations: TEST_ITERATIONS,
    sessionSink: sink,
    now: clock.now,
    ...options,
    adapter,
  })
  return { auth, adapter, clock, sink }
}
