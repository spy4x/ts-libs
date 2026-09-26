<div align="center">

# ts-libs

**Small TypeScript libraries on web standards, for the server and the browser.**

[![CI](https://ci.antonshubin.com/api/badges/10/status.svg)](https://ci.antonshubin.com/repos/spy4x/ts-libs)
[![JSR](https://jsr.io/badges/@spy4x)](https://jsr.io/@spy4x)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Packages on JSR](https://jsr.io/@spy4x) · [Contributing](CONTRIBUTING.md) ·
[1.0 contract](docs/1.0-contract.md)

</div>

```ts
import { type } from "arktype"
import { validate } from "@spy4x/validation"
import { formatDateTimeLong } from "@spy4x/time/tz"
import { createSmtpSender } from "@spy4x/email/smtp"

const Booking = type({ email: "string.email", date: /^\d{4}-\d\d-\d\d$/, time: /^\d\d:\d\d$/ })
const mail = createSmtpSender({
  host: "smtp.example.com",
  port: 587,
  user: "jane@example.com",
  pass: Deno.env.get("SMTP_PASSWORD")!,
  from: "Jane Doe <jane@example.com>",
})

Deno.serve(async (request) => {
  const { error, data } = validate(Booking, await request.json())
  if (error) return Response.json(error.errors, { status: 400 })

  const when = formatDateTimeLong(data.date, data.time, "Europe/Berlin")
  const sent = await mail.send({ to: [data.email], subject: "Booked", text: `See you ${when}.` })
  return sent.ok ? new Response("Booked") : new Response(sent.error, { status: 502 })
})
```

## Packages

**server** means Deno on the back end, **browser** a front-end bundle, **shared** both.

| Package                                                     | What it holds                                                              | Runs on                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| [`@spy4x/validation`](https://jsr.io/@spy4x/validation)     | arktype `validate` with one result shape, and form-validation state        | shared                 |
| [`@spy4x/platform`](https://jsr.io/@spy4x/platform)         | helpers, command and event bus, cache, API result, tokens, rate limiting   | shared, split by entry |
| [`@spy4x/server`](https://jsr.io/@spy4x/server)             | sign-in, accounts, Postgres, Redis, outbox, file storage, env encryption   | server                 |
| [`@spy4x/net`](https://jsr.io/@spy4x/net)                   | SSRF guard, redirect-safe `fetch`, size-capped body readers, CIDR checks   | server                 |
| [`@spy4x/integrations`](https://jsr.io/@spy4x/integrations) | ntfy and healthchecks.io clients, webhook signature check, retry backoff   | server                 |
| [`@spy4x/time`](https://jsr.io/@spy4x/time)                 | IANA time-zone arithmetic on `Intl`, plain-date math, `.ics` writer        | shared                 |
| [`@spy4x/email`](https://jsr.io/@spy4x/email)               | SMTP sender, address parsing, HTML mail wrapper, DKIM checker              | server                 |
| [`@spy4x/realtime`](https://jsr.io/@spy4x/realtime)         | hint-only WebSocket transport: registry, heartbeat, reconnect, cursor sync | both halves            |

Each package's README, shown on its JSR page, has the install line, entry points and examples.
`ai/` (chat completion, JSON recovery) is planned, not built (#11, #76).

The example above validates a booking request, formats its time in Berlin and sends a confirmation
by SMTP: three packages, no framework. `Deno.serve` hands in a standard `Request`, and each package
returns a plain value you check.

No Preact, no app shells, no product domain. Everything here is a technical primitive or adapter
that is useful to more than one product, extracted from my own apps, with their bugs fixed on the
way in.

## Why ts-libs

- **Web standards first.** `fetch`, Web Crypto, `ReadableStream`, `Intl` and ES modules, with Deno
  as the runtime.
- **Runs where the code allows.** Every package is tested on Deno. `@spy4x/time` and
  `@spy4x/validation` use no `Deno.*` API, so they also run in a browser, untested there.
- **Expected failures are data.** `validate` returns `{ error, data }`, `send` resolves with
  `ok: false` instead of throwing, and `@spy4x/platform` has `Result`, `ok` and `err` for your code.
- **Few dependencies.** `@spy4x/net`, `@spy4x/time` and `@spy4x/integrations` have none. Shared
  ones (arktype, Hono, Postgres) are pinned to exact versions.
- **Tested against the real thing.** Unit tests use fakes; an integration tier runs against a real
  Postgres, S3-compatible store, mail server and Redis, and fails instead of skipping.

**Use it if** you build on Deno or ship a browser bundle and want small, typed primitives without a
framework. **Skip it if** you need tested Node.js support or UI components (those live in
[spy4x/preact-components](https://github.com/spy4x/preact-components)).

## Quick start

```bash
# arktype at the exact version @spy4x/validation pins, so both see one copy of its types
deno add jsr:@spy4x/validation jsr:@spy4x/time jsr:@spy4x/email npm:arktype@2.2.3
# save the example above as main.ts, then:
SMTP_PASSWORD=not-real deno run --allow-net --allow-env main.ts
curl -d '{"email":"nope","date":"2026-08-28","time":"10:00"}' localhost:8000
# {"email":[{"code":"pattern","path":"email","message":"must be an email address (was \"nope\")"}]}
```

## Development

```bash
deno task check                                          # fmt, lint, type check, unit tests
deno task services:up && deno task test:integration      # the integration tier
```

How the repository is built, tested and released: [CONTRIBUTING.md](CONTRIBUTING.md).

## Built by

I'm [Anton Shubin](https://antonshubin.com), a senior full-stack engineer and tech lead. These
libraries are the building blocks of the products I build and run on my own servers: my meeting
scheduler [mig](https://github.com/spy4x/mig) imports `@spy4x/time` and `@spy4x/platform`. Need
something like it built for your product? [That's my day job →](https://antonshubin.com)

Licensed under [MIT](LICENSE). Copyright (c) 2026 Anton Shubin.

---

Made by Anton Shubin · [antonshubin.com/tools/ts-libs](https://antonshubin.com/tools/ts-libs)
