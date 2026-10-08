import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  installOfflineShell,
  isUnderPath,
  linkedPaths,
  type OfflineShellOptions,
  type ShellCache,
  type ShellFetchEvent,
  type ShellScope,
} from "./offline-shell.ts"

const ORIGIN = "https://app.example.com"

/** Cache key as a string: a request and its URL are the same entry. */
function keyOf(input: Request | string): string {
  if (typeof input === "string") return new URL(input, ORIGIN).pathname
  return new URL(input.url).pathname
}

/** An in-memory cache whose `add` fetches through the fake network. */
class FakeCache implements ShellCache {
  entries = new Map<string, Response>()
  constructor(private network: (url: string) => Promise<Response>) {}
  match(input: Request | string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(keyOf(input))?.clone())
  }
  put(input: Request | string, response: Response): Promise<void> {
    this.entries.set(keyOf(input), response)
    return Promise.resolve()
  }
  async add(input: Request | string): Promise<void> {
    const response = await this.network(typeof input === "string" ? input : input.url)
    if (!response.ok) throw new Error(`bad status ${response.status}`)
    this.entries.set(keyOf(input), response)
  }
}

/** A fake worker scope with a controllable network and cache storage. */
function setup(options: Partial<OfflineShellOptions> = {}) {
  const net = {
    online: true,
    navigatorOnLine: false,
    calls: [] as string[],
    responses: new Map<string, () => Response>(),
  }
  const network = (input: Request | string): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input, ORIGIN).href : input.url
    net.calls.push(new URL(url).pathname)
    if (!net.online) return Promise.reject(new TypeError(`offline`))
    const make = net.responses.get(new URL(url).pathname)
    return Promise.resolve(make ? make() : new Response(`net:${new URL(url).pathname}`))
  }
  const stores = new Map<string, FakeCache>()
  const listeners = new Map<string, (event: never) => void>()
  const state = { skipped: 0, claimed: 0 }
  const scope: ShellScope = {
    location: { origin: ORIGIN },
    navigator: {
      get onLine() {
        return net.navigatorOnLine
      },
    },
    caches: {
      open: (name) => {
        if (!stores.has(name)) stores.set(name, new FakeCache(network))
        return Promise.resolve(stores.get(name)!)
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name) => Promise.resolve(stores.delete(name)),
    },
    clients: { claim: () => Promise.resolve(void state.claimed++) },
    skipWaiting: () => {
      state.skipped++
    },
    fetch: network,
    addEventListener: (type, listener) => void listeners.set(type, listener),
  }
  installOfflineShell(scope, { shellUrls: ["/"], ...options })

  /** Fire a lifecycle event and wait for what the worker asked to wait on. */
  async function lifecycle(type: "install" | "activate"): Promise<void> {
    const waits: Promise<unknown>[] = []
    ;(listeners.get(type) as (e: unknown) => void)({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    await Promise.all(waits)
  }

  /** Send a request through the fetch listener; `null` when the worker did not respond. */
  async function request(
    url: string,
    init: RequestInit & { mode?: RequestMode } = {},
  ): Promise<{ response: Response | null }> {
    const { mode, ...rest } = init
    const req = new Request(new URL(url, ORIGIN), rest)
    // A script cannot build a navigate request, so shadow the getter the worker reads.
    if (mode === "navigate") Object.defineProperty(req, "mode", { value: "navigate" })
    let responded: Promise<Response> | null = null
    const waits: Promise<unknown>[] = []
    const event: ShellFetchEvent = {
      request: req,
      respondWith: (p) => {
        responded = p
      },
      waitUntil: (p) => void waits.push(p),
    }
    ;(listeners.get("fetch") as (e: unknown) => void)(event)
    const response = responded ? await responded : null
    await Promise.all(waits)
    return { response }
  }

  const cache = () => {
    const c = stores.get(options.cacheName ?? "shell-v1")
    return c ? c.entries : new Map<string, Response>()
  }
  return { net, scope, listeners, state, stores, lifecycle, request, cache }
}

describe("isUnderPath", () => {
  it("matches the path itself and everything below, not a longer sibling", () => {
    expect([
      isUnderPath("/api", "/api"),
      isUnderPath("/api/tasks", "/api"),
      isUnderPath("/apix", "/api"),
      isUnderPath("/api/x", "/api/"),
    ]).toEqual([true, true, false, true])
  })
})

describe("linkedPaths", () => {
  it("lists same-origin src and href paths, without fragments or other origins", () => {
    const html =
      `<script src="/assets/a.js"></script><link href="/assets/a.css"><a href="/x#top"></a><img src="https://cdn.example.com/i.png"><script src="//cdn.example.com/y.js">`
    expect(linkedPaths(html)).toEqual(["/assets/a.js", "/assets/a.css", "/x"])
  })
})

describe("install", () => {
  it("stores the shell URLs and the files the page names", async () => {
    const s = setup({ shellUrls: ["/", "/config.json"] })
    s.net.responses.set(
      "/",
      () =>
        new Response(`<script src="/assets/app-1.js"></script>`, {
          headers: { "content-type": "text/html" },
        }),
    )
    await s.lifecycle("install")
    expect([...s.cache().keys()].sort()).toEqual(["/", "/assets/app-1.js", "/config.json"])
  })

  it("does not store a shell URL that answers with an error", async () => {
    const s = setup({ shellUrls: ["/", "/config.json"] })
    s.net.responses.set("/config.json", () => new Response("nope", { status: 404 }))
    await s.lifecycle("install")
    expect([...s.cache().keys()]).toEqual(["/"])
  })

  it("still installs when a linked file fails to load", async () => {
    const s = setup()
    s.net.responses.set(
      "/",
      () =>
        new Response(`<script src="/assets/a.js"></script><script src="/assets/b.js"></script>`, {
          headers: { "content-type": "text/html" },
        }),
    )
    s.net.responses.set("/assets/b.js", () => new Response("", { status: 500 }))
    await s.lifecycle("install")
    expect([...s.cache().keys()].sort()).toEqual(["/", "/assets/a.js"])
  })

  it("installs with no network at all", async () => {
    const s = setup()
    s.net.online = false
    await s.lifecycle("install")
    expect(s.cache().size).toBe(0)
  })

  it("skips linked files when precacheLinkedFiles is off", async () => {
    const s = setup({ precacheLinkedFiles: false })
    s.net.responses.set(
      "/",
      () =>
        new Response(`<script src="/assets/a.js"></script>`, {
          headers: { "content-type": "text/html" },
        }),
    )
    await s.lifecycle("install")
    expect([...s.cache().keys()]).toEqual(["/"])
  })
})

describe("activate", () => {
  it("deletes older shell caches, keeps unrelated ones, and claims clients", async () => {
    const s = setup({ cacheName: "shell-v2" })
    await s.scope.caches.open("shell-v1")
    await s.scope.caches.open("shell-v2")
    await s.scope.caches.open("other")
    await s.lifecycle("activate")
    expect([...s.stores.keys()].sort()).toEqual(["other", "shell-v2"])
    expect(s.state.claimed).toBe(1)
  })
})

describe("fetch", () => {
  it("answers a file under /assets/ from the cache without asking the network", async () => {
    const s = setup()
    const cache = await s.scope.caches.open("shell-v1")
    await cache.put("/assets/app-1.js", new Response("cached"))
    const { response } = await s.request("/assets/app-1.js")
    expect(await response!.text()).toBe("cached")
    expect(s.net.calls).toEqual([])
  })

  it("fetches an /assets/ file that is not cached yet, and stores it", async () => {
    const s = setup()
    const { response } = await s.request("/assets/new.js")
    expect(await response!.text()).toBe("net:/assets/new.js")
    expect([...s.cache().keys()]).toEqual(["/assets/new.js"])
  })

  it("prefers the network for other files, so a deploy shows at once", async () => {
    const s = setup()
    const cache = await s.scope.caches.open("shell-v1")
    await cache.put("/manifest.json", new Response("old"))
    const { response } = await s.request("/manifest.json")
    expect(await response!.text()).toBe("net:/manifest.json")
    expect(await (await cache.match("/manifest.json"))!.text()).toBe("net:/manifest.json")
  })

  it("answers a page load from the cache when the network is off", async () => {
    const s = setup()
    const cache = await s.scope.caches.open("shell-v1")
    await cache.put("/", new Response("shell"))
    s.net.online = false
    const { response } = await s.request("/tasks/42", { mode: "navigate" })
    expect(await response!.text()).toBe("shell")
  })

  it("stores every page load under one key", async () => {
    const s = setup()
    await s.request("/tasks/42", { mode: "navigate" })
    expect([...s.cache().keys()]).toEqual(["/"])
  })

  it("fails when the network is off and nothing is cached", async () => {
    const s = setup()
    s.net.online = false
    await expect(s.request("/other.json")).rejects.toThrow("offline")
  })

  it("retries once while the browser says it is online", async () => {
    const s = setup()
    s.net.navigatorOnLine = true
    let calls = 0
    s.scope.fetch = () => {
      calls++
      return calls === 1
        ? Promise.reject(new TypeError("blip"))
        : Promise.resolve(new Response("ok"))
    }
    const { response } = await s.request("/other.json")
    expect(await response!.text()).toBe("ok")
    expect(calls).toBe(2)
  })

  it("does not retry while the browser says it is offline", async () => {
    const s = setup()
    let calls = 0
    s.scope.fetch = () => {
      calls++
      return Promise.reject(new TypeError("down"))
    }
    await expect(s.request("/other.json")).rejects.toThrow("down")
    expect(calls).toBe(1)
  })

  it("never touches /api, below it, and answers nothing for it", async () => {
    const s = setup()
    const results = await Promise.all([s.request("/api"), s.request("/api/tasks?x=1")])
    expect(results.map((r) => r.response)).toEqual([null, null])
    expect(s.net.calls).toEqual([])
    expect(s.cache().size).toBe(0)
  })

  it("never touches the prefixes the caller configures instead", async () => {
    const s = setup({ neverCache: ["/api", "/ws"] })
    const { response } = await s.request("/ws/live")
    expect(response).toBeNull()
  })

  it("treats a path that only starts with the prefix as a shell file", async () => {
    const s = setup()
    const { response } = await s.request("/apix.json")
    expect(response).not.toBeNull()
  })

  it("never touches a request that is not GET", async () => {
    const s = setup()
    const { response } = await s.request("/assets/app.js", { method: "POST", body: "x" })
    expect(response).toBeNull()
    expect(s.cache().size).toBe(0)
  })

  it("never touches another origin", async () => {
    const s = setup()
    const { response } = await s.request("https://cdn.example.com/lib.js")
    expect(response).toBeNull()
  })

  it("returns an error response to the page without storing it", async () => {
    const s = setup()
    s.net.responses.set("/gone.json", () => new Response("x", { status: 404 }))
    const { response } = await s.request("/gone.json")
    expect(response!.status).toBe(404)
    expect(s.cache().size).toBe(0)
  })

  it("still returns the response when the cache write fails", async () => {
    const s = setup()
    const cache = await s.scope.caches.open("shell-v1")
    cache.put = () => Promise.reject(new Error("quota"))
    const { response } = await s.request("/other.json")
    expect(await response!.text()).toBe("net:/other.json")
  })
})

describe("message", () => {
  it("takes over when SWUpdater posts { action: 'skipWaiting' }", () => {
    const s = setup()
    ;(s.listeners.get("message") as (e: unknown) => void)({ data: { action: "skipWaiting" } })
    expect(s.state.skipped).toBe(1)
  })

  it("ignores any other message", () => {
    const s = setup()
    const send = s.listeners.get("message") as (e: unknown) => void
    send({ data: { type: "SKIP_WAITING" } })
    send({ data: null })
    send({})
    expect(s.state.skipped).toBe(0)
  })
})
