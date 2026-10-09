import { expect } from "@std/expect"
import { Hono } from "hono"
import { inlineBlockHashes, securityHeaders } from "./security-headers.ts"

const STYLE = `\nbody {\n  margin: 0;\n}\n`
const SCRIPT = `\ndocument.documentElement.dataset.ready = "1"\n`
const SHELL = `<html><head><style>${STYLE}</style><script>${SCRIPT}</script>` +
  `<script src="/app.js">fallback()</script><script></script></head></html>`

async function sha(body: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(body)),
  )
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`
}

async function policy(options?: Parameters<typeof securityHeaders>[0]) {
  const app = new Hono()
  app.use(await securityHeaders(options))
  app.get(`/`, (c) => c.text(`ok`))
  const response = await app.request(`/`)
  await response.body?.cancel()
  return response
}

Deno.test(`hashes each inline block and skips external scripts and empty blocks`, async () => {
  expect(await inlineBlockHashes(SHELL, `script`)).toEqual([await sha(SCRIPT)])
  expect(await inlineBlockHashes(SHELL, `style`)).toEqual([await sha(STYLE)])
})

Deno.test(`denies framing, sniffing and referrers on every response`, async () => {
  const response = await policy()
  expect(response.headers.get(`x-frame-options`)).toBe(`DENY`)
  expect(response.headers.get(`x-content-type-options`)).toBe(`nosniff`)
  expect(response.headers.get(`referrer-policy`)).toBe(`no-referrer`)
  expect(response.headers.get(`content-security-policy`)).toContain(`frame-ancestors 'none'`)
})

Deno.test(`allows the shell's inline blocks by hash and never unsafe-inline`, async () => {
  const csp = (await policy({ shellHtml: SHELL })).headers.get(`content-security-policy`) ?? ``
  expect(csp).toContain(`script-src 'self' ${await sha(SCRIPT)}`)
  expect(csp).toContain(`style-src 'self' ${await sha(STYLE)}`)
  expect(csp).not.toContain(`unsafe-inline`)
  expect(csp).not.toContain(`unsafe-eval`)
})

Deno.test(`a consumer's extra sources are appended to the defaults, not replacing them`, async () => {
  const csp = (await policy({
    extraSources: {
      imgSrc: [`https://img.example.com`],
      connectSrc: [`https://api.example.com`],
      fontSrc: [`https://fonts.example.com`],
    },
  })).headers.get(`content-security-policy`) ?? ``
  expect(csp).toContain(`img-src 'self' data: https://img.example.com`)
  expect(csp).toContain(`connect-src 'self' https://api.example.com`)
  expect(csp).toContain(`font-src 'self' https://fonts.example.com`)
  expect(csp).toContain(`default-src 'self'`)
})

Deno.test(`without extra sources no font, media, worker or manifest directive is added`, async () => {
  const csp = (await policy()).headers.get(`content-security-policy`) ?? ``
  for (const name of [`font-src`, `media-src`, `worker-src`, `manifest-src`]) {
    expect(csp).not.toContain(name)
  }
  expect(csp).toContain(`object-src 'none'`)
})

Deno.test(`widening workerSrc, mediaSrc or manifestSrc keeps the app's own origin allowed`, async () => {
  const csp = (await policy({
    extraSources: {
      workerSrc: [`blob:`],
      mediaSrc: [`https://media.example.com`],
      manifestSrc: [`https://cdn.example.com`],
    },
  })).headers.get(`content-security-policy`) ?? ``
  expect(csp).toContain(`worker-src 'self' blob:`)
  expect(csp).toContain(`media-src 'self' https://media.example.com`)
  expect(csp).toContain(`manifest-src 'self' https://cdn.example.com`)
})
