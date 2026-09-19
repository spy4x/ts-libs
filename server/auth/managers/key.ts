/**
 * Credential (key) manager.
 *
 * The only substantive change from `roley/managers/key.ts` is that a key always
 * carries `userId` on create: the source typed `create` as optional-userId and
 * every caller passed one, so a key could be created detached from any user by a
 * caller that simply left the field out. `KeyKind`-keyed keys with an
 * `identification` are what make account linking work, and a key with no owner
 * cannot be linked.
 */

import type { Adapter, IKeyManager, Key, KeyBase, NewKeyLike } from "../types.ts"
import { KeyKind } from "../types.ts"

/** The fields a caller must supply to attach a credential to an existing user. */
export type NewKey = NewKeyLike & Pick<KeyBase, "userId">

/** Reads and writes credentials, scoped to a `KeyKind` and an identification value. */
export class KeyManager implements IKeyManager {
  constructor(private readonly adapter: Adapter) {}

  get(keyId: number): Promise<null | Key> {
    return this.adapter.getKey(keyId)
  }

  getAll(userId: number): Promise<Key[]> {
    return this.adapter.getAllKeys(userId)
  }

  findByIdentification(identification: KeyBase["identification"]): Promise<null | Key> {
    return this.adapter.findKeyByIdentification(identification)
  }

  findByEmail(email: string): Promise<null | Key> {
    return this.adapter.findKeyByEmail(email)
  }

  findByKindAndIdentification(
    key: Pick<KeyBase, "kind" | "identification">,
  ): Promise<null | Key> {
    return this.adapter.findKeyByKindAndIdentification(key)
  }

  findByUserId(key: Pick<KeyBase, "kind" | "userId">): Promise<null | Key> {
    return this.adapter.findKeyByUserId(key)
  }

  create(key: NewKey): Promise<null | Key> {
    return this.adapter.createKey(key)
  }

  update(keyId: number, key: Partial<KeyBase>): Promise<null | Key> {
    return this.adapter.updateKey(keyId, key)
  }

  deleteById(keyId: number): Promise<void> {
    return this.adapter.deleteKeyById(keyId)
  }

  delete(key: Pick<KeyBase, "userId" | "kind">): Promise<boolean> {
    return this.adapter.deleteKey(key)
  }

  /**
   * Attach a credential of `kind` to the account that already owns
   * `identification` under any other kind, or report that no such account exists.
   *
   * This is the operation the whole linking model is built on: an email that
   * authenticates with a new provider must land on the account that email already
   * belongs to, never beside it. `existing` is the cross-kind match the caller
   * looked up; the `kind` argument is the one being attached, and a match of the
   * same kind means the credential is already there rather than missing.
   */
  async attachToExistingUser(
    identification: string,
    existing: Key | null,
    kind: KeyKind,
  ): Promise<boolean> {
    if (!existing || existing.kind === kind) {
      return false
    }
    await this.adapter.createKey({
      userId: existing.userId,
      kind,
      identification,
    })
    return true
  }
}
