import { expect } from "@std/expect"
import { Hono } from "hono"
import {
  inlineBlockHashes,
  nginxAddHeaders,
  securityHeaderList,
  securityHeaders,
  withSecurityHeaders,
} from "./security-headers.ts"

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

const OPTION_SETS: Parameters<typeof securityHeaders>[0][] = [
  undefined,
  {},
  { shellHtml: SHELL },
  {
    shellHtml: SHELL,
    extraSources: {
      scriptSrc: [`https://js.example.com`],
      styleSrc: [`https://css.example.com`],
      imgSrc: [`https://img.example.com`],
      connectSrc: [`https://api.example.com`, `wss://ws.example.com`],
      fontSrc: [`https://fonts.example.com`],
      mediaSrc: [`https://media.example.com`],
      workerSrc: [`blob:`],
      manifestSrc: [`https://cdn.example.com`],
      formAction: [`https://app.example.com`],
    },
  },
]

Deno.test(`the header list and the middleware give the same headers for the same options`, async () => {
  for (const options of OPTION_SETS) {
    const app = new Hono()
    app.use(await securityHeaders(options))
    app.get(`/`, (c) => c.body(null))
    const sent = [...(await app.request(`/`)).headers]

    const list = await securityHeaderList(options)

    expect(sent).toEqual(list)
    expect(list.map(([name]) => name)).toContain(`content-security-policy`)
    expect(list.length).toBeGreaterThanOrEqual(5)
  }
})

Deno.test(`the header list carries the policy and the fixed headers under lower-case names`, async () => {
  const headers = new Map(await securityHeaderList({ shellHtml: SHELL }))
  expect(headers.get(`content-security-policy`)).toContain(`script-src 'self' ${await sha(SCRIPT)}`)
  expect(headers.get(`x-frame-options`)).toBe(`DENY`)
  expect(headers.get(`x-content-type-options`)).toBe(`nosniff`)
  expect(headers.get(`referrer-policy`)).toBe(`no-referrer`)
  expect(headers.get(`strict-transport-security`)).toBe(`max-age=15552000; includeSubDomains`)
})

Deno.test(`the middleware replaces a header the route set and removes X-Powered-By`, async () => {
  const app = new Hono()
  app.use(await securityHeaders())
  app.get(`/`, (c) => {
    c.header(`X-Frame-Options`, `ALLOWALL`)
    c.header(`X-Powered-By`, `Hono`)
    return c.text(`ok`)
  })
  const response = await app.request(`/`)
  await response.body?.cancel()
  expect(response.headers.get(`x-frame-options`)).toBe(`DENY`)
  expect(response.headers.has(`x-powered-by`)).toBe(false)
})

Deno.test(`forms may post to the app's own origin only, unless formAction adds an origin`, async () => {
  const csp = async (options?: Parameters<typeof securityHeaderList>[0]) =>
    new Map(await securityHeaderList(options)).get(`content-security-policy`)?.split(`; `)
  expect(await csp()).toContain(`form-action 'self'`)
  expect(await csp({ extraSources: { formAction: [`https://app.example.com`] } }))
    .toContain(`form-action 'self' https://app.example.com`)
})

const NOT_ONE_SOURCE: [why: string, value: string][] = [
  [`a second directive`, `https://a.example.com;script-src`],
  [`a second policy`, `https://a.example.com,default-src`],
  [`a second source`, `https://a.example.com 'unsafe-inline'`],
  [`a tab`, `https://a.example.com\t*`],
  [`a newline`, `https://a.example.com\nx`],
  [`a carriage return`, `https://a.example.com\rx`],
  [`a character outside ASCII`, `https://é.example.com`],
  [`nothing`, ``],
]

for (const [why, value] of NOT_ONE_SOURCE) {
  Deno.test(`refuses a formAction value that holds ${why}, without repeating the value`, async () => {
    const error = await securityHeaderList({
      extraSources: { formAction: [`https://ok.example`, value] },
    })
      .then(() => undefined, (thrown: Error) => thrown)
    expect(error?.message).toContain(`extraSources.formAction[1]`)
    if (value !== ``) expect(error?.message).not.toContain(value)
  })
}

Deno.test(`refuses a value that is not one source in every directive, in the list and the middleware`, async () => {
  const keys = [
    `scriptSrc`,
    `styleSrc`,
    `imgSrc`,
    `connectSrc`,
    `fontSrc`,
    `mediaSrc`,
    `workerSrc`,
    `manifestSrc`,
    `formAction`,
  ] as const
  for (const key of keys) {
    const options = { extraSources: { [key]: [`https://a.example.com;script-src`] } }
    await expect(securityHeaderList(options)).rejects.toThrow(`extraSources.${key}[0]`)
    await expect(securityHeaders(options)).rejects.toThrow(`extraSources.${key}[0]`)
  }
})

Deno.test(`accepts the source forms a policy uses, an nginx variable among them`, async () => {
  const sources = [
    `https://cdn.example.com`,
    `https://*.example.com:8443/path/`,
    `wss://ws.example.com`,
    `blob:`,
    `'sha256-AAAA+/=='`,
    `$csp_error_tracker`,
  ]
  const csp = new Map(await securityHeaderList({ extraSources: { connectSrc: sources } }))
    .get(`content-security-policy`)
  expect(csp?.split(`; `)).toContain(`connect-src 'self' ${sources.join(` `)}`)
})

Deno.test(`writes each header as one add_header line that nginx also sends with an error page`, async () => {
  const headers = await securityHeaderList({ shellHtml: SHELL })
  const text = nginxAddHeaders(headers)
  expect(text.endsWith(`\n`)).toBe(true)
  expect(text.slice(0, -1).split(`\n`)).toEqual(
    headers.map(([name, value]) => `add_header ${name} "${value}" always;`),
  )
  expect(text).toContain(`add_header x-frame-options "DENY" always;\n`)
  expect(nginxAddHeaders([])).toBe(``)
})

const REFUSED_BY_NGINX: [why: string, value: string][] = [
  [`a double quote`, `ok" always; add_header x-evil "1`],
  [`a backslash`, `ok\\`],
  [`a newline`, `ok\nadd_header x-evil 1;`],
  [`a carriage return`, `ok\rreturn 200;`],
  [`a NUL character`, `ok\u0000`],
  [`a tab`, `ok\tok`],
  [`a DEL character`, `ok\u007f`],
  [`a variable that is not allowed`, `default-src $http_x_evil`],
  [`a variable whose name starts with an allowed one`, `default-src $csp_error_tracker_2`],
  [`an allowed name in braces`, `default-src \${csp_error_tracker}`],
  [`a lone dollar sign`, `costs 5$ here`],
  [`a dollar sign before an allowed variable`, `default-src $$csp_error_tracker`],
  [
    `an allowed variable followed by one that is not`,
    `default-src $csp_error_tracker $http_x_evil`,
  ],
]

for (const [why, value] of REFUSED_BY_NGINX) {
  Deno.test(`the nginx rendering refuses a value that holds ${why}, naming the header only`, () => {
    let message = ``
    try {
      nginxAddHeaders([[`x-ok`, `fine`], [`x-custom`, value]], {
        allowedVariables: [`$csp_error_tracker`],
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(`The value of x-custom cannot be written`)
    expect(message).not.toContain(value)
  })
}

Deno.test(`the nginx rendering writes a declared variable and refuses it when not declared`, () => {
  const headers: [string, string][] = [
    [`content-security-policy`, `connect-src 'self' $csp_error_tracker; img-src 'self' data:`],
  ]
  expect(nginxAddHeaders(headers, { allowedVariables: [`$csp_error_tracker`] })).toBe(
    `add_header content-security-policy "connect-src 'self' $csp_error_tracker; img-src 'self' data:" always;\n`,
  )
  expect(() => nginxAddHeaders(headers)).toThrow(`content-security-policy`)
  expect(() => nginxAddHeaders(headers, { allowedVariables: [`$csp_other`] })).toThrow(
    `content-security-policy`,
  )
})

Deno.test(`the nginx rendering accepts what a real policy holds: quotes, colons, semicolons, hashes`, async () => {
  const [hash] = await inlineBlockHashes(SHELL, `script`)
  const value =
    `script-src 'self' ${hash} https://*.example.com:8443/a?b=c&d=e#f; max-age=1, x=(y) {z}`
  expect(nginxAddHeaders([[`X_Custom-1`, value]])).toBe(
    `add_header X_Custom-1 "${value}" always;\n`,
  )
})

Deno.test(`the nginx rendering refuses a header name that is more than one word`, () => {
  for (const name of [``, `x evil`, `x-a;`, `x-a"`, `x-$a`, `x-a\n`, `x-a{`, `x:a`]) {
    expect(() => nginxAddHeaders([[name, `ok`]])).toThrow(`header name`)
  }
})

Deno.test(`the nginx rendering refuses an allowed variable that is not a dollar sign and a name`, () => {
  for (const variable of [`csp_error_tracker`, `$`, `$a b`, `$a;`, `\${a}`, ``]) {
    expect(() => nginxAddHeaders([], { allowedVariables: [variable] })).toThrow(`allowedVariables`)
  }
})

Deno.test(`a copied response carries the list, its own other headers, its status and its body`, async () => {
  const list = await securityHeaderList()
  const original = new Response(`gone`, {
    status: 410,
    statusText: `Gone for good`,
    headers: { "content-type": `text/plain`, "x-request-id": `r1` },
  })

  const copy = withSecurityHeaders(original, list)

  expect(copy).not.toBe(original)
  for (const [name, value] of list) expect(copy.headers.get(name)).toBe(value)
  expect(copy.headers.get(`content-type`)).toBe(`text/plain`)
  expect(copy.headers.get(`x-request-id`)).toBe(`r1`)
  expect(copy.status).toBe(410)
  expect(copy.statusText).toBe(`Gone for good`)
  expect(await copy.text()).toBe(`gone`)
})

Deno.test(`a copied response has the same headers as the middleware sends for the same route`, async () => {
  const route = () =>
    new Response(`ok`, {
      headers: { "X-Frame-Options": `ALLOWALL`, "X-Powered-By": `Hono`, "x-own": `kept` },
    })
  const app = new Hono()
  app.use(await securityHeaders())
  app.get(`/`, route)
  const sent = await app.request(`/`)
  await sent.body?.cancel()

  const copy = withSecurityHeaders(route(), await securityHeaderList())
  await copy.body?.cancel()

  expect([...copy.headers].sort()).toEqual([...sent.headers].sort())
  expect(copy.headers.get(`x-frame-options`)).toBe(`DENY`)
  expect(copy.headers.has(`x-powered-by`)).toBe(false)
  expect(copy.headers.get(`x-own`)).toBe(`kept`)
})

Deno.test(`a response with immutable headers is copied, not changed`, async () => {
  const redirect = Response.redirect(`https://example.com/next`, 303)
  expect(() => redirect.headers.set(`x-frame-options`, `DENY`)).toThrow(TypeError)

  const copy = withSecurityHeaders(redirect, await securityHeaderList())

  expect(copy.status).toBe(303)
  expect(copy.headers.get(`location`)).toBe(`https://example.com/next`)
  expect(copy.headers.get(`x-frame-options`)).toBe(`DENY`)
  expect(redirect.headers.has(`x-frame-options`)).toBe(false)
})

Deno.test(`a response without a body is copied without one`, async () => {
  const copy = withSecurityHeaders(new Response(null, { status: 204 }), await securityHeaderList())

  expect(copy.status).toBe(204)
  expect(copy.body).toBe(null)
  expect(copy.headers.get(`referrer-policy`)).toBe(`no-referrer`)
})

Deno.test(`a response that cannot be rebuilt is returned as it is`, async () => {
  const list = await securityHeaderList()
  // A WebSocket upgrade answers 101, which `new Response` refuses to build on Node; a stand-in
  // with that status is all the helper reads.
  const upgrade = { status: 101, headers: new Headers({ upgrade: `websocket` }) } as Response
  const failed = Response.error()

  expect(withSecurityHeaders(upgrade, list)).toBe(upgrade)
  expect(withSecurityHeaders(failed, list)).toBe(failed)
})

Deno.test(`a copied response keeps every Set-Cookie header`, async () => {
  const headers = new Headers()
  headers.append(`set-cookie`, `session=1; Path=/; HttpOnly`)
  headers.append(`set-cookie`, `theme=dark; Path=/`)
  const copy = withSecurityHeaders(new Response(`ok`, { headers }), await securityHeaderList())
  expect(copy.headers.getSetCookie()).toEqual([`session=1; Path=/; HttpOnly`, `theme=dark; Path=/`])
})
