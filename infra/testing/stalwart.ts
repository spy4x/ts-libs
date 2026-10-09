/**
 * Per-run users on the Stalwart container, through its JMAP admin API.
 *
 * Every run creates its own user, so its calendars cannot collide with another worktree's run
 * against the same container, and deletes it again in a `finally`. The recovery admin `admin`
 * (password {@link THROWAWAY_CREDENTIAL}) is set by `infra/compose.integration.yml` and
 * `.woodpecker.yml`; the container's setup script makes `example.com` its default domain.
 */

import { type CalDavServerSettings, THROWAWAY_CREDENTIAL } from "./services.ts"

/** The domain the container's setup script creates. Logins are `<name>@example.com`. */
const STALWART_DOMAIN = "example.com"

/** How long {@link createStalwartUser} waits for a container that is still starting. */
const READY_ATTEMPTS = 120
const READY_INTERVAL_MS = 500

/** A user created for one run. */
export interface StalwartUser {
  /** Stalwart's id for the account, the handle for {@link deleteStalwartUser}. */
  id: string
  /** The login, `<name>@example.com`. */
  username: string
  password: string
}

/** One JMAP request as the recovery admin; throws on any HTTP or method-level failure. */
async function jmap(
  settings: CalDavServerSettings,
  calls: [string, Record<string, unknown>, string][],
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${settings.baseUrl}/jmap/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`admin:${THROWAWAY_CREDENTIAL}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: calls,
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Stalwart JMAP answered ${response.status}: ${text}`)
  const replies = (JSON.parse(text) as { methodResponses: [string, Record<string, unknown>][] })
    .methodResponses
  for (const [name, result] of replies) {
    if (name === "error") throw new Error(`Stalwart JMAP error: ${JSON.stringify(result)}`)
  }
  return replies.map(([, result]) => result)
}

/**
 * Poll the liveness endpoint until the container's two-phase start has finished. Call it before
 * `requireReachable`: in CI the test step can start while Stalwart is still setting itself up.
 */
export async function waitForStalwart(settings: CalDavServerSettings): Promise<void> {
  let last = ""
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${settings.baseUrl}/healthz/live`)
      await response.body?.cancel()
      if (response.ok) return
      last = `status ${response.status}`
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS))
  }
  throw new Error(
    `Stalwart at ${settings.baseUrl} was not live after ${
      READY_ATTEMPTS * READY_INTERVAL_MS / 1000
    } s (${last}). Start it with \`deno task services:up\`, or point the test elsewhere with ` +
      settings.address.envName,
  )
}

/**
 * Create a user named `name` in the `example.com` domain, with {@link THROWAWAY_CREDENTIAL} as its
 * password. Pass a unique name (`uniqueIdentifier`) and delete the user in a `finally`.
 */
export async function createStalwartUser(
  settings: CalDavServerSettings,
  name: string,
): Promise<StalwartUser> {
  await waitForStalwart(settings)
  const [query] = await jmap(settings, [["x:Domain/query", {}, "0"]])
  const ids = query.ids as string[]
  const [domains] = await jmap(settings, [["x:Domain/get", { ids, properties: ["name"] }, "0"]])
  const domain = (domains.list as { id: string; name: string }[])
    .find((entry) => entry.name === STALWART_DOMAIN)
  if (!domain) throw new Error(`Stalwart has no ${STALWART_DOMAIN} domain; was its setup skipped?`)

  const [set] = await jmap(settings, [[
    "x:Account/set",
    {
      create: {
        user: {
          "@type": "User",
          name,
          domainId: domain.id,
          credentials: { "0": { "@type": "Password", secret: THROWAWAY_CREDENTIAL } },
        },
      },
    },
    "0",
  ]])
  const created = (set.created as Record<string, { id: string }> | null)?.user
  if (!created) throw new Error(`Stalwart did not create user ${name}: ${JSON.stringify(set)}`)
  return { id: created.id, username: `${name}@${STALWART_DOMAIN}`, password: THROWAWAY_CREDENTIAL }
}

/** Delete a user {@link createStalwartUser} made, with everything it owns. */
export async function deleteStalwartUser(
  settings: CalDavServerSettings,
  user: StalwartUser,
): Promise<void> {
  const [set] = await jmap(settings, [["x:Account/set", { destroy: [user.id] }, "0"]])
  if (!(set.destroyed as string[] | null)?.includes(user.id)) {
    throw new Error(`Stalwart did not delete user ${user.username}: ${JSON.stringify(set)}`)
  }
}
