import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { encodeBase64Url } from "@std/encoding/base64url"
import { randomBase64Url } from "@spy4x/platform/tokens"
import {
  type AuthorizationServerOptions,
  createAuthorizationServer,
  defaultConsentPage,
} from "./authorization-server.ts"
import type { ClientMetadataSource } from "./client-metadata.ts"
import { MemoryOAuthStore } from "./memory-store.ts"
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
      expect((await response.json()).error).toBe("invalid_client")
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

    it("for another resource", async () => {
      const t = setup()
      const first = await signedIn(t)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
        resource: OTHER_RESOURCE,
      })
      expect((await response.json()).error).toBe("invalid_target")
    })

    it("for another client", async () => {
      const t = setup()
      const first = await signedIn(t)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE_CODE,
      })
      expect((await response.json()).error).toBe("invalid_grant")
    })

    it("for a scope wider than the grant", async () => {
      const t = setup({ scopes: ["tasks", "admin"] })
      const first = await signedIn(t)
      const response = await t.token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
        scope: "tasks admin",
      })
      expect((await response.json()).error).toBe("invalid_scope")
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

    it("refuses an empty resource list", () => {
      expect(() => createAuthorizationServer({ ...base, issuer: ISSUER, resources: [] })).toThrow(
        TypeError,
      )
    })
  })
})

describe("defaultConsentPage", () => {
  it("escapes every value it shows", () => {
    const html = defaultConsentPage({
      consentId: `"><script>`,
      action: "/authorize",
      clientId: "https://claude.example/c",
      clientHost: "claude.example",
      clientName: "<img src=x onerror=alert(1)>",
      redirectUri: CLAUDE_REDIRECT_URI,
      redirectHost: "claude.ai",
      loopbackRedirect: false,
      resource: RESOURCE,
      scopes: [],
    })
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;img")
  })
})
