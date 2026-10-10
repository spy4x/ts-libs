/**
 * One table of named operations, served by two adapters: the socket and plain HTTP.
 *
 * An app lists what it can do once, as `{ "note.create": { kind: "command", handle } }`. The socket
 * adapter ({@link createOperationDispatcher}, given to `ConnectionRegistry.onRequest`) and the HTTP
 * adapter ({@link createCallHandler}, `POST <base>/<name>`) read the same object, so a command is
 * reachable with or without a socket and the two cannot drift.
 *
 * Both adapters apply the same gate, in the same order, before `handle` runs:
 *
 * 1. the caller is authenticated by the host's own function (the adapters read no cookie);
 * 2. the call is bound to the user the page believes it is ({@link isBoundToUser});
 * 3. the name is an operation of the table, of the kind asked for;
 * 4. a command carries an idempotency key.
 *
 * Errors use the socket's closed code set (`errors.ts`). Anything a handler throws that is not a
 * {@link RealtimeRequestError} is answered `internal` with a generic message, so an exception's text
 * never reaches a client.
 *
 * Server-side and web-standard: `Request` in, `Response` out, no framework, no `Deno.*`.
 *
 * @module
 */

import {
  BodyReadTimeoutError,
  PayloadTooLargeError,
  readBoundedText,
} from "@spy4x/net/bounded-body"

import { type RealtimeErrorCode, RealtimeRequestError } from "./errors.ts"
import type { RequestContext, RequestDispatcher } from "./registry.ts"

/** The header that carries the id of the user the page was started for. */
export const REALTIME_USER_HEADER = "X-Realtime-User"

/** The header that carries a command's idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"

/** The default cap on a call's body, the same as the socket's default frame cap. */
export const DEFAULT_MAX_CALL_BYTES: number = 64 * 1024

// The same bound the socket's codec puts on a frame's `idempotencyKey`.
const MAX_IDEMPOTENCY_KEY_LENGTH = 256
const MAX_USER_ID_LENGTH = 128

const GENERIC_MESSAGE = "internal error"

/** What an operation is given for one call, whichever adapter received it. */
export interface OperationCall<TActor> {
  /** Who is calling, as the host's `authenticate` built it for this call. */
  actor: TActor
  /** The socket frame's id, or an id the HTTP adapter generated. For logs and correlation. */
  requestId: string
  /** Unvalidated: the operation parses it with its own schema. */
  payload: unknown
  /** Present on every command: both adapters refuse a command without one. */
  idempotencyKey?: string
  /** Aborted when the caller goes away; stop work that can be stopped. */
  signal: AbortSignal
}

/** One named operation. It validates its own payload and authorizes the actor itself. */
export interface Operation<TActor> {
  kind: "command" | "query"
  handle(call: OperationCall<TActor>): unknown | Promise<unknown>
}

/** The operations an app serves, by name (`note.create`). Both adapters take this object. */
export type Operations<TActor> = Readonly<Record<string, Operation<TActor>>>

/**
 * Turns an error a handler threw into the typed error the client sees, or `null` for one the client
 * must not be told about.
 */
export type OperationErrorMapper = (error: unknown) => RealtimeRequestError | null

/**
 * Whether a call is bound to the authenticated user.
 *
 * A cookie can change under a running page: another tab signs out and someone else signs in. So a
 * page sends the id of the user it was started for ({@link REALTIME_USER_HEADER}), and the server
 * refuses a call whose session belongs to anyone else. Use it on list routes and in the socket
 * handshake too:
 *
 * ```ts
 * if (!isBoundToUser(request.headers.get(REALTIME_USER_HEADER), session.userId)) return unauthorized()
 * ```
 *
 * It fails closed: a missing, empty or over-long claim is refused, and so is an authenticated id
 * that is empty or not a safe integer. The comparison is exact, so `"07"` is not user `7`.
 *
 * @param claimed The id the caller sent, as text. `null` or `undefined` when it sent none.
 * @param userId The id of the user the session really belongs to.
 */
export function isBoundToUser(
  claimed: string | null | undefined,
  userId: string | number,
): boolean {
  if (typeof claimed !== "string" || claimed.length > MAX_USER_ID_LENGTH) return false
  if (typeof userId === "number") return Number.isSafeInteger(userId) && String(userId) === claimed
  return typeof userId === "string" && userId.length > 0 && userId === claimed
}

/** The HTTP status {@link createCallHandler} answers with for each error code. */
export const CALL_ERROR_STATUS: Readonly<Record<RealtimeErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  timeout: 504,
}

/** What the gate needs to know about a call before the operation may run. */
interface GateInput<TActor> {
  operations: Operations<TActor>
  /** `null` when the host could not authenticate the caller. */
  actor: TActor | null
  userIdOf(actor: TActor): string | number
  claimedUserId: string | null | undefined
  name: string
  /** The kind the caller asked for. HTTP does not send one, so the table's kind decides. */
  kind?: "command" | "query"
  idempotencyKey: string | null | undefined
}

interface GateOutput<TActor> {
  operation: Operation<TActor>
  actor: TActor
  idempotencyKey?: string
}

/**
 * The one gate both adapters pass a call through. It throws the refusal, so neither adapter can
 * reach an operation by forgetting a step.
 *
 * Authentication and the user binding come first, so a caller who is nobody, or somebody else,
 * learns nothing about which names exist.
 */
function admit<TActor>(input: GateInput<TActor>): GateOutput<TActor> {
  const { actor } = input
  if (actor === null || actor === undefined) {
    throw new RealtimeRequestError("unauthorized", "not signed in")
  }
  if (!isBoundToUser(input.claimedUserId, input.userIdOf(actor))) {
    throw new RealtimeRequestError("unauthorized", "the session belongs to another user")
  }
  // An own-property read: `constructor` and `__proto__` are not operations.
  const operation = Object.hasOwn(input.operations, input.name)
    ? input.operations[input.name]
    : undefined
  const kindMatches = input.kind === undefined || operation?.kind === input.kind
  if (
    operation === undefined || !kindMatches || typeof operation.handle !== "function" ||
    (operation.kind !== "command" && operation.kind !== "query")
  ) {
    throw new RealtimeRequestError("not_found", `unknown ${input.kind ?? "operation"}`)
  }
  if (operation.kind !== "command") return { operation, actor }
  const key = input.idempotencyKey
  if (typeof key !== "string" || key.length < 1) {
    throw new RealtimeRequestError("bad_request", "a command needs an idempotency key")
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RealtimeRequestError("bad_request", "the idempotency key is too long")
  }
  return { operation, actor, idempotencyKey: key }
}

/**
 * The typed error a client may read for a thrown value, or `null` when it must see only the generic
 * `internal` answer. An error that names itself `internal` is treated as unexpected too: its message
 * and details stay on the server.
 */
function toClientError(
  error: unknown,
  mapError: OperationErrorMapper | undefined,
): RealtimeRequestError | null {
  let mapped: RealtimeRequestError | null = null
  if (error instanceof RealtimeRequestError) mapped = error
  else if (mapError) {
    try {
      mapped = mapError(error)
    } catch {
      mapped = null
    }
  }
  if (!(mapped instanceof RealtimeRequestError) || mapped.code === "internal") return null
  return mapped
}

/** Options of {@link createOperationDispatcher}. */
export interface OperationDispatcherOptions<TActor> {
  /**
   * The actor for this request, from the session as it is now, or `null` when the session may no
   * longer act. Called for every request, so a revoked session stops at once.
   */
  authenticate(context: RequestContext): TActor | null | Promise<TActor | null>
  /** The id of the user an actor is. Compared with the user the socket was attached for. */
  userIdOf(actor: TActor): string | number
  /** Turns the app's own errors into typed ones. Anything it returns `null` for is `internal`. */
  mapError?: OperationErrorMapper
}

/**
 * The socket adapter: a dispatcher for `ConnectionRegistry.onRequest` that serves an
 * {@link Operations} table.
 *
 * The user binding here is the socket's own: the registry remembers which user a socket was attached
 * for (`context.userId`), and a request whose session now belongs to anyone else is refused
 * `unauthorized`, exactly as the HTTP adapter refuses a wrong {@link REALTIME_USER_HEADER}.
 *
 * An unexpected error is rethrown, so the registry answers `internal` with its generic message and
 * reports the error to `onRequestError`.
 */
export function createOperationDispatcher<TActor>(
  operations: Operations<TActor>,
  options: OperationDispatcherOptions<TActor>,
): RequestDispatcher {
  return async (context) => {
    const actor = await options.authenticate(context)
    const admitted = admit({
      operations,
      actor,
      userIdOf: options.userIdOf,
      claimedUserId: context.userId,
      name: context.name,
      kind: context.kind,
      idempotencyKey: context.idempotencyKey,
    })
    try {
      return await admitted.operation.handle({
        actor: admitted.actor,
        requestId: context.requestId,
        payload: context.payload,
        ...(admitted.idempotencyKey !== undefined
          ? { idempotencyKey: admitted.idempotencyKey }
          : {}),
        signal: context.signal,
      })
    } catch (error) {
      const typed = toClientError(error, options.mapError)
      if (typed) throw typed
      // The registry sends any `RealtimeRequestError` as it is, so one that names itself `internal`
      // is wrapped: its message and details reach `onRequestError`, never the client.
      throw error instanceof RealtimeRequestError
        ? new Error("an operation failed with an internal error", { cause: error })
        : error
    }
  }
}

/** What {@link CallHandlerOptions.onError} is told about the call that failed. */
export interface CallErrorContext {
  /** The operation name from the path, or `null` when the call failed before a name was read. */
  name: string | null
  requestId: string
}

/** Options of {@link createCallHandler}. */
export interface CallHandlerOptions<TActor> {
  /** The path the handler is mounted at, such as `/api/call`. A call is `POST <basePath>/<name>`. */
  basePath: string
  /**
   * The actor for this request, or `null` when nobody is signed in. The handler reads no cookie and
   * checks no `Origin` itself: the app's session gate and origin check live here or in front.
   */
  authenticate(request: Request): TActor | null | Promise<TActor | null>
  /** The id of the user an actor is. Compared with the {@link REALTIME_USER_HEADER} header. */
  userIdOf(actor: TActor): string | number
  /** Turns the app's own errors into typed ones. Anything it returns `null` for is `internal`. */
  mapError?: OperationErrorMapper
  /** Called with every failure the handler hides from the client. Log it here. */
  onError?(error: unknown, context: CallErrorContext): void
  /** The body cap in bytes. Defaults to {@link DEFAULT_MAX_CALL_BYTES}. */
  maxBodyBytes?: number
  /** The longest wait for the next piece of a body, in ms. Defaults to 10 seconds. */
  bodyTimeoutMs?: number
}

/** A web-standard request handler: mount it in Hono with `(c) => handler(c.req.raw)`. */
export type CallHandler = (request: Request) => Promise<Response>

const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
}

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...RESPONSE_HEADERS, ...headers } })
}

const INTERNAL_BODY = JSON.stringify({ error: { code: "internal", message: GENERIC_MESSAGE } })

function refuse(
  code: RealtimeErrorCode,
  message: string,
  details?: unknown,
  status: number = CALL_ERROR_STATUS[code],
  headers?: Record<string, string>,
): Response {
  let body: string
  try {
    body = JSON.stringify({
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    })
  } catch {
    // Details that cannot be encoded (a `BigInt`, a cycle) must not become an unanswered call.
    return respond(CALL_ERROR_STATUS.internal, INTERNAL_BODY)
  }
  return respond(status, body, headers)
}

/** Whether a `Content-Type` value is `application/json`, with or without parameters. */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  return value.split(";")[0].trim().toLowerCase() === "application/json"
}

/**
 * The operation name in a request's path: what follows `<basePath>/`, decoded. `null` when the path
 * is not under the base path or is badly encoded. A path with a further segment is a name with a
 * `/` in it, which is unknown unless the table has it.
 */
function readOperationName(url: string, basePath: string): string | null {
  const prefix = `${basePath}/`
  try {
    const { pathname } = new URL(url)
    return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null
  } catch {
    return null
  }
}

/**
 * The HTTP adapter: answers `POST <basePath>/<name>` from an {@link Operations} table.
 *
 * The wire contract, shared with the client's HTTP calls module:
 *
 * - the body is the payload as JSON (`Content-Type: application/json`); an empty body is a call
 *   with no payload;
 * - `Idempotency-Key` is required on a command and ignored on a query;
 * - {@link REALTIME_USER_HEADER} is required on every call;
 * - success is `200` with `{ "result": <value> }` (`null` when the operation returned nothing);
 * - failure is `{ "error": { "code", "message", "details"? } }` with the socket's code and the
 *   status in {@link CALL_ERROR_STATUS}. Three refusals use a more exact status with the code
 *   `bad_request`: `405` for a method that is not `POST`, `413` for a body over the cap and `415`
 *   for a body that is not declared as JSON; a body that stalls is `408`.
 *
 * Nothing reaches `handle` before authentication and the user-binding check pass, and the body is
 * not read before the call is admitted, so a caller who is refused costs no parsing.
 *
 * The handler never throws and never rejects: every failure is a JSON answer.
 *
 * @throws `RangeError` at creation when `maxBodyBytes` is not a positive finite number or
 * `basePath` does not start with `/`.
 */
export function createCallHandler<TActor>(
  operations: Operations<TActor>,
  options: CallHandlerOptions<TActor>,
): CallHandler {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_CALL_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBodyBytes must be a positive finite number")
  }
  if (!options.basePath.startsWith("/")) throw new RangeError("basePath must start with /")
  const basePath = options.basePath.replace(/\/+$/, "")
  const bodyOptions = {
    maxBytes,
    ...(options.bodyTimeoutMs !== undefined ? { timeoutMs: options.bodyTimeoutMs } : {}),
  }

  const report = (error: unknown, context: CallErrorContext): Response => {
    try {
      options.onError?.(error, context)
    } catch {
      // A failing error hook must not leave the call unanswered.
    }
    return respond(CALL_ERROR_STATUS.internal, INTERNAL_BODY)
  }

  const answerThrown = (error: unknown, context: CallErrorContext): Response => {
    const typed = toClientError(error, options.mapError)
    return typed ? refuse(typed.code, typed.message, typed.details) : report(error, context)
  }

  return async (request) => {
    const requestId = crypto.randomUUID()
    let name: string | null = null
    try {
      if (request.method !== "POST") {
        return refuse("bad_request", "a call is a POST", undefined, 405, { Allow: "POST" })
      }
      name = readOperationName(request.url, basePath)
      if (name === null) return refuse("not_found", "unknown operation")
      if (!isJsonContentType(request.headers.get("Content-Type"))) {
        return refuse("bad_request", "the body must be application/json", undefined, 415)
      }

      const admitted = admit({
        operations,
        actor: await options.authenticate(request),
        userIdOf: options.userIdOf,
        claimedUserId: request.headers.get(REALTIME_USER_HEADER),
        name,
        idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
      })

      let payload: unknown
      try {
        const text = await readBoundedText(request, bodyOptions)
        payload = text.trim() === "" ? undefined : JSON.parse(text)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return refuse("bad_request", "the body is too large", undefined, 413)
        }
        if (error instanceof BodyReadTimeoutError) {
          return refuse("bad_request", "the body took too long to arrive", undefined, 408)
        }
        // A `SyntaxError`, a nesting too deep to parse, or a body the caller stopped sending.
        return refuse("bad_request", "the body is not valid JSON")
      }

      const result = await admitted.operation.handle({
        actor: admitted.actor,
        requestId,
        payload,
        ...(admitted.idempotencyKey !== undefined
          ? { idempotencyKey: admitted.idempotencyKey }
          : {}),
        signal: request.signal,
      })
      // A result that cannot be encoded throws here and is answered `internal` below.
      return respond(200, JSON.stringify({ result: result === undefined ? null : result }))
    } catch (error) {
      return answerThrown(error, { name, requestId })
    }
  }
}
