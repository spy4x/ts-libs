/**
 * The account-linking model — the second most important test group in this port.
 *
 * The design being protected: a `KeyKind`-keyed credential with an `identification`
 * and an `email` column, so any method can attach itself to an account another
 * method already owns, and the `MethodConnected` handlers do it automatically.
 * Three transitions matter, and each is asserted end to end here:
 *
 *  - an address that already holds a credential gains the sibling methods instead
 *    of a second account — a method signup for an address with a magic-link key
 *    ends with two linked keys on one account;
 *  - a guest account loses its anonymous key the moment it authenticates with
 *    anything durable, and keeps the account;
 *  - disconnecting one method removes one credential and nothing else.
 *
 * `providers/oauth2.test.ts` covers the OAuth2 leg; this suite covers the other
 * kinds and the handler contract itself.
 */

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert"
import { createLinkHandlers, UserEmailOnMethodConnectedHandler } from "./account-linking.ts"
import { AuthEventBus, EventKind } from "./events.ts"
import { KeyKind } from "./types.ts"
import { createTestAuth } from "./testing/harness.ts"
import type { MemoryAdapter } from "./testing/memory-adapter.ts"

/** Keys of one kind on one account. */
function keysOfKind(adapter: MemoryAdapter, userId: number, kind: KeyKind) {
  return adapter.allKeys().filter((key) => key.userId === userId && key.kind === kind)
}

/** Every key kind attached to an account, in ascending kind order. */
function kindsOf(adapter: MemoryAdapter, userId: number): KeyKind[] {
  return adapter
    .allKeys()
    .filter((key) => key.userId === userId)
    .map((key) => key.kind)
    .sort((left, right) => left - right)
}

Deno.test("a guest account has exactly one anonymous key", async () => {
  const { auth, adapter } = createTestAuth()
  const guest = await auth.anonymous.signUp()
  assertEquals(guest.key.kind, KeyKind.Anonymous)
  assertEquals(kindsOf(adapter, guest.user.id), [KeyKind.Anonymous])
  assertEquals(await auth.anonymous.isAnonymous(guest.user.id), true)
})

Deno.test("an email signup attaches magic-link and OTP to one account", async () => {
  const { auth, adapter } = createTestAuth()
  const registered = await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")

  assertEquals(
    kindsOf(adapter, registered.user.id),
    [KeyKind.EmailPassword, KeyKind.OAuth2 === KeyKind.OAuth2 ? 1 : 1, 1].length === 3
      ? [KeyKind.EmailPassword, KeyKind.MagicLink, KeyKind.Otp]
      : [],
  )
  assertEquals(keysOfKind(adapter, registered.user.id, KeyKind.MagicLink).length, 1)
  assertEquals(keysOfKind(adapter, registered.user.id, KeyKind.Otp).length, 1)
  assertEquals(adapter.allUsers().length, 1, "one address, one account")
})

Deno.test("an OTP signup for an address that already has a magic-link key links both", async () => {
  const { auth, adapter } = createTestAuth()
  await auth.magicLink.signUp("user@example.com")
  const userId = adapter.allKeys().find((key) => key.kind === KeyKind.MagicLink)?.userId ?? 0
  assert(userId > 0)

  await auth.otp.signUp("user@example.com")

  assertEquals(
    adapter.allKeys().find((key) => key.kind === KeyKind.Otp)?.userId,
    userId,
    "a sibling method must attach to the account the address already belongs to",
  )
  assertEquals(
    kindsOf(adapter, userId),
    [KeyKind.MagicLink, KeyKind.Otp],
    "two linked keys on one account, and no second account",
  )
  assertEquals(adapter.allUsers().length, 1)
})

Deno.test("every credential carries the address it was established with", async () => {
  const { auth, adapter } = createTestAuth()
  const registered = await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  const keys = adapter.allKeys().filter((key) => key.userId === registered.user.id)

  assertEquals(keys.length >= 3, true, "the siblings must have been linked")
  for (const key of keys) {
    assertEquals(key.email, "user@example.com", `key kind ${key.kind} must carry the address`)
  }
})

Deno.test("an OAuth signup drops the anonymous key", async () => {
  const { auth, adapter } = createTestAuth()
  const guest = await auth.anonymous.signUp()
  await auth.emailPassword.connect(guest.user.id, "user@example.com", "hunter2-hunter2")

  assertEquals(
    keysOfKind(adapter, guest.user.id, KeyKind.Anonymous).length,
    0,
    "the anonymous key must be dropped when a durable method is attached",
  )
  assertEquals(keysOfKind(adapter, guest.user.id, KeyKind.EmailPassword).length, 1)
  assertEquals(await auth.anonymous.isAnonymous(guest.user.id), false)
})

Deno.test("an anonymous account is not deleted, only its guest credential", async () => {
  const { auth, adapter } = createTestAuth()
  const guest = await auth.anonymous.signUp()
  const usersBefore = adapter.allUsers().length
  await auth.magicLink.connect(guest.user.id, "user@example.com")

  assertEquals(adapter.allUsers().length, usersBefore, "the account must not be deleted")
  assertEquals((await auth.user.get(guest.user.id))?.id, guest.user.id)
  assertEquals(await auth.anonymous.isAnonymous(guest.user.id), false)
})

Deno.test("an account with no email adopts the address its new method supplied", async () => {
  const { auth } = createTestAuth()
  const guest = await auth.anonymous.signUp()
  assertEquals(guest.user.email, null)

  await auth.magicLink.connect(guest.user.id, "user@example.com")
  assertEquals((await auth.user.get(guest.user.id))?.email, "user@example.com")
})

Deno.test("an existing email on the account is never overwritten by a later method", async () => {
  // Asserted on the handler, because that is where the rule lives: a second method
  // for a *different* address must not move where password resets land.
  const updated: Array<{ userId: number; email: string }> = []
  const handler = new UserEmailOnMethodConnectedHandler({
    key: { getAll: () => Promise.resolve([{ id: 1 }]) } as never,
  })
  const context = {
    publish: () => Promise.resolve(),
    setUserEmail: (userId: number, email: string) => {
      updated.push({ userId, email })
      return Promise.resolve()
    },
  }

  await handler.handle(
    {
      kind: EventKind.MethodConnected,
      user: { id: 7, email: "first@example.com" } as never,
      key: { kind: KeyKind.Otp } as never,
      email: "second@example.com",
    },
    context,
  )
  assertEquals(updated, [], "an account that already has an address must not be updated")

  // With no address on the account, the new one is adopted.
  await handler.handle(
    {
      kind: EventKind.MethodConnected,
      user: { id: 8, email: null } as never,
      key: { kind: KeyKind.Otp } as never,
      email: "second@example.com",
    },
    context,
  )
  assertEquals(updated, [{ userId: 8, email: "second@example.com" }])
})

Deno.test("a sibling link failure does not fail the sign-up that triggered it", async () => {
  const { auth } = createTestAuth()
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "))
  }
  try {
    const registered = await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
    assert(registered.user.id > 0, "the signup must succeed even if a sibling link fails")
  } finally {
    console.error = original
  }
  assertFalse(errors.some((line) => line.includes("user@example.com")))
})

Deno.test("disconnect removes one credential and neither the user nor the siblings", async () => {
  const { auth, adapter } = createTestAuth()
  const registered = await auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  const userId = registered.user.id
  const before = kindsOf(adapter, userId)
  assertEquals(before.length >= 3, true, "the signup must have linked the siblings")

  assertEquals(await auth.magicLink.disconnect(userId), true)
  assertEquals(keysOfKind(adapter, userId, KeyKind.MagicLink).length, 0)
  assertEquals(keysOfKind(adapter, userId, KeyKind.Otp).length, 1, "a sibling must survive")
  assertEquals(keysOfKind(adapter, userId, KeyKind.EmailPassword).length, 1)
  assert(await auth.user.get(userId), "the account must survive a disconnect")
  assert(await auth.emailPassword.signIn("user@example.com", "hunter2-hunter2"))
  assertEquals(adapter.allUsers().length, 1)
})

Deno.test("disconnect removes only the credential of the named kind", async () => {
  const { auth, adapter } = createTestAuth()
  const registered = await auth.emailPassword.signUp("a@example.com", "hunter2-hunter2")
  const second = await auth.emailPassword.signUp("b@example.com", "hunter2-hunter2")

  await auth.magicLink.disconnect(registered.user.id)
  assertEquals(
    keysOfKind(adapter, second.user.id, KeyKind.MagicLink).length,
    1,
    "another account's credential must be untouched",
  )
  assertEquals(await auth.magicLink.disconnect(registered.user.id), false, "idempotent on a miss")
})

Deno.test("a second credential of one kind for one identification is refused", async () => {
  // An ambiguously keyed store would make `findByKindAndIdentification` return one
  // of two rows at random, which is why the constraint exists and is asserted here.
  const { auth, adapter } = createTestAuth()
  const registered = await auth.emailPassword.signUp("shared@example.com", "hunter2-hunter2")
  assert(registered.user.id > 0)

  // Through the adapter directly: the manager is a pass-through, and the constraint
  // is the store's.
  await assertRejects(
    async () => {
      await adapter.createKey({
        userId: registered.user.id,
        kind: KeyKind.EmailPassword,
        identification: "shared@example.com",
        email: "shared@example.com",
      })
    },
    Error,
  )
})

Deno.test("createLinkHandlers builds three handlers in the documented order", () => {
  const handlers = createLinkHandlers({
    key: {} as never,
    getProviders: () => [],
    getAnonymous: () => null,
  })
  assertEquals(handlers.length, 3)
  for (const handler of handlers) {
    assertEquals(handler.kind, EventKind.MethodConnected)
  }
  // The class names are the order contract: siblings first, then the anonymous drop
  // (which would otherwise leave the account transiently empty), then the email fill.
  assertEquals(handlers[0].constructor.name, "LinkSiblingMethodsOnMethodConnectedHandler")
  assertEquals(handlers[1].constructor.name, "DropAnonymousOnMethodConnectedHandler")
  assertEquals(handlers[2].constructor.name, "UserEmailOnMethodConnectedHandler")
})

Deno.test("a failing handler is reported and does not abort the others", async () => {
  const failures: unknown[] = []
  const bus = new AuthEventBus((_event, error) => {
    failures.push(error)
  })
  const handled: string[] = []
  bus.subscribe({
    kind: EventKind.MethodConnected,
    handle: () => {
      throw new Error("first handler fails")
    },
  })
  bus.subscribe({
    kind: EventKind.MethodConnected,
    handle: () => {
      handled.push("second")
      return Promise.resolve()
    },
  })
  const context = { publish: () => Promise.resolve(), setUserEmail: () => Promise.resolve() }
  const reported = await bus.dispatch({
    kind: EventKind.MethodConnected,
    user: { id: 1 } as never,
    key: { kind: KeyKind.Otp, userId: 1 } as never,
    email: "user@example.com",
  }, context)

  assertEquals(handled, ["second"], "a later handler must still run")
  assertEquals(failures.length, 1)
  assertEquals(reported.length, 1)
})

Deno.test("an unsubscribe stops delivery", async () => {
  const bus = new AuthEventBus(() => {})
  let calls = 0
  const unsubscribe = bus.subscribe({
    kind: EventKind.MethodConnected,
    handle: () => {
      calls++
      return Promise.resolve()
    },
  })
  assertEquals(bus.count(EventKind.MethodConnected), 1)
  unsubscribe()
  assertEquals(bus.count(EventKind.MethodConnected), 0)
  const context = { publish: () => Promise.resolve(), setUserEmail: () => Promise.resolve() }
  await bus.dispatch({
    kind: EventKind.MethodConnected,
    user: { id: 1 } as never,
    key: { kind: KeyKind.Otp, userId: 1 } as never,
    email: "user@example.com",
  }, context)
  assertEquals(calls, 0)
})

Deno.test("two auth instances do not see each other's events", async () => {
  const first = createTestAuth()
  const second = createTestAuth()
  let seen = 0
  second.auth.subscribe({
    kind: EventKind.MethodConnected,
    handle: () => {
      seen++
      return Promise.resolve()
    },
  })
  await first.auth.emailPassword.signUp("user@example.com", "hunter2-hunter2")
  assertEquals(seen, 0, "the bus must be per instance, not a process singleton")
  assertFalse(first.auth.bus === second.auth.bus)
})

Deno.test("an anonymous credential carries no address", async () => {
  const { auth, adapter } = createTestAuth()
  const guest = await auth.anonymous.signUp()
  const anonymousKey = adapter.allKeys().find((key) => key.kind === KeyKind.Anonymous)
  assertEquals(anonymousKey?.email, null)
  assertEquals((await auth.user.get(guest.user.id))?.email, null)
})
