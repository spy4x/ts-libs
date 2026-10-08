import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import {
  type AccessTokenVerifier,
  canonicalResource,
  createAccessTokenVerifier,
  createResourceServer,
  type ResourceGuardEnv,
} from "./resource-server.ts"
import { MemoryOAuthStore } from "./memory-store.ts"
import { sha256Hex } from "@spy4x/platform/tokens"

const RESOURCE = "https://mcp.example.com/mcp"
const ISSUER = "https://auth.example.com"
const METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"

const verifier: AccessTokenVerifier = {
  verify(token) {
    const resource = token === "good" ? RESOURCE : token === "other" ? "https://x.example/mcp" : ""
    if (resource === "") return Promise.resolve(undefined)
    return Promise.resolve({ clientId: "c", resource, scope: "", expiresAt: 9e15 })
  },
}

function app(scopes?: string[]) {
  const rs = createResourceServer({ resource: RESOURCE, issuer: ISSUER, verifier, scopes })
  const hono = new Hono<ResourceGuardEnv>()
  hono.get(rs.metadataPath, rs.metadataHandler)
  hono.use("/mcp", rs.guard)
  hono.post("/mcp", (c) => c.json({ client: c.var.oauth.clientId }))
  return hono
}

describe("createResourceServer", () => {
  it("answers a request without a token with 401 and a resource_metadata pointer", async () => {
    const response = await app().request(RESOURCE, { method: "POST" })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`,
    )
    expect(await response.text()).not.toContain("invalid_token")
  })

  it("adds the scope to the challenge when scopes are configured", async () => {
    const response = await app(["tasks"]).request(RESOURCE, { method: "POST" })
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="tasks"`,
    )
  })

  it("refuses an unknown token with invalid_token", async () => {
    const response = await app().request(RESOURCE, {
      method: "POST",
      headers: { authorization: "Bearer bad" },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
    )
  })

  it("refuses a valid token issued for another resource", async () => {
    const response = await app().request(RESOURCE, {
      method: "POST",
      headers: { authorization: "Bearer other" },
    })
    expect(response.status).toBe(401)
  })

  it("ignores a token in the query string", async () => {
    const response = await app().request(`${RESOURCE}?access_token=good`, { method: "POST" })
    expect(response.status).toBe(401)
  })

  it("lets a valid token through and exposes its grant", async () => {
    const response = await app().request(RESOURCE, {
      method: "POST",
      headers: { authorization: "Bearer good" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ client: "c" })
  })

  it("serves the metadata document at the path-suffixed well-known URL", async () => {
    const response = await app(["tasks"]).request(METADATA_URL)
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["tasks"],
    })
  })

  it("serves the root well-known URL for a resource without a path", () => {
    const rs = createResourceServer({
      resource: "https://mcp.example.com/",
      issuer: ISSUER,
      verifier,
    })
    expect(rs.metadataPath).toBe("/.well-known/oauth-protected-resource")
    expect(rs.resource).toBe("https://mcp.example.com")
  })

  it("refuses a scope that would break the challenge header", () => {
    expect(() =>
      createResourceServer({ resource: RESOURCE, issuer: ISSUER, verifier, scopes: ['a"b'] })
    ).toThrow(TypeError)
  })
})

describe("createAccessTokenVerifier", () => {
  it("finds a token by its digest and refuses it once expired", async () => {
    let now = 1_000
    const store = new MemoryOAuthStore({ clock: { now: () => now } })
    await store.saveAccessToken(await sha256Hex("tok"), {
      grantId: "g",
      clientId: "c",
      resource: RESOURCE,
      scope: "",
      expiresAt: 2_000,
    })
    const check = createAccessTokenVerifier(store, { now: () => now })
    expect((await check.verify("tok"))?.resource).toBe(RESOURCE)
    expect(await check.verify("other")).toBeUndefined()
    now = 2_000
    expect(await check.verify("tok")).toBeUndefined()
  })
})

describe("canonicalResource", () => {
  it("lower-cases scheme and host and drops a bare origin's slash", () => {
    expect(canonicalResource("HTTPS://MCP.Example.com/")).toBe("https://mcp.example.com")
    expect(canonicalResource("https://mcp.example.com:443/mcp")).toBe(RESOURCE)
  })

  it("refuses http off loopback, a fragment and user info", () => {
    expect(canonicalResource("http://mcp.example.com/mcp")).toBeUndefined()
    expect(canonicalResource("https://mcp.example.com/mcp#x")).toBeUndefined()
    expect(canonicalResource("https://u@mcp.example.com/mcp")).toBeUndefined()
    expect(canonicalResource("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp")
  })
})
