import { defaultFetcher } from "./safe-fetch.ts"
import type { ReceivedRequest, ResponseSpec } from "./_fake-fetcher.test.ts"
import { describeFetcherContract } from "./fetcher-contract.test.ts"

/** The platform "fetch", behind "defaultFetcher", against a real server on an ephemeral port. */
describeFetcherContract("defaultFetcher over loopback", async () => {
  const routes = new Map<string, ResponseSpec>()
  const requests: ReceivedRequest[] = []
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (request) => {
    const url = new URL(request.url)
    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
    })
    const spec = routes.get(url.pathname) ?? { status: 404 }
    if (spec.hang) {
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(new Response(null)), { once: true })
      })
    }
    let body: BodyInit | null = null
    if (typeof spec.body === "string") {
      body = spec.body
    } else if (spec.body !== undefined || spec.stall) {
      const chunks = spec.body ?? []
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          if (!spec.stall) controller.close()
        },
      })
    }
    return new Response(body, { status: spec.status ?? 200, headers: spec.headers })
  })
  const base = `http://127.0.0.1:${server.addr.port}`
  return {
    fetcher: defaultFetcher,
    serve: (path, spec) => {
      routes.set(new URL(path, base).pathname, spec)
      return base + path
    },
    requests,
    close: () => server.shutdown(),
  }
})
