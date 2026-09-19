/**
 * The anonymous provider, for a guest account that exists before it authenticates
 * with anything.
 *
 * An account created here has one key of kind `Anonymous` whose `identification`
 * is an opaque random id — never an email, never a device fingerprint. It is what
 * lets a product give a visitor a cart, a draft or a preference set without
 * asking them for anything, and it is deliberately the *weakest* key in the
 * system: the linking handlers drop it the moment the account authenticates with
 * a real method.
 */

import type { EventPublisher, ProviderDeps } from "./provider.ts"
import type { Everything, IAnonymousProvider } from "../types.ts"
import { EventKind } from "../events.ts"
import { KeyKind } from "../types.ts"
import { DEFAULT_ANONYMOUS_ID_LENGTH } from "../constants.ts"
import { getRandomString } from "../random.ts"

/** Options for `AnonymousProvider`. */
export interface AnonymousProviderOptions extends ProviderDeps {
  publish: EventPublisher
  /** Opaque id length. Defaults to 16 characters from a 36-letter alphabet. */
  idLength?: number
}

/** Guest accounts. */
export class AnonymousProvider implements IAnonymousProvider {
  private readonly deps: ProviderDeps
  private readonly publish: EventPublisher
  private readonly idLength: number

  constructor(options: AnonymousProviderOptions) {
    this.deps = options
    this.publish = options.publish
    this.idLength = options.idLength ?? DEFAULT_ANONYMOUS_ID_LENGTH
  }

  /** True when the account's only credential is an anonymous one. */
  async isAnonymous(userId: number): Promise<boolean> {
    const key = await this.deps.key.findByUserId({ userId, kind: KeyKind.Anonymous })
    return key !== null
  }

  /**
   * Create a guest account with a session.
   *
   * The session body is built first and handed to the adapter so account, key and
   * session are written together, then the *raw* token is put back on the returned
   * session. Without that step the caller receives the stored hash as if it were
   * the token, and the guest's cookie can never validate — the source's signup
   * paths did exactly that before this fix.
   */
  async signUp(): Promise<Everything> {
    const identification = getRandomString(this.idLength)
    const body = await this.deps.session.createBody({ userId: -1, keyId: -1 })
    const everything = await this.deps.user.createWithEverything(
      { kind: KeyKind.Anonymous, identification },
      body.session,
      { permission: null },
    )
    everything.session.token = body.notHashedToken
    await this.publish({
      kind: EventKind.MethodConnected,
      user: everything.user,
      key: everything.key,
      email: null,
      isNewUser: true,
    })
    return everything
  }

  /** Drop the guest credential. Leaves the account in place for whatever comes next. */
  async disconnect(userId: number): Promise<boolean> {
    const key = await this.deps.key.findByUserId({ userId, kind: KeyKind.Anonymous })
    if (!key) {
      return false
    }
    await this.deps.key.deleteById(key.id)
    return true
  }
}
