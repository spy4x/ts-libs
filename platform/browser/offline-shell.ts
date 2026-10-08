/**
 * App-shell cache for a service worker: the page and its scripts, styles and images stay in the
 * browser's cache, so a single-page app opens with no network.
 *
 * The rules, in order of request:
 *
 * - Never touched: non-GET requests, other origins, and any path under a configured prefix
 *   (default `/api`). Data belongs to the app's own offline store, never to this cache.
 * - Files under `/assets/` (a build names them by content hash) are answered cache-first.
 * - Everything else is network-first, so a deploy shows at once; the cache answers only when the
 *   network fails. Only OK responses are stored. A page load (`navigate`) is stored and served
 *   under one key (default `/`), because every route of a single-page app is the same document.
 *
 * The worker's whole file is then:
 *
 * ```js
 * import { installOfflineShell } from "https://jsr.io/@spy4x/platform/<version>/browser/offline-shell.ts"
 * installOfflineShell(self, { shellUrls: ["/", "/config.json"] })
 * ```
 *
 * Nothing touches a global at import time: the worker scope and the cache storage are parameters.
 */

/** Cache surface this module needs; a real `Cache` fits. */
export interface ShellCache {
  match: (request: Request | string) => Promise<Response | undefined>
  put: (request: Request | string, response: Response) => Promise<void>
  add: (request: Request | string) => Promise<void>
}

/** Cache storage surface; a real `CacheStorage` fits. */
export interface ShellCacheStorage {
  open: (name: string) => Promise<ShellCache>
  keys: () => Promise<string[]>
  delete: (name: string) => Promise<boolean>
}

/** The parts of an `ExtendableEvent` this module uses. */
export interface ShellEvent {
  waitUntil: (promise: Promise<unknown>) => void
}

/** The parts of a `FetchEvent` this module uses. */
export interface ShellFetchEvent extends ShellEvent {
  request: Request
  respondWith: (response: Promise<Response>) => void
}

/** The parts of a `message` event this module uses. */
export interface ShellMessageEvent {
  data?: unknown
}

/** The parts of the service-worker global scope this module uses; `self` fits. */
export interface ShellScope {
  location: { origin: string }
  navigator: { onLine: boolean }
  caches: ShellCacheStorage
  clients: { claim: () => Promise<void> }
  skipWaiting: () => Promise<void> | void
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>
  addEventListener: (type: string, listener: (event: never) => void) => void
}

/** Options of {@link installOfflineShell}. */
export interface OfflineShellOptions {
  /** URLs stored when the worker installs: the page and the files it needs before it renders. */
  shellUrls: string[]
  /** Cache name. Caches named `shell-*` with another name are deleted on activate. Default `shell-v1`. */
  cacheName?: string
  /** Paths the worker leaves alone, each matching itself and everything below it. Default `["/api"]`. */
  neverCache?: string[]
  /** Path prefix served cache-first. Default `/assets/`. */
  assetsPrefix?: string
  /** Key a page load is stored and served under. Default `/`. */
  navigationKey?: string
  /**
   * Also store every same-origin file the shell pages name in `src` or `href` (their hashed
   * scripts and styles), so the first offline start has them. Default `true`.
   */
  precacheLinkedFiles?: boolean
}

/** The message `SWUpdater` posts to a waiting worker; {@link installOfflineShell} acts on it. */
export const SKIP_WAITING_MESSAGE: { action: "skipWaiting" } = { action: "skipWaiting" }

/** Whether `pathname` is `base` or below it (`/api` matches `/api` and `/api/x`, not `/apix`). */
export function isUnderPath(pathname: string, base: string): boolean {
  const prefix = base.replace(/\/+$/, "")
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** Same-origin paths named by `src="..."` and `href="..."` in `html`. */
export function linkedPaths(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/(?!\/)[^"#]+)(?:#[^"]*)?"/g)].map((match) => match[1])
}

/**
 * Register the install, activate, fetch and message listeners that keep the app shell offline.
 *
 * @param scope The worker global scope (`self`).
 * @param options See {@link OfflineShellOptions}.
 */
export function installOfflineShell(scope: ShellScope, options: OfflineShellOptions): void {
  const cacheName = options.cacheName ?? "shell-v1"
  const neverCache = options.neverCache ?? ["/api"]
  const assetsPrefix = options.assetsPrefix ?? "/assets/"
  const navigationKey = options.navigationKey ?? "/"
  const linked = options.precacheLinkedFiles ?? true

  const isShellRequest = (request: Request): boolean => {
    if (request.method !== "GET") return false
    const url = new URL(request.url)
    return url.origin === scope.location.origin &&
      !neverCache.some((base) => isUnderPath(url.pathname, base))
  }

  /** `fetch`, tried once more while the browser says it is online (a network change mid-request). */
  const fetchWithRetry = async (request: Request): Promise<Response> => {
    try {
      return await scope.fetch(request.clone())
    } catch (error) {
      if (scope.navigator.onLine) return await scope.fetch(request)
      throw error
    }
  }

  const precache = async (): Promise<void> => {
    const cache = await scope.caches.open(cacheName)
    const paths = new Set<string>()
    // One file that fails to load must not stop the worker from installing.
    await Promise.allSettled(options.shellUrls.map(async (url) => {
      const response = await scope.fetch(url, { cache: "reload" })
      if (!response.ok) return
      await cache.put(url, response.clone())
      if (linked && (response.headers.get("content-type") ?? "").includes("text/html")) {
        for (const path of linkedPaths(await response.text())) paths.add(path)
      }
    }))
    await Promise.allSettled([...paths].map((path) => cache.add(path)))
  }

  scope.addEventListener(
    "install",
    ((event: ShellEvent) => {
      event.waitUntil(precache())
    }) as (event: never) => void,
  )

  scope.addEventListener(
    "activate",
    ((event: ShellEvent) => {
      event.waitUntil((async () => {
        for (const name of await scope.caches.keys()) {
          if (name.startsWith("shell-") && name !== cacheName) await scope.caches.delete(name)
        }
        // Take over the page that registered this worker, so its next requests are cached too.
        await scope.clients.claim()
      })())
    }) as (event: never) => void,
  )

  scope.addEventListener(
    "fetch",
    ((event: ShellFetchEvent) => {
      const { request } = event
      if (!isShellRequest(request)) return
      const url = new URL(request.url)
      event.respondWith((async () => {
        const cache = await scope.caches.open(cacheName)
        if (url.pathname.startsWith(assetsPrefix)) {
          const cached = await cache.match(request)
          if (cached) return cached
        }
        const key = request.mode === "navigate" ? navigationKey : request
        try {
          const response = await fetchWithRetry(request)
          // A failed cache write must not fail a response that arrived.
          if (response.ok) event.waitUntil(cache.put(key, response.clone()).catch(() => {}))
          return response
        } catch (error) {
          const cached = await cache.match(key)
          if (cached) return cached
          throw error
        }
      })())
    }) as (event: never) => void,
  )

  scope.addEventListener(
    "message",
    ((event: ShellMessageEvent) => {
      const data = event.data as { action?: unknown } | null | undefined
      if (data?.action === SKIP_WAITING_MESSAGE.action) void scope.skipWaiting()
    }) as (event: never) => void,
  )
}
