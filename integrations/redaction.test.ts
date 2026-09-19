import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { MailchimpClient } from "./mailchimp.ts"
import { SlackClient } from "./slack.ts"

/**
 * Every client failure must be free of the credential the client was configured
 * with.
 *
 * This is a regression guard over a defect that shipped three times: each
 * client returned `cause.message` from its transport catch, and `fetch` puts
 * the whole request URL into that message. For Slack the credential is the last
 * path segment; for healthchecks it is the check's capability key; for ntfy it
 * is a path segment of the base URL. Nothing about the type system stops a
 * fourth call site from being written the same way, so each client is driven to
 * a URL-bearing transport failure and its serialised result is asserted clean.
 *
 * The token is a distinctive marker rather than a realistic key, so a hit is
 * unambiguous and no credential-shaped string appears in this repo.
 */

/** Stands in for the credential, in a position no sanitised result can contain. */
const TOKEN = "REALTOKENISH"

/** What the platform throws for a URL it cannot parse — URL included. */
const urlBearingFailure = (url: string) => () =>
  Promise.reject(new TypeError(`Invalid URL: '${url}'`))

const CONFIG = {
  apiKey: "test-key-not-real",
  username: "test-user-not-real",
  listId: "test-list-not-real",
  serverPrefix: "example",
}

const assertClean = (label: string, result: unknown): void => {
  const serialised = JSON.stringify(result)
  const entry = { label, leaksToken: serialised.includes(TOKEN) }
  expect(entry).toEqual({ label, leaksToken: false })
  // The host is a leak too: a token is useless without knowing where to post it.
  expect({ label, leaksHost: serialised.includes("example.invalid") }).toEqual({
    label,
    leaksHost: false,
  })
}

describe("no client failure leaks the configured credential", () => {
  it("keeps the Slack webhook token out of a transport failure", async () => {
    const url = `https://hooks.slack.example.invalid/services/T000/B000/${TOKEN}`
    const client = new SlackClient({ webhookUrl: url }, {
      fetcher: urlBearingFailure(url),
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result.ok).toBe(false)
    assertClean("slack transport", result)
  })

  it("keeps the Mailchimp key out of a transport failure", async () => {
    const url = `https://example.invalid/${TOKEN}/3.0`
    const client = new MailchimpClient(CONFIG, {
      fetcher: urlBearingFailure(url),
      retry: { maxAttempts: 1 },
    })
    assertClean("mailchimp upsert", await client.putContact({ email: "a@example.invalid" }))
    assertClean("mailchimp lookup", await client.searchContact("a@example.invalid"))
  })

  it("keeps a caller-supplied payload's own text out of an invalid-payload failure", async () => {
    // `JSON.stringify` on a payload with a hostile `toJSON` throws text the
    // caller controls, so the message must not be forwarded into a result.
    const payload = {
      toJSON: () => {
        throw new TypeError(`Invalid URL: 'https://hooks.slack.example.invalid/${TOKEN}'`)
      },
    }
    const client = new SlackClient({
      webhookUrl: "https://hooks.slack.example.invalid/services/T/B",
    })
    const result = await client.send(payload)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe("invalid_payload")
    assertClean("slack unserialisable payload", result)
  })

  it("still names a transport failure, so the results stay diagnosable", async () => {
    const url = `https://hooks.slack.example.invalid/services/T000/B000/${TOKEN}`
    const client = new SlackClient({ webhookUrl: url }, {
      fetcher: urlBearingFailure(url),
      retry: { maxAttempts: 1 },
    })
    const result = await client.send({ text: "hello" })
    expect(result.ok === false && result.message).toBe(
      "TypeError: transport failure (url withheld)",
    )
  })
})
