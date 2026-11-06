# @spy4x/integrations

Outbound integration clients and inbound webhook verification. Zero dependencies, no SDKs — every
client is a thin `fetch` wrapper with an injectable transport.

## Install

```bash
deno add jsr:@spy4x/integrations
```

Runs on: server (Deno).

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/integrations`](mod.ts): Outbound integration clients and inbound webhook verification.
- [`@spy4x/integrations/webhooks`](webhooks.ts): Inbound webhook verification.
- [`@spy4x/integrations/ntfy`](ntfy.ts): Ntfy push client — failure-only, retrying, header-safe.
- [`@spy4x/integrations/healthchecks`](healthchecks.ts): Healthchecks.io dead-man's-switch client.
- [`@spy4x/integrations/cloudflare`](cloudflare.ts): Cloudflare cache purge by URL.
- [`@spy4x/integrations/indexnow`](indexnow.ts): IndexNow.
- [`@spy4x/integrations/devto`](devto.ts): Dev.to (Forem API v1).
- [`@spy4x/integrations/mastodon`](mastodon.ts): Mastodon: post a status and read back how it did.
- [`@spy4x/integrations/bluesky`](bluesky.ts): Bluesky (AT Protocol): sign in with an app password, post a link with its card, find that post again, and read back how it did.
- [`@spy4x/integrations/share-results`](share-results.ts): The numbers a channel reports for one shared copy of a post, in one shape for every channel.
- [`@spy4x/integrations/reddit`](reddit.ts): Reddit: read how a submitted post did, and find the posts that link to an address.
- [`@spy4x/integrations/hackernews`](hackernews.ts): Hacker News: read how a story did, and find the stories that link to an address.
- [`@spy4x/integrations/umami`](umami.ts): A small client for a self-hosted Umami (v3).
- [`@spy4x/integrations/push`](push.ts): Web Push sender.
- [`@spy4x/integrations/push-file-store`](push-file-store.ts): A push subscription store for an app with no database.
- [`@spy4x/integrations/push-reminders`](push-reminders.ts): The glue between a reminder runner and a Web Push sender.
- [`@spy4x/integrations/telegram`](telegram.ts): Telegram bots.
- [`@spy4x/integrations/llm`](llm.ts): A JSON chat client for any OpenAI-compatible model API.
- [`@spy4x/integrations/exchange-rates`](exchange-rates.ts): Daily exchange rates from Frankfurter, exchangerate-api.com and CoinGecko behind one interface, `ExchangeRateSource`, and `withFallback`, which asks the next source only for the quotes the sources before it lacked.
