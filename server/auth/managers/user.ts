/**
 * Account manager.
 *
 * A thin delegation to the adapter, kept as a named seam because the providers
 * depend on the *interface* rather than on the adapter: a test supplies an
 * in-memory `IUserManager` and never touches Postgres.
 */

import type {
  Adapter,
  Everything,
  IUserManager,
  NewKeyLike,
  SessionBase,
  User,
  UserBase,
} from "../types.ts"

/** Reads and writes accounts. */
export class UserManager implements IUserManager {
  constructor(private readonly adapter: Adapter) {}

  get(id: number): Promise<null | User> {
    return this.adapter.getUser(id)
  }

  create(payload?: Partial<UserBase>): Promise<User> {
    return this.adapter.createUser(payload)
  }

  /**
   * Create account, credential and session in one adapter call, so a failure
   * half-way cannot leave a user with no way to sign in.
   */
  createWithEverything(
    key: NewKeyLike,
    session: SessionBase,
    user?: Partial<UserBase>,
  ): Promise<Everything> {
    return this.adapter.createUserWithEverything(key, session, user)
  }

  update(id: number, update: Partial<UserBase>): Promise<null | User> {
    return this.adapter.updateUser(id, update)
  }
}
