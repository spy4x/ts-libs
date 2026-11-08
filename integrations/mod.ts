/**
 * `@spy4x/integrations` — outbound integration clients and inbound webhook
 * verification. Every client is a thin `fetch` wrapper with an injectable
 * transport, so nothing here needs network access to be tested.
 *
 * ## Injectable transport
 *
 * Read the sections below before writing a _unit_ test that touches the network. It cannot: the unit
 * suite runs under `--allow-read --allow-env` with no `--allow-net`. The integration tier is the one
 * exception — see below.
 *
 * - **`fetcher?: typeof fetch`** — defaults to `globalThis.fetch`. No unit test in this package
 *   performs a real request.
 * - **`sleep?: (ms: number) => Promise<void>` and `clock?: () => number`** — the retry loop measures
 *   its budget through the injected clock and waits through the injected sleeper. Unit tests supply a
 *   recording timer plus a manual clock, so nothing sleeps and nothing asserts on wall-clock time.
 * - **`backoff?: BackoffFn` and `random?: RandomSource`** — the delay computation, and the source its
 *   jitter draws from (`Math.random` unless a caller injects another, so two processes with jitter
 *   enabled do not compute the same "random" delay). `onDelay` observes every requested delay, which
 *   is how a test asserts _"asked for exactly 2 seconds"_ without waiting for them.
 * - **`requestTimeoutMs?: number`** — bounds one request via `AbortSignal.timeout()`. Defaults to
 *   `DEFAULT_REQUEST_TIMEOUT_MS` (10s, `retry.ts`) and is clamped to whatever `totalBudgetMs` has left
 *   for the attempt about to run, so a generous per-request timeout can never itself outrun the budget
 *   it is nested inside. A timed-out request reports `code: "timeout"`, distinct from the generic
 *   `"network_error"` a transport throw gets.
 * - **Console silence is asserted, not assumed.** `integrations/console.test.ts` installs a
 *   process-wide capture _before_ importing the modules and drives every path of both clients —
 *   delivered, below-gate skip, 4xx, 5xx retried to success, transport throw — asserting nothing is
 *   logged. A per-suite capture only covers that suite's branches, which is how a restored 4xx
 *   `console.error` survived a green run in the clients this replaced.
 * - **Secrets are constructor parameters.** No module reads `$env` at import time and no secret is
 *   logged. The `*ConfigFromEnv(read?)` helpers take a reader, so a test injects a fake environment.
 *
 * ### Integration tier
 *
 * `ntfy.integration.test.ts` and `healthchecks.integration.test.ts` (`deno task test:integration`) run
 * the real client against a real HTTP server the test itself starts on `127.0.0.1` with
 * `Deno.serve({ port: 0 })` — no container, nothing reachable outside loopback. They exist because a
 * fake `fetch` that always resolves synchronously cannot prove a timeout actually bounds a hanging
 * request: these tests start a server that never answers and assert the call still returns, with
 * `code: "timeout"`, inside the configured budget, and a server that fails twice before succeeding to
 * prove a retry actually recovers over a real socket.
 *
 * ## Retry policy
 *
 * The retry mechanism is `retry.ts`, shared by `ntfy.ts`, `healthchecks.ts` and `webhooks.ts`'s
 * callers, and it is the only copy in the repository.
 *
 * Transient statuses are `429` and `5xx`; every other `4xx` is permanent. `Retry-After` in the
 * delay-seconds form wins over the computed backoff, then the same per-wait ceiling applies, so a
 * provider asking for a day cannot pin a process for a day. The HTTP-date form is ignored: it needs a
 * wall clock, and a skewed client clock would turn a hint into a multi-hour stall. Attempts and total
 * elapsed time are both capped.
 *
 * **Every request is bounded, and the budget is real.** Every
 * attempt runs under `AbortSignal.timeout()`, clamped to whatever `totalBudgetMs` has left, so the
 * budget bounds the whole operation, not just the gaps between attempts. `NtfyClient`'s and
 * `HealthchecksClient`'s shipped policies both use `jitterRatio: 0.2`, and jitter draws from a real
 * random source (`Math.random` by default) instead of a formula of `attempt` and `retryAfterMs`: two
 * processes retrying the same call, with no options overridden, do not compute the identical
 * delay — the "settings that ship" tests in `ntfy.test.ts` and `healthchecks.test.ts` construct a
 * client with no `retry` or `random` override at all and assert exactly that.
 *
 * ## Out of scope
 *
 * - **Block Kit payloads, event-bus wiring and any other domain-bound glue.** This package ships
 *   clients, not the wiring around them.
 * - **A webhook router.** `verifyWebhookRequest` verifies. Routing, idempotency and retry queues are
 *   the caller's job.
 * - **Backup, deploy, env tooling.** A project built from the template has them in its own
 *   `infra/scripts/`.
 * - **Email and SMTP**, `server/email`.
 *
 * @module
 */

export { verifyWebhookRequest } from "./webhooks.ts"
export type {
  CombinedSignatureHeader,
  WebhookRejectReason,
  WebhookVerifierConfig,
  WebhookVerifyResult,
} from "./webhooks.ts"

export {
  HealthchecksClient,
  healthchecksConfigFromEnv,
  HealthchecksOutcome,
} from "./healthchecks.ts"
export type {
  HealthchecksClientConfig,
  HealthchecksClientOptions,
  HealthchecksErrorCode,
  HealthchecksFailure,
  HealthchecksPing,
  HealthchecksResult,
  HealthchecksRetryOptions,
  HealthchecksSuccess,
} from "./healthchecks.ts"

export { PURGE_BATCH_SIZE, purgeUrls } from "./cloudflare.ts"
export type { CloudflarePurgeOptions, CloudflarePurgeResult } from "./cloudflare.ts"

export { INDEXNOW_MAX_URLS, submitIndexNow } from "./indexnow.ts"
export type { IndexNowOptions, IndexNowResult } from "./indexnow.ts"

export {
  createDevtoArticle,
  DEVTO_MAX_PAGES,
  DEVTO_MAX_TAGS,
  DEVTO_PAGE_SIZE,
  findDevtoArticleByCanonical,
  readDevtoArticleResults,
} from "./devto.ts"
export type {
  CreateDevtoArticleOptions,
  DevtoArticleInput,
  DevtoArticleRef,
  DevtoClientOptions,
  DevtoCreateResult,
  DevtoFindResult,
  DevtoResultsResult,
  FindDevtoArticleByCanonicalOptions,
  ReadDevtoArticleResultsOptions,
} from "./devto.ts"

export { postMastodonStatus, readMastodonStatusResults } from "./mastodon.ts"
export type {
  MastodonClientOptions,
  MastodonPostResult,
  MastodonResultsResult,
  MastodonStatusRef,
  MastodonStatusResults,
  MastodonVisibility,
  PostMastodonStatusOptions,
  ReadMastodonStatusResultsOptions,
} from "./mastodon.ts"

export {
  BLUESKY_DEFAULT_SERVICE,
  BLUESKY_FEED_PAGES,
  BLUESKY_MAX_GRAPHEMES,
  BLUESKY_MAX_TEXT_BYTES,
  BLUESKY_MAX_THUMB_BYTES,
  BLUESKY_PUBLIC_APPVIEW,
  createBlueskySession,
  findBlueskyPostByLink,
  postBlueskyLink,
  readBlueskyPostResults,
  resolveBlueskyHandle,
  uploadBlueskyBlob,
} from "./bluesky.ts"
export type {
  BlueskyBlob,
  BlueskyBlobResult,
  BlueskyFindResult,
  BlueskyHandleResult,
  BlueskyLinkCard,
  BlueskyPostRef,
  BlueskyPostResult,
  BlueskyPostResults,
  BlueskyResultsResult,
  BlueskySession,
  BlueskySessionResult,
  CreateBlueskySessionOptions,
  FindBlueskyPostByLinkOptions,
  PostBlueskyLinkOptions,
  ReadBlueskyPostResultsOptions,
  ResolveBlueskyHandleOptions,
  UploadBlueskyBlobOptions,
} from "./bluesky.ts"
export type { ShareResults } from "./share-results.ts"

export { findRedditPostsByUrl, readRedditPostResults, REDDIT_INFO_LIMIT } from "./reddit.ts"
export type {
  FindRedditPostsByUrlOptions,
  ReadRedditPostResultsOptions,
  RedditClientOptions,
  RedditFindResult,
  RedditPostRef,
  RedditPostResults,
  RedditResultsResult,
} from "./reddit.ts"

export {
  findHackerNewsStoriesByUrl,
  HACKERNEWS_SEARCH_LIMIT,
  readHackerNewsItemResults,
} from "./hackernews.ts"
export type {
  FindHackerNewsStoriesByUrlOptions,
  HackerNewsFindResult,
  HackerNewsResultsResult,
  HackerNewsStoryRef,
  ReadHackerNewsItemResultsOptions,
} from "./hackernews.ts"

export {
  findHashnodePostBySlug,
  HASHNODE_API,
  HASHNODE_MAX_TAGS,
  publishHashnodePost,
  readHashnodePostResults,
} from "./hashnode.ts"
export type {
  FindHashnodePostBySlugOptions,
  HashnodeClientOptions,
  HashnodeFindResult,
  HashnodePostRef,
  HashnodePublicationRef,
  HashnodePublishResult,
  HashnodeResultsResult,
  PublishHashnodePostOptions,
  ReadHashnodePostResultsOptions,
} from "./hashnode.ts"

export {
  exchangeLinkedinCode,
  LINKEDIN_DEFAULT_SCOPES,
  LINKEDIN_MAX_COMMENTARY,
  LINKEDIN_VERSION,
  linkedinAuthorizeUrl,
  postLinkedinShare,
  readLinkedinMember,
} from "./linkedin.ts"
export type {
  ExchangeLinkedinCodeOptions,
  LinkedinAuthorizeUrlOptions,
  LinkedinMember,
  LinkedinMemberOptions,
  LinkedinMemberResult,
  LinkedinPostRef,
  LinkedinShareLink,
  LinkedinShareResult,
  LinkedinTokens,
  LinkedinTokensResult,
  PostLinkedinShareOptions,
} from "./linkedin.ts"

export {
  checkUmami,
  checkUmamiWebsite,
  createUmamiLink,
  readUmamiEventValues,
  readUmamiMetrics,
  readUmamiPageviews,
  readUmamiStats,
  UMAMI_FILTER_NAMES,
  UMAMI_LINK_NAME_MAX,
  UMAMI_LINK_URL_MAX,
  UMAMI_METRIC_TYPES,
  UMAMI_SERIES_UNITS,
  UMAMI_SLUG_PATTERN,
  umamiLinkUrl,
} from "./umami.ts"
export type {
  UmamiCheckResult,
  UmamiConnection,
  UmamiFilterName,
  UmamiLink,
  UmamiLinkCreateOptions,
  UmamiLinkResult,
  UmamiMetric,
  UmamiMetricType,
  UmamiPageviews,
  UmamiPoint,
  UmamiPropertyValue,
  UmamiReadResult,
  UmamiSeries,
  UmamiStats,
  UmamiTotals,
  UmamiWebsiteCheck,
  UmamiWebsiteProblem,
  UmamiWebsiteRead,
} from "./umami.ts"

export {
  COINGECKO_COINS,
  createCoinGeckoRates,
  createExchangeRateApiRates,
  createFrankfurterRates,
  FRANKFURTER_URL,
  withFallback,
} from "./exchange-rates.ts"
export type {
  CoinGeckoPlan,
  CoinGeckoRatesOptions,
  ExchangeRateApiRatesOptions,
  ExchangeRateClientOptions,
  ExchangeRateSource,
  FrankfurterRatesOptions,
  Rates,
  RatesError,
  RatesErrorCode,
  RatesResult,
} from "./exchange-rates.ts"

export { chatJson, createChatClient, LLM_DEFAULT_TIMEOUT_MS, LLM_PRESETS } from "./llm.ts"
export type {
  ChatClient,
  ChatClientOptions,
  ChatJsonRequest,
  ChatJsonResult,
  ChatMessage,
  LlmEndpoint,
  LlmError,
  LlmErrorCode,
  LlmUsage,
  SpendGuard,
  SpendRequest,
} from "./llm.ts"

export { NotificationSeverity, NtfyClient, ntfyConfigFromEnv, NtfyPriority } from "./ntfy.ts"
export type {
  NtfyClientConfig,
  NtfyClientOptions,
  NtfyErrorCode,
  NtfyFailure,
  NtfyPush,
  NtfyPushed,
  NtfyResult,
  NtfyRetryOptions,
  NtfySkipped,
} from "./ntfy.ts"

export {
  createExponentialBackoff,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isPermanentStatus,
  isRequestTimeout,
  isTransientStatus,
  parseRetryAfterMs,
  releaseResponseBody,
  runWithRetry,
  settle,
} from "./retry.ts"
export type {
  BackoffFn,
  Clock,
  RandomSource,
  RetryPolicy,
  RetryRunOptions,
  RetryRunResult,
  Sleeper,
} from "./retry.ts"
