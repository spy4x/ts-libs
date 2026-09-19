/**
 * An in-memory `Adapter`.
 *
 * Lives in the source tree, not beside a test, for two reasons: it is the worked
 * example of the adapter contract, and two suites need the same store.
 *
 * It is deliberately strict in the ways a real database would be and a careless
 * fake would not:
 *
 *  - `createKey` rejects a second key of the same kind and identification, the
 *    constraint that makes `KeyKind`-keyed lookup unambiguous;
 *  - delete and update return the same `null`/`false` a zero-row SQL statement
 *    produces, so a provider path that forgets to check a result fails here;
 *  - `expiresAt` is stored as given, so an expiry test fails if a provider stops
 *    writing one.
 *
 * Everything is copied on the way out, so a caller mutating a returned record —
 * which a provider does when it puts the raw token back on a session — cannot
 * reach into the store.
 */

import type {
  Adapter,
  Everything,
  Key,
  KeyBase,
  NewKeyLike,
  Session,
  SessionBase,
  User,
  UserBase,
} from "../types.ts"

/** Thrown by the fake when a caller violates a constraint a real schema would enforce. */
export class MemoryAdapterConstraintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryAdapterConstraintError"
  }
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

/** An in-memory adapter with database-like constraint behaviour. */
export class MemoryAdapter implements Adapter {
  private readonly users = new Map<number, User>()
  private readonly keys = new Map<number, Key>()
  private readonly sessions = new Map<number, Session>()
  private nextUserId = 1
  private nextKeyId = 1
  private nextSessionId = 1

  constructor(private readonly now: () => number = Date.now) {}

  // Accounts -----------------------------------------------------------------

  getUser(id: number): Promise<null | User> {
    const user = this.users.get(id)
    return Promise.resolve(user ? copy(user) : null)
  }

  createUser(payload?: Partial<UserBase>): Promise<User> {
    const timestamp = new Date(this.now())
    const user: User = {
      id: this.nextUserId++,
      createdAt: timestamp,
      updatedAt: timestamp,
      email: payload?.email ?? null,
      firstName: payload?.firstName ?? null,
      lastName: payload?.lastName ?? null,
      photoUrl: payload?.photoUrl ?? null,
      permission: payload?.permission ?? null,
    }
    this.users.set(user.id, user)
    return Promise.resolve(copy(user))
  }

  async createUserWithEverything(
    key: NewKeyLike,
    session: SessionBase,
    user?: Partial<UserBase>,
  ): Promise<Everything> {
    const createdUser = await this.createUser(user)
    const createdKey = await this.createKey({ ...key, userId: createdUser.id })
    if (!createdKey) {
      throw new MemoryAdapterConstraintError("createUserWithEverything could not create the key")
    }
    const createdSession = await this.createSession({
      token: session.token,
      userId: createdUser.id,
      keyId: createdKey.id,
      expiresAt: session.expiresAt ?? null,
    })
    if (!createdSession) {
      throw new MemoryAdapterConstraintError(
        "createUserWithEverything could not create the session",
      )
    }
    return { user: createdUser, key: createdKey, session: createdSession }
  }

  updateUser(id: number, update: Partial<UserBase>): Promise<null | User> {
    const user = this.users.get(id)
    if (!user) {
      return Promise.resolve(null)
    }
    const updated: User = { ...user, ...update, id: user.id, updatedAt: new Date(this.now()) }
    this.users.set(id, updated)
    return Promise.resolve(copy(updated))
  }

  // Credentials ---------------------------------------------------------------

  getKey(id: number): Promise<null | Key> {
    const key = this.keys.get(id)
    return Promise.resolve(key ? copy(key) : null)
  }

  getAllKeys(userId: number): Promise<Key[]> {
    return Promise.resolve(
      [...this.keys.values()].filter((key) => key.userId === userId).map(copy),
    )
  }

  createKey(key: NewKeyLike & Pick<KeyBase, "userId">): Promise<null | Key> {
    const clash = [...this.keys.values()].find(
      (existing) => existing.kind === key.kind && existing.identification === key.identification,
    )
    if (clash) {
      throw new MemoryAdapterConstraintError(
        `a key of kind ${key.kind} already exists for this identification`,
      )
    }
    const timestamp = new Date(this.now())
    const created: Key = {
      id: this.nextKeyId++,
      createdAt: timestamp,
      updatedAt: timestamp,
      userId: key.userId,
      kind: key.kind,
      identification: key.identification,
      email: key.email ?? null,
      secret: key.secret ?? null,
      expiresAt: key.expiresAt ?? null,
      attempts: key.attempts ?? 0,
    }
    this.keys.set(created.id, created)
    return Promise.resolve(copy(created))
  }

  deleteKey(key: Pick<KeyBase, "userId" | "kind">): Promise<boolean> {
    for (const [id, existing] of this.keys) {
      if (existing.userId === key.userId && existing.kind === key.kind) {
        this.keys.delete(id)
        return Promise.resolve(true)
      }
    }
    return Promise.resolve(false)
  }

  deleteKeyById(id: number): Promise<void> {
    this.keys.delete(id)
    return Promise.resolve()
  }

  updateKey(id: number, key: Partial<KeyBase>): Promise<null | Key> {
    const existing = this.keys.get(id)
    if (!existing) {
      return Promise.resolve(null)
    }
    const updated: Key = { ...existing, ...key, id, updatedAt: new Date(this.now()) }
    this.keys.set(id, updated)
    return Promise.resolve(copy(updated))
  }

  findKeyByIdentification(identification: string): Promise<null | Key> {
    for (const key of this.keys.values()) {
      if (key.identification === identification) {
        return Promise.resolve(copy(key))
      }
    }
    return Promise.resolve(null)
  }

  findKeyByEmail(email: string): Promise<null | Key> {
    for (const key of this.keys.values()) {
      if (key.email === email) {
        return Promise.resolve(copy(key))
      }
    }
    return Promise.resolve(null)
  }

  findKeyByKindAndIdentification(
    key: Pick<KeyBase, "kind" | "identification">,
  ): Promise<null | Key> {
    for (const existing of this.keys.values()) {
      if (existing.kind === key.kind && existing.identification === key.identification) {
        return Promise.resolve(copy(existing))
      }
    }
    return Promise.resolve(null)
  }

  findKeyByUserId(key: Pick<KeyBase, "kind" | "userId">): Promise<null | Key> {
    for (const existing of this.keys.values()) {
      if (existing.kind === key.kind && existing.userId === key.userId) {
        return Promise.resolve(copy(existing))
      }
    }
    return Promise.resolve(null)
  }

  // Sessions -----------------------------------------------------------------

  getSession(id: number): Promise<null | Session> {
    const session = this.sessions.get(id)
    return Promise.resolve(session ? copy(session) : null)
  }

  getAllSessions(userId: number): Promise<Session[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter((s) => s.userId === userId).map(copy),
    )
  }

  createSession(
    session: Pick<SessionBase, "token" | "userId" | "keyId" | "expiresAt">,
  ): Promise<null | Session> {
    const timestamp = new Date(this.now())
    const created: Session = {
      id: this.nextSessionId++,
      createdAt: timestamp,
      updatedAt: timestamp,
      token: session.token,
      userId: session.userId,
      keyId: session.keyId,
      expiresAt: session.expiresAt ?? null,
    }
    this.sessions.set(created.id, created)
    return Promise.resolve(copy(created))
  }

  updateSession(id: number, session: Partial<SessionBase>): Promise<null | Session> {
    const existing = this.sessions.get(id)
    if (!existing) {
      return Promise.resolve(null)
    }
    const updated: Session = { ...existing, ...session, id, updatedAt: new Date(this.now()) }
    this.sessions.set(id, updated)
    return Promise.resolve(copy(updated))
  }

  deleteSession(id: number): Promise<void> {
    this.sessions.delete(id)
    return Promise.resolve()
  }

  deleteSessionByIdToken(id: number, token: string): Promise<void> {
    const existing = this.sessions.get(id)
    if (existing && existing.token === token) {
      this.sessions.delete(id)
    }
    return Promise.resolve()
  }

  deleteAllSessions(userId: number): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(id)
      }
    }
    return Promise.resolve()
  }

  deleteExpiredSessions(): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt && session.expiresAt.getTime() < this.now()) {
        this.sessions.delete(id)
      }
    }
    return Promise.resolve()
  }

  // Test helpers -------------------------------------------------------------

  /** Every stored key, for assertions about the linking model. */
  allKeys(): Key[] {
    return [...this.keys.values()].map(copy)
  }

  /** Every stored session, for assertions that a link did or did not mint one. */
  allSessions(): Session[] {
    return [...this.sessions.values()].map(copy)
  }

  /** Every stored account. */
  allUsers(): User[] {
    return [...this.users.values()].map(copy)
  }
}
