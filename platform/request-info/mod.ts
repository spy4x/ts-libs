/**
 * `@ts-libs/platform/request-info` — request metadata for a log line or an error report, built
 * from a Hono context.
 *
 * {@link requestInfoFromContext} reads the client IP through `platform/rate-limit/client-ip.ts`'s
 * trust boundary rather than trusting `X-Forwarded-For` unconditionally — see `request-info.ts`
 * for the bug this fixes and the two decisions behind its `Env`-generic, `APIContext`-free
 * signature.
 */

export {
  type RequestInfo,
  requestInfoFromContext,
  type RequestInfoOptions,
} from "./request-info.ts"
