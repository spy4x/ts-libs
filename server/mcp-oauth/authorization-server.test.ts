/// <reference lib="deno.unstable" />
import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { encodeBase64Url } from "@std/encoding/base64url"
import { randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import {
  type AuthorizationServerOptions,
  createAuthorizationServer,
  defaultConsentPage,
  OWNER_PASSWORD_FIELD,
} from "./authorization-server.ts"
import {
  createPasswordHasher,
  MIN_PASSWORD_ITERATIONS,
  type PasswordHasher,
} from "../sign-in/password.ts"
import type { ClientMetadataSource } from "./client-metadata.ts"
import { KvOAuthStore } from "./kv-store.ts"
import { MemoryOAuthStore } from "./memory-store.ts"
import { OAuthStoreContentionError } from "./model.ts"
import { CLAUDE_REDIRECT_URI } from "./redirect-uri.ts"
import { createResourceServer, type ResourceGuardEnv } from "./resource-server.ts"

const ISSUER = "https://auth.example.com"
const RESOURCE = "https://mcp.example.com/mcp"
const OTHER_RESOURCE = "https://other.example.com/mcp"
const CLAUDE = "https://claude.example/oauth/client-metadata"
const CLAUDE_CODE = "https://claude.example/oauth/claude-code-client-metadata"

const clients: ClientMetadataSource = {
  load(clientId) {
    if (clientId === CLAUDE) {
      return Promise.resolve({
        clientId,
        clientName: "Claude",
        redirectUris: [CLAUDE_REDIRECT_URI, "https://evil.example/cb"],
      })
    }
    if (clientId === CLAUDE_CODE) {
      return Promise.resolve({
        clientId,
        clientName: "Claude Code",
        redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      })
    }
    return Promise.resolve(undefined)
  },
}

/** An invented owner password and its hash; the lowest iteration count keeps the tests fast. */
const OWNER_PASSWORD = "an invented owner password"
const hasher = createPasswordHasher({
  pepper: "an-invented-test-pepper-0123456789abcdef",
  iterations: MIN_PASSWORD_ITERATIONS,
})
const ownerPassword = { hash: await hasher.hash(OWNER_PASSWORD), hasher }

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return encodeBase64Url(new Uint8Array(digest))
}

function setup(overrides: Partial<AuthorizationServerOptions> = {}) {
  let now = 1_000_000
  const clock = { now: () => now }
  const store = new MemoryOAuthStore({ clock })
  const server = createAuthorizationServer({
    issuer: ISSUER,
    resources: [RESOURCE, OTHER_RESOURCE],
    store,
    clients,
    scopes: ["tasks"],
    clock,
    confirmOwner: (c) => c.req.header("remote-user") === "owner",
    ...overrides,
  })
  const app = new Hono()
  app.route("/", server.app)
  const mcp = new Hono<ResourceGuardEnv>()
  const rs = createResourceServer({ resource: RESOURCE, issuer: ISSUER, verifier: server.verifier })
  mcp.use("/mcp", rs.guard)
  mcp.post("/mcp", (c) => c.json({ ok: true, scope: c.var.oauth.scope }))
  const other = new Hono<ResourceGuardEnv>()
  const ors = createResourceServer({
    resource: OTHER_RESOURCE,
    issuer: ISSUER,
    verifier: server.verifier,
  })
  other.use("/mcp", ors.guard)
  other.post("/mcp", (c) => c.json({ ok: true }))

  const verifier = randomBase64Url(32)

  async function authorizeParams(extra: Record<string, string | undefined> = {}) {
    const params: Record<string, string | undefined> = {
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_challenge: await challengeOf(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: "state-123",
      scope: "tasks",
      ...extra,
    }
    const query = new URLSearchParams()
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) query.set(name, value)
    }
    return query
  }

  function getAuthorize(query: URLSearchParams, owner = true) {
    return app.request(`${ISSUER}/authorize?${query}`, {
      headers: owner ? { "remote-user": "owner" } : {},
    })
  }

  function postConsent(
    body: Record<string, string>,
    headers: Record<string, string> = { origin: ISSUER, "sec-fetch-site": "same-origin" },
  ) {
    return app.request(`${ISSUER}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "remote-user": "owner",
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    })
  }

  async function consentId(response: Response): Promise<string> {
    expect(response.status).toBe(200)
    const match = /name="consent_id" value="([^"]+)"/.exec(await response.text())
    if (!match) throw new Error("consent page has no consent_id")
    return match[1]
  }

  /** Runs the browser part and returns the redirect URL carrying the code. */
  async function approve(extra: Record<string, string | undefined> = {}): Promise<URL> {
    const id = await consentId(await getAuthorize(await authorizeParams(extra)))
    const response = await postConsent({ consent_id: id, decision: "approve" })
    expect(response.status).toBe(302)
    return new URL(response.headers.get("location")!)
  }

  function token(body: Record<string, string>, headers: Record<string, string> = {}) {
    return app.request(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    })
  }

  function redeem(code: string, extra: Record<string, string> = {}) {
    return token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_REDIRECT_URI,
      resource: RESOURCE,
      ...extra,
    })
  }

  function callMcp(accessToken: string, target: Hono<ResourceGuardEnv> = mcp, url = RESOURCE) {
    return target.request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    })
  }

  return {
    app,
    other,
    server,
    store,
    verifier,
    advance: (ms: number) => (now += ms),
    authorizeParams,
    getAuthorize,
    postConsent,
    consentId,
    approve,
    token,
    redeem,
    callMcp,
  }
}

/**
 * After a replay raced the first redemption, no token may work: every response is refused, or the
 * tokens it carries are refused by the guard and by the token endpoint.
 */
async function expectNoWorkingToken(t: ReturnType<typeof setup>, responses: Response[]) {
  let refused = 0
  for (const response of responses) {
    const body = await response.json()
    if (response.status !== 200) {
      expect(body.error).toBe("invalid_grant")
      refused++
      continue
    }
    expect((await t.callMcp(body.access_token)).status).toBe(401)
    const refresh = await t.token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
      client_id: CLAUDE,
    })
    expect((await refresh.json()).error).toBe("invalid_grant")
  }
  expect(refused).toBeGreaterThanOrEqual(1)
}

describe("createAuthorizationServer", () => {
  it("completes a full flow: consent, code, tokens, a guarded call and a refresh", async () => {
    const t = setup()
    const page = await t.getAuthorize(await t.authorizeParams())
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    )
    const html = await page.clone().text()
    expect(html).toContain("claude.example")
    expect(html).toContain("claude.ai")
    const id = await t.consentId(page)

    const approved = await t.postConsent({ consent_id: id, decision: "approve" })
    expect(approved.status).toBe(302)
    const callback = new URL(approved.headers.get("location")!)
    expect(callback.origin + callback.pathname).toBe(CLAUDE_REDIRECT_URI)
    expect(callback.searchParams.get("state")).toBe("state-123")
    expect(callback.searchParams.get("iss")).toBe(ISSUER)
    const code = callback.searchParams.get("code")!

    const issued = await t.redeem(code)
    expect(issued.status).toBe(200)
    expect(issued.headers.get("cache-control")).toBe("no-store")
    const tokens = await issued.json()
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.expires_in).toBe(900)
    expect(tokens.scope).toBe("tasks")

    const call = await t.callMcp(tokens.access_token)
    expect(call.status).toBe(200)
    expect(await call.json()).toEqual({ ok: true, scope: "tasks" })

    const refreshed = await t.token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE,
      resource: RESOURCE,
    })
    expect(refreshed.status).toBe(200)
    const next = await refreshed.json()
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await t.callMcp(next.access_token)).status).toBe(200)
  })

  it("serves metadata that makes Claude pick CIMD with S256 PKCE", async () => {
    const t = setup()
    const response = await t.app.request(`${ISSUER}/.well-known/oauth-authorization-server`)
    expect(await response.json()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      revocation_endpoint: `${ISSUER}/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["tasks"],
    })
  })

  it("accepts Claude Code's loopback redirect on any port", async () => {
    const t = setup()
    const callback = await t.approve({
      client_id: CLAUDE_CODE,
      redirect_uri: "http://localhost:53682/callback",
    })
    expect(callback.host).toBe("localhost:53682")
    const issued = await t.redeem(callback.searchParams.get("code")!, {
      client_id: CLAUDE_CODE,
      redirect_uri: "http://localhost:53682/callback",
    })
    expect(issued.status).toBe(200)
  })

  it("warns on the consent page when the code goes to a loopback address", async () => {
    const t = setup()
    const page = await t.getAuthorize(
      await t.authorizeParams({
        client_id: CLAUDE_CODE,
        redirect_uri: "http://127.0.0.1:4000/callback",
      }),
    )
    expect(await page.text()).toContain("a program on this computer")
  })

  it("asks the owner to approve only a sign-in they started, for every client", async () => {
    const t = setup()
    const html = await (await t.getAuthorize(await t.authorizeParams())).text()
    expect(html).toContain("Approve only if you just started this sign-in yourself.")
    expect(html).not.toContain("a program on this computer")
  })

  describe("refuses the authorization request", () => {
    it("on a host other than the issuer's, even with a forged Remote-User", async () => {
      const t = setup()
      const query = await t.authorizeParams()
      const response = await t.app.request(`https://mcp.example.com/authorize?${query}`, {
        headers: { "remote-user": "owner" },
      })
      expect(response.status).toBe(403)
    })

    it("when the owner is not confirmed, and stores nothing", async () => {
      const t = setup()
      const response = await t.getAuthorize(await t.authorizeParams(), false)
      expect(response.status).toBe(403)
      expect(response.headers.get("location")).toBeNull()
    })

    it("for an unknown client, without redirecting", async () => {
      const t = setup()
      const query = await t.authorizeParams({ client_id: "https://unknown.example/client" })
      const response = await t.getAuthorize(query)
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
    })

    it("for a redirect URI the client lists but the allowlist does not, without redirecting", async () => {
      const t = setup()
      const query = await t.authorizeParams({ redirect_uri: "https://evil.example/cb" })
      const response = await t.getAuthorize(query)
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
    })

    it("for an allowlisted redirect URI the client does not list, without redirecting", async () => {
      const t = setup()
      const query = await t.authorizeParams({ redirect_uri: "http://localhost:4000/callback" })
      const response = await t.getAuthorize(query)
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
    })

    it("for a redirect URI that differs from the registered one only by a suffix", async () => {
      const t = setup()
      const query = await t.authorizeParams({ redirect_uri: `${CLAUDE_REDIRECT_URI}/x` })
      expect((await t.getAuthorize(query)).status).toBe(400)
    })

    it("when a parameter is repeated", async () => {
      const t = setup()
      const query = await t.authorizeParams()
      query.append("state", "second")
      expect((await t.getAuthorize(query)).status).toBe(400)
    })

    async function redirectError(
      extra: Record<string, string | undefined>,
    ): Promise<URLSearchParams> {
      const t = setup()
      const response = await t.getAuthorize(await t.authorizeParams(extra))
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get("location")!)
      expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT_URI)
      expect(location.searchParams.get("state")).toBe("state-123")
      expect(location.searchParams.get("code")).toBeNull()
      return location.searchParams
    }

    it("without PKCE", async () => {
      const params = await redirectError({
        code_challenge: undefined,
        code_challenge_method: undefined,
      })
      expect(params.get("error")).toBe("invalid_request")
    })

    it("with a challenge but no method, which would mean plain", async () => {
      const params = await redirectError({ code_challenge_method: undefined })
      expect(params.get("error")).toBe("invalid_request")
    })

    it("with plain PKCE", async () => {
      const params = await redirectError({
        code_challenge_method: "plain",
        code_challenge: randomBase64Url(32),
      })
      expect(params.get("error")).toBe("invalid_request")
    })

    it("with a challenge that is not an S256 digest", async () => {
      const params = await redirectError({ code_challenge: "short" })
      expect(params.get("error")).toBe("invalid_request")
    })

    it("without a resource", async () => {
      const params = await redirectError({ resource: undefined })
      expect(params.get("error")).toBe("invalid_target")
    })

    it("for a resource this server does not serve", async () => {
      const params = await redirectError({ resource: "https://elsewhere.example/mcp" })
      expect(params.get("error")).toBe("invalid_target")
    })

    it("for an unknown scope", async () => {
      const params = await redirectError({ scope: "tasks admin" })
      expect(params.get("error")).toBe("invalid_scope")
    })

    it("for a response type other than code", async () => {
      const params = await redirectError({ response_type: "token" })
      expect(params.get("error")).toBe("unsupported_response_type")
    })
  })

  describe("refuses the consent submission", () => {
    it("on a host other than the issuer's, even with forged headers", async () => {
      const t = setup()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      const forged = await t.app.request("https://mcp.example.com/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "remote-user": "owner",
          origin: ISSUER,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ consent_id: id, decision: "approve" }).toString(),
      })
      expect(forged.status).toBe(403)
      expect(forged.headers.get("location")).toBeNull()
    })

    it("from another site", async () => {
      const t = setup()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      const response = await t.postConsent(
        { consent_id: id, decision: "approve" },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      )
      expect(response.status).toBe(403)
      expect(response.headers.get("location")).toBeNull()
    })

    it("when the owner is not confirmed", async () => {
      const t = setup({ confirmOwner: (c) => c.req.method === "GET" })
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      const response = await t.postConsent({ consent_id: id, decision: "approve" })
      expect(response.status).toBe(403)
    })

    it("a second time with the same consent id", async () => {
      const t = setup()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      expect((await t.postConsent({ consent_id: id, decision: "approve" })).status).toBe(302)
      expect((await t.postConsent({ consent_id: id, decision: "approve" })).status).toBe(400)
    })

    it("after the consent page expired", async () => {
      const t = setup()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      t.advance(10 * 60_000)
      expect((await t.postConsent({ consent_id: id, decision: "approve" })).status).toBe(400)
    })

    it("for an unknown consent id", async () => {
      const t = setup()
      const response = await t.postConsent({ consent_id: "nope", decision: "approve" })
      expect(response.status).toBe(400)
    })
  })

  it("redirects with access_denied when the owner denies", async () => {
    const t = setup()
    const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
    const response = await t.postConsent({ consent_id: id, decision: "deny" })
    const location = new URL(response.headers.get("location")!)
    expect(location.searchParams.get("error")).toBe("access_denied")
    expect(location.searchParams.get("code")).toBeNull()
  })

  describe("with an owner password", () => {
    const withPassword = () => setup({ confirmOwner: undefined, ownerPassword })

    it("shows the consent page without forward-auth, with a labelled password input", async () => {
      const t = withPassword()
      const page = await t.getAuthorize(await t.authorizeParams(), false)
      expect(page.status).toBe(200)
      const html = await page.clone().text()
      expect(html).toContain(`<label for="owner-password">Owner password</label>`)
      expect(html).toMatch(
        /<input id="owner-password" type="password" name="owner_password" autocomplete="current-password">/,
      )
      expect(html).not.toContain(`role="alert"`)
    })

    it("approves with the right password", async () => {
      const t = withPassword()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams(), false))
      const response = await t.postConsent({
        consent_id: id,
        decision: "approve",
        [OWNER_PASSWORD_FIELD]: OWNER_PASSWORD,
      })
      expect(response.status).toBe(302)
      const code = new URL(response.headers.get("location")!).searchParams.get("code")!
      expect((await t.redeem(code)).status).toBe(200)
    })

    it("shows the page again with an accessible error on a wrong password, and the consent still works", async () => {
      const t = withPassword()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams(), false))
      const wrong = await t.postConsent({
        consent_id: id,
        decision: "approve",
        [OWNER_PASSWORD_FIELD]: "an invented wrong password",
      })
      expect(wrong.status).toBe(403)
      expect(wrong.headers.get("location")).toBeNull()
      expect(wrong.headers.get("x-frame-options")).toBe("DENY")
      const html = await wrong.text()
      expect(html).toContain(
        `<p id="owner-password-error" role="alert">Wrong password. Try again.</p>`,
      )
      expect(html).toContain(`aria-invalid="true" aria-describedby="owner-password-error"`)
      expect(html).toContain(`name="consent_id" value="${id}"`)
      const right = await t.postConsent({
        consent_id: id,
        decision: "approve",
        [OWNER_PASSWORD_FIELD]: OWNER_PASSWORD,
      })
      expect(right.status).toBe(302)
      expect(new URL(right.headers.get("location")!).searchParams.get("code")).not.toBeNull()
    })

    it("shows the page again on an empty password, and the consent still works", async () => {
      const t = withPassword()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams(), false))
      const bodies: Record<string, string>[] = [{}, { [OWNER_PASSWORD_FIELD]: "" }]
      for (const body of bodies) {
        const empty = await t.postConsent({ consent_id: id, decision: "approve", ...body })
        expect(empty.status).toBe(400)
        expect(await empty.text()).toContain(`role="alert">Enter the owner password.</p>`)
      }
      const right = await t.postConsent({
        consent_id: id,
        decision: "approve",
        [OWNER_PASSWORD_FIELD]: OWNER_PASSWORD,
      })
      expect(right.status).toBe(302)
    })

    it("denies without a password", async () => {
      const t = withPassword()
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams(), false))
      const response = await t.postConsent({ consent_id: id, decision: "deny" })
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get("location")!)
      expect(location.searchParams.get("error")).toBe("access_denied")
    })

    it("requires both confirmOwner and the password when both are set", async () => {
      const t = setup({ ownerPassword })
      expect((await t.getAuthorize(await t.authorizeParams(), false)).status).toBe(403)
      const id = await t.consentId(await t.getAuthorize(await t.authorizeParams()))
      const noPassword = await t.postConsent({ consent_id: id, decision: "approve" })
      expect(noPassword.status).toBe(400)
      const notOwner = await t.app.request(`${ISSUER}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          consent_id: id,
          decision: "approve",
          [OWNER_PASSWORD_FIELD]: OWNER_PASSWORD,
        }).toString(),
      })
      expect(notOwner.status).toBe(403)
      const both = await t.postConsent({
        consent_id: id,
        decision: "approve",
        [OWNER_PASSWORD_FIELD]: OWNER_PASSWORD,
      })
      expect(both.status).toBe(302)
    })

    describe("caps wrong passwords", () => {
      /** The shared hasher, counting how often it checks a password. */
      function countingHasher() {
        const counter = { verifies: 0 }
        const counted: PasswordHasher = {
          hash: (password) => hasher.hash(password),
          verify: (password, stored) => {
            counter.verifies++
            return hasher.verify(password, stored)
          },
        }
        return { counter, ownerPassword: { hash: ownerPassword.hash, hasher: counted } }
      }
      const WRONG = "an invented wrong password"
      const approve = (t: ReturnType<typeof setup>, id: string, password: string) =>
        t.postConsent({ consent_id: id, decision: "approve", [OWNER_PASSWORD_FIELD]: password })
      const newConsent = async (t: ReturnType<typeof setup>) =>
        await t.consentId(await t.getAuthorize(await t.authorizeParams(), false))

      it("refuses approvals with 429 and Retry-After after maxFailures wrong passwords, until the window ends, then counts again", async () => {
        const t = setup({
          confirmOwner: undefined,
          ownerPassword: { ...ownerPassword, maxFailures: 3, windowMs: 60_000 },
        })
        const id = await newConsent(t)
        for (let i = 0; i < 3; i++) expect((await approve(t, id, WRONG)).status).toBe(403)
        const locked = await approve(t, id, OWNER_PASSWORD)
        expect(locked.status).toBe(429)
        expect(locked.headers.get("retry-after")).toBe("60")
        t.advance(59_000)
        const stillLocked = await approve(t, id, OWNER_PASSWORD)
        expect(stillLocked.status).toBe(429)
        expect(stillLocked.headers.get("retry-after")).toBe("1")
        t.advance(1_000)
        for (let i = 0; i < 3; i++) expect((await approve(t, id, WRONG)).status).toBe(403)
        expect((await approve(t, id, OWNER_PASSWORD)).status).toBe(429)
        t.advance(60_000)
        expect((await approve(t, id, OWNER_PASSWORD)).status).toBe(302)
      })

      it("locks out after 10 wrong passwords for 15 minutes by default", async () => {
        const t = withPassword()
        const id = await newConsent(t)
        for (let i = 0; i < 10; i++) expect((await approve(t, id, WRONG)).status).toBe(403)
        const locked = await approve(t, id, OWNER_PASSWORD)
        expect(locked.status).toBe(429)
        expect(locked.headers.get("retry-after")).toBe("900")
      })

      it("does not run the hasher while locked out", async () => {
        const { counter, ownerPassword } = countingHasher()
        const t = setup({
          confirmOwner: undefined,
          ownerPassword: { ...ownerPassword, maxFailures: 2 },
        })
        const id = await newConsent(t)
        for (let i = 0; i < 2; i++) await approve(t, id, WRONG)
        expect(counter.verifies).toBe(2)
        for (let i = 0; i < 5; i++) expect((await approve(t, id, WRONG)).status).toBe(429)
        expect(counter.verifies).toBe(2)
      })

      it("runs the hasher at most maxFailures times for wrong passwords sent in parallel", async () => {
        const { counter, ownerPassword } = countingHasher()
        const t = setup({
          confirmOwner: undefined,
          ownerPassword: { ...ownerPassword, maxFailures: 3 },
        })
        const ids = await Promise.all(Array.from({ length: 8 }, () => newConsent(t)))
        const statuses = (await Promise.all(ids.map((id) => approve(t, id, WRONG))))
          .map((r) => r.status)
        expect(counter.verifies).toBe(3)
        expect(statuses.filter((s) => s === 403)).toHaveLength(3)
        expect(statuses.filter((s) => s === 429)).toHaveLength(5)
      })

      it("counts neither right nor empty passwords", async () => {
        const t = setup({
          confirmOwner: undefined,
          ownerPassword: { ...ownerPassword, maxFailures: 2 },
        })
        expect((await approve(t, await newConsent(t), OWNER_PASSWORD)).status).toBe(302)
        const id = await newConsent(t)
        expect((await t.postConsent({ consent_id: id, decision: "approve" })).status).toBe(400)
        expect((await approve(t, id, WRONG)).status).toBe(403)
        expect((await approve(t, id, WRONG)).status).toBe(403)
        expect((await approve(t, id, OWNER_PASSWORD)).status).toBe(429)
      })

      describe("per client address", () => {
        const fromAddress = (
          t: ReturnType<typeof setup>,
          id: string,
          password: string,
          ip: string,
        ) =>
          t.postConsent(
            { consent_id: id, decision: "approve", [OWNER_PASSWORD_FIELD]: password },
            { origin: ISSUER, "sec-fetch-site": "same-origin", "x-test-address": ip },
          )
        const perAddress = (
          cap: { maxFailures?: number; maxTotalFailures?: number; totalWindowMs?: number },
        ) =>
          setup({
            confirmOwner: undefined,
            ownerPassword: {
              ...ownerPassword,
              ...cap,
              clientAddress: (c) => c.req.header("x-test-address"),
            },
          })

        it("lets the owner approve from another address while one address is locked out", async () => {
          const t = perAddress({ maxFailures: 2 })
          const id = await newConsent(t)
          for (let i = 0; i < 2; i++) {
            expect((await fromAddress(t, id, WRONG, "198.51.100.7")).status).toBe(403)
          }
          expect((await fromAddress(t, id, OWNER_PASSWORD, "198.51.100.7")).status).toBe(429)
          expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
        })

        it("locks every address out once maxTotalFailures wrong passwords come from many", async () => {
          const t = perAddress({ maxFailures: 2, maxTotalFailures: 5 })
          const id = await newConsent(t)
          for (let i = 0; i < 5; i++) {
            expect((await fromAddress(t, id, WRONG, `198.51.100.${i}`)).status).toBe(403)
          }
          const locked = await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")
          expect(locked.status).toBe(429)
          expect(locked.headers.get("retry-after")).toBe(String(24 * 60 * 60))
        })

        it("does not count an address's refused attempts toward the server-wide ceiling", async () => {
          const t = perAddress({ maxFailures: 1, maxTotalFailures: 2 })
          const id = await newConsent(t)
          expect((await fromAddress(t, id, WRONG, "198.51.100.7")).status).toBe(403)
          for (let i = 0; i < 3; i++) {
            expect((await fromAddress(t, id, WRONG, "198.51.100.7")).status).toBe(429)
          }
          expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
        })

        it("does not count against an address an attempt the server-wide ceiling refused", async () => {
          const t = perAddress({ maxFailures: 1, maxTotalFailures: 2, totalWindowMs: 60_000 })
          const id = await newConsent(t)
          for (const ip of ["198.51.100.1", "198.51.100.2"]) {
            expect((await fromAddress(t, id, WRONG, ip)).status).toBe(403)
          }
          expect((await fromAddress(t, id, WRONG, "203.0.113.9")).status).toBe(429)
          t.advance(60_000)
          expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
        })

        it("does not count right passwords toward the server-wide ceiling", async () => {
          const t = perAddress({ maxFailures: 1, maxTotalFailures: 2 })
          for (let i = 0; i < 3; i++) {
            const id = await newConsent(t)
            expect((await fromAddress(t, id, OWNER_PASSWORD, `203.0.113.${i}`)).status).toBe(302)
          }
        })

        /**
         * A server whose store throws `fail.error` from `fail.method` for the server-wide count
         * while `fail.error` is set, and otherwise behaves as `MemoryOAuthStore`.
         */
        const failingStore = (fail: {
          method: "takeAttempt" | "releaseAttempt"
          error?: Error
        }) => {
          const shared = perAddress({ maxFailures: 1 })
          const store = new Proxy(shared.store, {
            get(target, name) {
              if (name === fail.method) {
                return (key: string, ...rest: number[]) =>
                  fail.error !== undefined && key === "total"
                    ? Promise.reject(fail.error)
                    : (target[fail.method] as (key: string, ...rest: number[]) => Promise<unknown>)
                      .call(target, key, ...rest)
              }
              const value = Reflect.get(target, name, target)
              return typeof value === "function" ? value.bind(target) : value
            },
          })
          return setup({
            confirmOwner: undefined,
            store,
            ownerPassword: {
              ...ownerPassword,
              maxFailures: 1,
              clientAddress: (c) => c.req.header("x-test-address"),
            },
          })
        }

        it("answers 429, keeps the consent and uncounts the address when the store gives up", async () => {
          const fail: { method: "takeAttempt"; error?: Error } = {
            method: "takeAttempt",
            error: new OAuthStoreContentionError("gave up after conflicting writes"),
          }
          const t = failingStore(fail)
          const id = await newConsent(t)
          const refused = await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")
          expect(refused.status).toBe(429)
          expect(refused.headers.get("retry-after")).toBe("1")
          fail.error = undefined
          expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
        })

        it("approves when the store gives up releasing the server-wide count", async () => {
          const t = failingStore({
            method: "releaseAttempt",
            error: new OAuthStoreContentionError("gave up after conflicting writes"),
          })
          const id = await newConsent(t)
          expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
        })

        it("answers 500 when the store fails for any reason other than giving up", async () => {
          for (const method of ["takeAttempt", "releaseAttempt"] as const) {
            const t = failingStore({ method, error: new Error("disk I/O error") })
            const id = await newConsent(t)
            expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(500)
          }
        })

        describe("on Deno KV", () => {
          const START = 1_000_000
          const onKv = async (cap: { maxFailures?: number; maxTotalFailures?: number }) => {
            const kv = await Deno.openKv(":memory:")
            const t = setup({
              confirmOwner: undefined,
              store: new KvOAuthStore(kv, { clock: { now: () => START } }),
              ownerPassword: {
                ...ownerPassword,
                ...cap,
                clientAddress: (c) => c.req.header("x-test-address"),
              },
            })
            return { kv, t }
          }

          it("never answers 500 to a parallel burst of wrong passwords, and the owner still gets in", async () => {
            const { kv, t } = await onKv({ maxTotalFailures: 1_000 })
            try {
              const ids = await Promise.all(Array.from({ length: 100 }, () => newConsent(t)))
              const ownerId = await newConsent(t)
              const [owner, ...attackers] = await Promise.all([
                fromAddress(t, ownerId, OWNER_PASSWORD, "203.0.113.9"),
                ...ids.map((id, i) => fromAddress(t, id, WRONG, `198.51.${i >> 8}.${i & 255}`)),
              ])
              const statuses = attackers.map((r) => r.status)
              expect(statuses.filter((s) => s !== 403 && s !== 429)).toEqual([])
              expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
              if (owner.status === 429) {
                const retry = await fromAddress(t, ownerId, OWNER_PASSWORD, "203.0.113.9")
                expect(retry.status).toBe(302)
              } else {
                expect(owner.status).toBe(302)
              }
            } finally {
              kv.close()
            }
          })

          it("lets the owner in again once the documented server-wide count key is deleted", async () => {
            const { kv, t } = await onKv({ maxFailures: 2, maxTotalFailures: 3 })
            try {
              const id = await newConsent(t)
              for (let i = 0; i < 3; i++) {
                expect((await fromAddress(t, id, WRONG, `198.51.100.${i}`)).status).toBe(403)
              }
              expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(429)
              await kv.delete(["mcp-oauth", "attempts", "total"])
              expect((await fromAddress(t, id, OWNER_PASSWORD, "203.0.113.9")).status).toBe(302)
            } finally {
              kv.close()
            }
          })
        })
      })

      it("keeps counting wrong passwords across a restart that keeps the store", async () => {
        const first = setup({ confirmOwner: undefined, ownerPassword })
        const id = await newConsent(first)
        for (let i = 0; i < 10; i++) expect((await approve(first, id, WRONG)).status).toBe(403)
        const restarted = setup({ confirmOwner: undefined, ownerPassword, store: first.store })
        const locked = await approve(restarted, await newConsent(restarted), OWNER_PASSWORD)
        expect(locked.status).toBe(429)
      })

      it("still denies, and keeps issued tokens working, while locked out", async () => {
        const t = setup({
          confirmOwner: undefined,
          ownerPassword: { ...ownerPassword, maxFailures: 1 },
        })
        const response = await approve(t, await newConsent(t), OWNER_PASSWORD)
        const code = new URL(response.headers.get("location")!).searchParams.get("code")!
        const id = await newConsent(t)
        expect((await approve(t, id, WRONG)).status).toBe(403)
        expect((await approve(t, id, OWNER_PASSWORD)).status).toBe(429)
        const denied = await t.postConsent({ consent_id: id, decision: "deny" })
        expect(denied.status).toBe(302)
        expect(new URL(denied.headers.get("location")!).searchParams.get("error"))
          .toBe("access_denied")
        expect((await t.redeem(code)).status).toBe(200)
      })
    })
  })

  describe("refuses the code exchange", () => {
    it("for a replayed code, and revokes the tokens the first exchange issued", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const first = await (await t.redeem(code)).json()
      const replay = await t.redeem(code)
      expect(replay.status).toBe(400)
      expect((await replay.json()).error).toBe("invalid_grant")
      expect((await t.callMcp(first.access_token)).status).toBe(401)
      const refresh = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      })
      expect((await refresh.json()).error).toBe("invalid_grant")
    })

    it("for a code redeemed twice at once, leaving no working token", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const responses = await Promise.all([t.redeem(code), t.redeem(code)])
      await expectNoWorkingToken(t, responses)
    })

    it("when the store refuses the tokens because the grant was revoked", async () => {
      const store = new MemoryOAuthStore({ clock: { now: () => 1_000_000 } })
      store.saveRefreshToken = () => Promise.resolve(false)
      const t = setup({ store })
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.redeem(code)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for an expired code", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      t.advance(60_000)
      const response = await t.redeem(code)
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for a wrong code_verifier", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.redeem(code, { code_verifier: randomBase64Url(32) })
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("without a code_verifier", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.token({
        grant_type: "authorization_code",
        code,
        client_id: CLAUDE,
        redirect_uri: CLAUDE_REDIRECT_URI,
      })
      expect((await response.json()).error).toBe("invalid_request")
    })

    it("for another redirect URI", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.redeem(code, { redirect_uri: "https://evil.example/cb" })
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for another client", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.redeem(code, { client_id: CLAUDE_CODE })
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for another resource", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.redeem(code, { resource: OTHER_RESOURCE })
      expect((await response.json()).error).toBe("invalid_target")
    })

    it("with client authentication, since only public clients exist", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const response = await t.token(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: t.verifier,
          client_id: CLAUDE,
          redirect_uri: CLAUDE_REDIRECT_URI,
        },
        { authorization: "Basic eDp5" },
      )
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(`Basic realm="token"`)
      expect((await response.json()).error).toBe("invalid_client")
    })

    it("naming the scheme the client tried, but never echoing other text", async () => {
      const t = setup()
      const body = { grant_type: "authorization_code", code: "x", client_id: CLAUDE }
      const digest = await t.token(body, { authorization: `Digest username="a"` })
      expect(digest.headers.get("www-authenticate")).toBe(`Digest realm="token"`)
      const odd = await t.token(body, { authorization: `x"y, z` })
      expect(odd.headers.get("www-authenticate")).toBe(`Basic realm="token"`)
    })

    it("for a JSON body", async () => {
      const t = setup()
      const response = await t.app.request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      })
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "body must be application/x-www-form-urlencoded",
      })
    })

    it("for an unsupported grant type", async () => {
      const t = setup()
      const response = await t.token({ grant_type: "client_credentials", client_id: CLAUDE })
      expect((await response.json()).error).toBe("unsupported_grant_type")
    })
  })

  describe("revokes a token (RFC 7009)", () => {
    async function signedIn(t: ReturnType<typeof setup>) {
      const code = (await t.approve()).searchParams.get("code")!
      return await (await t.redeem(code)).json()
    }

    function revoke(
      t: ReturnType<typeof setup>,
      body: Record<string, string>,
      headers: Record<string, string> = {},
    ) {
      return t.app.request(`${ISSUER}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body).toString(),
      })
    }

    const refreshWith = (t: ReturnType<typeof setup>, refreshToken: string) =>
      t.token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE })

    it("with a refresh token: the next refresh fails with invalid_grant and the access token stops", async () => {
      const t = setup()
      const tokens = await signedIn(t)
      const response = await revoke(t, { token: tokens.refresh_token, client_id: CLAUDE })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const refreshed = await refreshWith(t, tokens.refresh_token)
      expect(refreshed.status).toBe(400)
      expect((await refreshed.json()).error).toBe("invalid_grant")
      expect((await t.callMcp(tokens.access_token)).status).toBe(401)
      expect(await t.store.listGrants()).toEqual([])
    })

    it("with an access token: only that token stops, and the refresh token still refreshes", async () => {
      const t = setup()
      const tokens = await signedIn(t)
      expect((await revoke(t, { token: tokens.access_token })).status).toBe(200)
      expect((await t.callMcp(tokens.access_token)).status).toBe(401)
      const refreshed = await refreshWith(t, tokens.refresh_token)
      expect(refreshed.status).toBe(200)
      expect((await t.callMcp((await refreshed.json()).access_token)).status).toBe(200)
    })

    it("revokes a refresh token sent with an access_token hint, since the hint is only a hint", async () => {
      const t = setup()
      const tokens = await signedIn(t)
      const response = await revoke(t, {
        token: tokens.refresh_token,
        token_type_hint: "access_token",
      })
      expect(response.status).toBe(200)
      expect((await (await refreshWith(t, tokens.refresh_token)).json()).error).toBe(
        "invalid_grant",
      )
    })

    it("answers an unknown or already revoked token exactly as a live one", async () => {
      const t = setup()
      const tokens = await signedIn(t)
      const answers = []
      for (const token of [tokens.refresh_token, tokens.refresh_token, randomBase64Url(32)]) {
        const response = await revoke(t, { token })
        answers.push([response.status, await response.text()])
      }
      expect(answers).toEqual([[200, ""], [200, ""], [200, ""]])
    })

    it("refuses client authentication, a missing token and a JSON body without revoking", async () => {
      const t = setup()
      const tokens = await signedIn(t)
      const authenticated = await revoke(t, { token: tokens.refresh_token }, {
        authorization: "Basic Y2xpZW50OnNlY3JldA==",
      })
      expect(authenticated.status).toBe(401)
      expect((await authenticated.json()).error).toBe("invalid_client")
      const missing = await revoke(t, { token_type_hint: "refresh_token" })
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toBe("invalid_request")
      const json = await t.app.request(`${ISSUER}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokens.refresh_token }),
      })
      expect(json.status).toBe(400)
      expect((await json.json()).error).toBe("invalid_request")
      expect((await refreshWith(t, tokens.refresh_token)).status).toBe(200)
    })
  })

  describe("refuses the refresh", () => {
    async function signedIn(t: ReturnType<typeof setup>) {
      const code = (await t.approve()).searchParams.get("code")!
      return await (await t.redeem(code)).json()
    }

    it("for a reused refresh token, and revokes the grant", async () => {
      const t = setup()
      const first = await signedIn(t)
      const body = {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      }
      const second = await (await t.token(body)).json()
      const reuse = await t.token(body)
      expect(reuse.status).toBe(400)
      expect((await reuse.json()).error).toBe("invalid_grant")
      expect((await t.callMcp(second.access_token)).status).toBe(401)
      const next = await t.token({ ...body, refresh_token: second.refresh_token })
      expect((await next.json()).error).toBe("invalid_grant")
    })

    it("for a refresh token redeemed twice at once, leaving no working token", async () => {
      const t = setup()
      const first = await signedIn(t)
      const body = {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      }
      const responses = await Promise.all([t.token(body), t.token(body)])
      await expectNoWorkingToken(t, responses)
    })

    it("for an expired refresh token", async () => {
      const t = setup()
      const first = await signedIn(t)
      t.advance(30 * 24 * 60 * 60_000)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      })
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for another resource, without spending the token", async () => {
      const t = setup()
      const first = await signedIn(t)
      const body = {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      }
      const response = await t.token({ ...body, resource: OTHER_RESOURCE })
      expect((await response.json()).error).toBe("invalid_target")
      expect((await t.token({ ...body, resource: RESOURCE })).status).toBe(200)
    })

    it("for another client, and spends the token as a theft signal", async () => {
      const t = setup()
      const first = await signedIn(t)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE_CODE,
      })
      expect((await response.json()).error).toBe("invalid_grant")
      const retry = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      })
      expect((await retry.json()).error).toBe("invalid_grant")
    })

    it("for a scope wider than the grant, without spending the token", async () => {
      const t = setup({ scopes: ["tasks", "admin"] })
      const first = await signedIn(t)
      const body = {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      }
      const response = await t.token({ ...body, scope: "tasks admin" })
      expect((await response.json()).error).toBe("invalid_scope")
      expect((await t.token({ ...body, scope: "tasks" })).status).toBe(200)
    })
  })

  describe("ends every grant", () => {
    const DAY = 24 * 60 * 60_000
    async function signedIn(t: ReturnType<typeof setup>) {
      const code = (await t.approve()).searchParams.get("code")!
      return await (await t.redeem(code)).json()
    }
    const refreshWith = (t: ReturnType<typeof setup>, refreshToken: string) =>
      t.token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE })

    it("at grantTtlMs after approval, however often the client refreshes", async () => {
      const t = setup({ grantTtlMs: 3 * DAY, refreshTokenTtlMs: 2 * DAY })
      let tokens = await signedIn(t)
      for (let day = 1; day < 3; day++) {
        t.advance(DAY)
        const response = await refreshWith(t, tokens.refresh_token)
        expect(response.status).toBe(200)
        tokens = await response.json()
      }
      t.advance(DAY - 1)
      const last = await refreshWith(t, tokens.refresh_token)
      expect(last.status).toBe(200)
      const lastTokens = await last.json()
      expect(lastTokens.expires_in).toBe(0)
      t.advance(1)
      expect((await t.callMcp(lastTokens.access_token)).status).toBe(401)
      const after = await refreshWith(t, lastTokens.refresh_token)
      expect((await after.json()).error).toBe("invalid_grant")
    })

    it("cuts the access token short when the grant ends first", async () => {
      const t = setup({ grantTtlMs: 10 * 60_000 })
      const tokens = await signedIn(t)
      expect(tokens.expires_in).toBe(10 * 60)
      t.advance(10 * 60_000)
      expect((await t.callMcp(tokens.access_token)).status).toBe(401)
    })

    it("after 90 days by default", async () => {
      const t = setup({ refreshTokenTtlMs: 100 * DAY })
      const tokens = await signedIn(t)
      t.advance(90 * DAY - 1)
      const before = await refreshWith(t, tokens.refresh_token)
      expect(before.status).toBe(200)
      t.advance(1)
      const after = await refreshWith(t, (await before.json()).refresh_token)
      expect((await after.json()).error).toBe("invalid_grant")
    })

    it("and gives a grant issued before grants had an end one at its first refresh", async () => {
      const t = setup({ grantTtlMs: 3 * DAY })
      const legacy = randomBase64Url(32)
      await t.store.saveRefreshToken(await sha256Hex(legacy), {
        grantId: "legacy",
        clientId: CLAUDE,
        resource: RESOURCE,
        scope: "tasks",
        expiresAt: 1_000_000 + 30 * DAY,
      })
      const rotated = await refreshWith(t, legacy)
      expect(rotated.status).toBe(200)
      expect(await t.store.listGrants()).toEqual([{
        grantId: "legacy",
        clientId: CLAUDE,
        resource: RESOURCE,
        scope: "tasks",
        createdAt: 1_000_000,
        expiresAt: 1_000_000 + 3 * DAY,
      }])
      t.advance(3 * DAY)
      const after = await refreshWith(t, (await rotated.json()).refresh_token)
      expect((await after.json()).error).toBe("invalid_grant")
    })
  })

  describe("lists grants", () => {
    it("one per approved client, and revoking one signs out that client only", async () => {
      const t = setup()
      const first = await (await t.redeem((await t.approve()).searchParams.get("code")!)).json()
      t.advance(1_000)
      const second = await (await t.redeem((await t.approve()).searchParams.get("code")!)).json()
      const grants = await t.store.listGrants()
      expect(grants.map((g) => [g.clientId, g.resource, g.scope, g.createdAt])).toEqual([
        [CLAUDE, RESOURCE, "tasks", 1_000_000],
        [CLAUDE, RESOURCE, "tasks", 1_001_000],
      ])
      expect(grants[0].expiresAt).toBe(1_000_000 + 90 * 24 * 60 * 60_000)
      await t.store.revokeGrant(grants[0].grantId, grants[0].expiresAt)
      expect((await t.callMcp(first.access_token)).status).toBe(401)
      const refreshed = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
      })
      expect((await refreshed.json()).error).toBe("invalid_grant")
      expect((await t.callMcp(second.access_token)).status).toBe(200)
      expect((await t.store.listGrants()).map((g) => g.grantId)).toEqual([grants[1].grantId])
    })

    it("keeps the grant's start and scope when the client refreshes with a narrower scope", async () => {
      const t = setup()
      const tokens = await (await t.redeem((await t.approve()).searchParams.get("code")!)).json()
      t.advance(1_000)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CLAUDE,
        scope: "",
      })
      expect(response.status).toBe(200)
      const [grant] = await t.store.listGrants()
      expect([grant.createdAt, grant.scope]).toEqual([1_000_000, "tasks"])
    })
  })

  describe("binds tokens to their resource", () => {
    it("so a token for one MCP server is refused by another", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const tokens = await (await t.redeem(code)).json()
      expect((await t.callMcp(tokens.access_token)).status).toBe(200)
      const refused = await t.callMcp(tokens.access_token, t.other, OTHER_RESOURCE)
      expect(refused.status).toBe(401)
      expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"')
    })

    it("and expires the access token", async () => {
      const t = setup()
      const code = (await t.approve()).searchParams.get("code")!
      const tokens = await (await t.redeem(code)).json()
      t.advance(15 * 60_000)
      expect((await t.callMcp(tokens.access_token)).status).toBe(401)
    })
  })

  describe("configuration", () => {
    const base = {
      resources: [RESOURCE],
      store: new MemoryOAuthStore(),
      confirmOwner: () => true,
    }

    it("refuses an issuer with a path", () => {
      expect(() => createAuthorizationServer({ ...base, issuer: `${ISSUER}/oauth` })).toThrow(
        "must be a bare https origin",
      )
    })

    it("refuses a plain-http issuer off loopback", () => {
      expect(() => createAuthorizationServer({ ...base, issuer: "http://auth.example.com" }))
        .toThrow(TypeError)
    })

    it("refuses a plain-http redirect URI off loopback", () => {
      expect(() =>
        createAuthorizationServer({
          ...base,
          issuer: ISSUER,
          redirectUris: ["http://claude.example/cb"],
        })
      ).toThrow(TypeError)
    })

    it("refuses a server with neither confirmOwner nor ownerPassword", () => {
      expect(() => createAuthorizationServer({ ...base, issuer: ISSUER, confirmOwner: undefined }))
        .toThrow("set confirmOwner, ownerPassword or both")
    })

    it("refuses an empty owner password hash", () => {
      expect(() =>
        createAuthorizationServer({
          ...base,
          issuer: ISSUER,
          ownerPassword: { hash: "", hasher },
        })
      ).toThrow("ownerPassword.hash must be a password hash")
    })

    it("refuses a wrong-password cap that is not a positive integer or window", () => {
      const server = (cap: { maxFailures?: number; windowMs?: number }) => () =>
        createAuthorizationServer({
          ...base,
          issuer: ISSUER,
          ownerPassword: { ...ownerPassword, ...cap },
        })
      for (const maxFailures of [0, -1, 1.5, Number.NaN]) {
        expect(server({ maxFailures })).toThrow(
          "ownerPassword.maxFailures must be a positive integer",
        )
      }
      for (const windowMs of [0, -1, Number.POSITIVE_INFINITY]) {
        expect(server({ windowMs })).toThrow("ownerPassword.windowMs must be positive")
      }
    })

    it("refuses a server-wide cap that does not exceed the per-address one, or an empty window", () => {
      const server = (cap: { maxTotalFailures?: number; totalWindowMs?: number }) => () =>
        createAuthorizationServer({
          ...base,
          issuer: ISSUER,
          ownerPassword: { ...ownerPassword, maxFailures: 5, ...cap },
        })
      for (const maxTotalFailures of [5, 4, 5.5, Number.NaN]) {
        expect(server({ maxTotalFailures })).toThrow(
          "ownerPassword.maxTotalFailures must be an integer above maxFailures",
        )
      }
      expect(server({ maxTotalFailures: 6 })).not.toThrow()
      for (const totalWindowMs of [0, -1, Number.POSITIVE_INFINITY]) {
        expect(server({ totalWindowMs })).toThrow("ownerPassword.totalWindowMs must be positive")
      }
    })

    it("refuses a grant lifetime that is not positive", () => {
      for (const grantTtlMs of [0, -1, Number.NaN]) {
        expect(() => createAuthorizationServer({ ...base, issuer: ISSUER, grantTtlMs })).toThrow(
          "grantTtlMs must be positive",
        )
      }
    })

    it("refuses an empty resource list", () => {
      expect(() => createAuthorizationServer({ ...base, issuer: ISSUER, resources: [] })).toThrow(
        TypeError,
      )
    })
  })
})

describe("defaultConsentPage", () => {
  it("escapes every value it shows", () => {
    const hostile = (field: string) => `"><x-${field}>`
    const html = defaultConsentPage({
      consentId: hostile("consent"),
      action: `/authorize${hostile("action")}`,
      clientId: `https://claude.example/c${hostile("client-id")}`,
      clientHost: hostile("client-host"),
      clientName: hostile("client-name"),
      redirectUri: `${CLAUDE_REDIRECT_URI}${hostile("redirect-uri")}`,
      redirectHost: hostile("redirect-host"),
      loopbackRedirect: true,
      resource: `${RESOURCE}${hostile("resource")}`,
      scopes: [hostile("scope")],
      passwordField: `owner_password${hostile("password-field")}`,
      passwordError: hostile("password-error"),
    })
    for (
      const field of [
        "consent",
        "action",
        "client-id",
        "client-host",
        "client-name",
        "redirect-uri",
        "redirect-host",
        "resource",
        "scope",
        "password-field",
        "password-error",
      ]
    ) {
      expect(html).not.toContain(`<x-${field}>`)
      expect(html).toContain(`&lt;x-${field}&gt;`)
    }
  })
})
