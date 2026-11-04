/**
 * Daily exchange rates from Frankfurter, exchangerate-api.com and CoinGecko behind one interface,
 * {@link ExchangeRateSource}, and {@link withFallback}, which asks the next source only for the
 * quotes the sources before it lacked.
 *
 * Behaviour:
 *
 *  - `daily` never throws. It returns `{ success, output, error }`: the rates it found and the
 *    quotes it has no rate for, or the source's id and the reason it failed.
 *  - A quote with no rate is listed in `missing`, never given a rate of `0`.
 *  - Each rate carries the date it is really for, which can be earlier than the date asked: on a
 *    weekend or a holiday Frankfurter answers with the last business day.
 *  - A rate is a plain decimal string (`"0.000012907"`, never `1.2907e-5`), kept only when the
 *    source sent a finite number above zero. There is no upper limit: a bitcoin priced in dong is
 *    in the billions.
 *  - No error contains a URL or a key. exchangerate-api.com takes its key in the URL path, so a
 *    transport failure is reported by class name only (`describeTransportError`), and an API
 *    failure by status and a fixed description. Replies are read under a 256 KiB cap, and every
 *    request is bounded by `AbortSignal.timeout`. Redirects are not followed.
 *
 * Reply shapes were recorded from the live APIs on 2026-11-04 (Frankfurter v2, CoinGecko's public
 * `/coins/{id}/history`, exchangerate-api.com's error reply) and taken from exchangerate-api.com's
 * documentation for its paid history reply; the recordings are in `fixtures/`.
 * @module
 */

import { type } from "arktype"
import { BodyReadTimeoutError, readBoundedJson } from "@spy4x/net/bounded-body"
import type { ExchangeRate } from "@spy4x/platform/universal/money"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTransportError,
  isRequestTimeout,
  releaseResponseBody,
} from "./retry.ts"

/** Why a call failed. Branch on it, never on `message`. */
export type RatesErrorCode =
  | "invalid-request"
  | "unauthorized"
  | "quota-reached"
  | "plan-limit"
  | "rate-limited"
  | "unavailable"
  | "http-error"
  | "redirected"
  | "timeout"
  | "network-error"
  | "invalid-reply"

/** A failed call: which source, and why. `message` never holds a URL or a key. */
export interface RatesError {
  source: string
  code: RatesErrorCode
  message: string
  /** The HTTP status, when the server answered with one. */
  status?: number
}

/** What a source found for one day. */
export interface Rates {
  rates: ExchangeRate[]
  /** The asked quotes with no rate, in the order asked. */
  missing: string[]
  /** Set by {@link withFallback}: the sources that failed and were skipped. */
  failures?: RatesError[]
}

/** Outcome of {@link ExchangeRateSource.daily}. */
export type RatesResult =
  | { success: true; output: Rates; error: null }
  | { success: false; output: null; error: RatesError }

/** A provider of daily exchange rates. */
export interface ExchangeRateSource {
  /** Names the source in every error and in each rate's `source`. */
  readonly id: string
  /**
   * The rates of `base` to each of `quotes` on `date` (`YYYY-MM-DD`). Codes are upper case
   * (`EUR`, `BTC`). A rate may come quoted the other way round (`BTC`→`USD` when `USD`→`BTC` was
   * asked), which `convertMoney` and `crossRate` accept as they are.
   */
  daily(date: string, base: string, quotes: readonly string[]): Promise<RatesResult>
}

/** Options every client takes. */
export interface ExchangeRateClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Per request; defaults to `DEFAULT_REQUEST_TIMEOUT_MS` (10 s). */
  timeoutMs?: number
}

const MAX_REPLY_BYTES = 256 * 1024
const CODE = /^[A-Z][A-Z0-9]{1,9}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `value` as a plain decimal string, or `undefined` unless it is a finite number above zero.
 * `String` gives the shortest text that reads back as the same number, and uses exponent
 * notation below `1e-6` and from `1e21`; the digits are moved around the point instead.
 */
const plainDecimal = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  const text = String(value)
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text)
  if (!match) return text
  const digits = match[1] + (match[2] ?? "")
  const point = 1 + Number(match[3])
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return digits + "0".repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

const isCalendarDate = (date: unknown): date is string => {
  if (typeof date !== "string" || !DATE.test(date)) return false
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
}

/** The quotes without repeats, or why the question cannot be asked. */
const checkAsk = (date: unknown, base: unknown, quotes: unknown): string[] | string => {
  if (!isCalendarDate(date)) return "date must be a calendar date, YYYY-MM-DD"
  if (typeof base !== "string" || !CODE.test(base)) return "base must be an upper-case code"
  if (
    !Array.isArray(quotes) ||
    !quotes.every((quote) => typeof quote === "string" && CODE.test(quote))
  ) {
    return "quotes must be upper-case codes"
  }
  return [...new Set(quotes as string[])]
}

const failure = (
  source: string,
  code: RatesErrorCode,
  message: string,
  status?: number,
): RatesResult => ({
  success: false,
  output: null,
  error: { source, code, message, ...(status === undefined ? {} : { status }) },
})

const found = (rates: ExchangeRate[], quotes: readonly string[], base: string): RatesResult => {
  const covered = new Set(rates.map((rate) => otherSide(rate, base)))
  return {
    success: true,
    output: { rates, missing: quotes.filter((quote) => !covered.has(quote)) },
    error: null,
  }
}

/** The currency `rate` prices against `base`, or `undefined` when `base` is on neither side. */
const otherSide = (rate: ExchangeRate, base: string): string | undefined =>
  rate.base === base ? rate.quote : rate.quote === base ? rate.base : undefined

const statusFailure = (source: string, status: number): RatesResult =>
  failure(
    source,
    status === 401 || status === 403
      ? "unauthorized"
      : status === 429
      ? "rate-limited"
      : status >= 500
      ? "unavailable"
      : "http-error",
    `the server answered HTTP ${status}`,
    status,
  )

interface Transport {
  source: string
  fetch: typeof fetch
  timeoutMs: number
  headers?: Record<string, string>
}

/**
 * The answer's status and JSON body, or the failure. On an error status, a body that is not JSON
 * reads as `undefined`, so the caller reports the status alone.
 */
const getJson = async (
  transport: Transport,
  url: string,
): Promise<{ status: number; body: unknown } | RatesResult> => {
  const { source, timeoutMs } = transport
  const timedOut = () => failure(source, "timeout", `no reply within ${timeoutMs} ms`)
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await transport.fetch(url, {
      headers: { Accept: "application/json", ...transport.headers },
      redirect: "manual",
      signal,
    })
  } catch (cause) {
    if (isRequestTimeout(cause)) return timedOut()
    return failure(source, "network-error", `request failed (${describeTransportError(cause)})`)
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await releaseResponseBody(response).catch(() => {})
    return failure(
      source,
      "redirected",
      "the server answered with a redirect, which is not followed",
    )
  }
  try {
    return {
      status: response.status,
      body: await readBoundedJson(response, { maxBytes: MAX_REPLY_BYTES, timeoutMs }),
    }
  } catch (cause) {
    if (isRequestTimeout(cause) || cause instanceof BodyReadTimeoutError || signal.aborted) {
      return timedOut()
    }
    if (!response.ok) return { status: response.status, body: undefined }
    return failure(
      source,
      "invalid-reply",
      cause instanceof SyntaxError
        ? "the reply is not JSON"
        : `the reply could not be read (${describeTransportError(cause)})`,
    )
  }
}

const isFailure = (value: { status: number; body: unknown } | RatesResult): value is RatesResult =>
  "success" in value

/** Checks `fetch` and `timeoutMs`, naming the option and never its value. */
const transportOf = (
  name: string,
  source: string,
  options: ExchangeRateClientOptions,
): Transport => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`${name}: timeoutMs must be a positive number`)
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new TypeError(`${name}: fetch must be a function`)
  }
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  return { source, fetch: doFetch, timeoutMs }
}

const checkOptions = (name: string, options: unknown): void => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${name}: expected an options object`)
  }
}

// ---------------------------------------------------------------------------------------------
// Frankfurter

/** Frankfurter's public instance. */
export const FRANKFURTER_URL = "https://api.frankfurter.dev"

/** Options of {@link createFrankfurterRates}. */
export interface FrankfurterRatesOptions extends ExchangeRateClientOptions {
  /** A self-hosted Frankfurter; defaults to {@link FRANKFURTER_URL}. */
  baseUrl?: string
  /** Frankfurter's provider codes to keep to, such as `["ECB"]`; all of them by default. */
  providers?: readonly string[]
}

const FrankfurterReply = type({ date: "string", base: "string", quote: "string", rate: "unknown" })
  .array()
const FrankfurterRefusal = type({ message: "string" })
const PROVIDER = /^[A-Z0-9_]{1,20}$/

/**
 * Rates from Frankfurter v2 (`GET /v2/rates?date=&base=&quotes=`), which needs no key. Its id is
 * `frankfurter`, or `frankfurter:ECB` with `providers: ["ECB"]`.
 *
 * Each rate's `date` is the one in the reply: asked for a Saturday, Frankfurter answers with
 * Friday's rates. A currency Frankfurter does not know is listed as missing, not an error, so a
 * fallback source can still be asked for it.
 *
 * @throws {TypeError} When an option is malformed; the message names the option, not its value.
 */
export const createFrankfurterRates = (
  options: FrankfurterRatesOptions = {},
): ExchangeRateSource => {
  const name = "createFrankfurterRates"
  checkOptions(name, options)
  let url: URL
  try {
    url = new URL(options.baseUrl ?? FRANKFURTER_URL)
  } catch {
    throw new TypeError(`${name}: baseUrl is not a valid URL`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${name}: baseUrl must be http or https`)
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError(`${name}: baseUrl must not carry credentials, a query or a hash`)
  }
  const { providers } = options
  if (
    providers !== undefined &&
    (!Array.isArray(providers) || providers.length === 0 ||
      !providers.every((provider) => typeof provider === "string" && PROVIDER.test(provider)))
  ) {
    throw new TypeError(`${name}: providers must be a list of provider codes such as ECB`)
  }
  const id = providers === undefined ? "frankfurter" : `frankfurter:${providers.join(",")}`
  const transport = transportOf(name, id, options)
  const endpoint = `${url.href.replace(/\/+$/, "")}/v2/rates`

  return {
    id,
    async daily(date, base, quotes) {
      const asked = checkAsk(date, base, quotes)
      if (typeof asked === "string") return failure(id, "invalid-request", asked)
      let pending = asked
      const rates: ExchangeRate[] = []
      // Frankfurter refuses the whole call over one currency it does not know (HTTP 422,
      // `invalid currency: XYZ`); that currency is left out and the rest asked again.
      while (pending.length > 0) {
        const params = new URLSearchParams({ date, base, quotes: pending.join(",") })
        if (providers !== undefined) params.set("providers", providers.join(","))
        const reply = await getJson(transport, `${endpoint}?${params}`)
        if (isFailure(reply)) return reply
        if (reply.status === 422) {
          const refusal = FrankfurterRefusal(reply.body)
          // One refusal names every unknown currency, comma-separated: `invalid currency: DOGE,ADA`.
          const codes = refusal instanceof type.errors
            ? []
            : (/^invalid currency: (.+)$/.exec(refusal.message)?.[1] ?? "").split(",")
              .map((code) => code.trim())
          if (codes.includes(base)) return found([], asked, base)
          if (codes.some((code) => pending.includes(code))) {
            pending = pending.filter((quote) => !codes.includes(quote))
            continue
          }
        }
        if (reply.status < 200 || reply.status >= 300) return statusFailure(id, reply.status)
        const rows = FrankfurterReply(reply.body)
        if (rows instanceof type.errors) {
          return failure(id, "invalid-reply", "the reply is not a list of rates")
        }
        for (const row of rows) {
          const rate = plainDecimal(row.rate)
          if (row.base === base && pending.includes(row.quote) && DATE.test(row.date) && rate) {
            rates.push({ base, quote: row.quote, rate, date: row.date, source: id })
          }
        }
        break
      }
      return found(rates, asked, base)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// exchangerate-api.com

/** Options of {@link createExchangeRateApiRates}. */
export interface ExchangeRateApiRatesOptions extends ExchangeRateClientOptions {
  /** The account's key. It travels in the URL path, so it is never put in an error. */
  apiKey: string
}

const ExchangeRateApiReply = type({
  result: "'success'",
  base_code: "string",
  year: "number.integer",
  month: "number.integer",
  day: "number.integer",
  conversion_rates: "Record<string, unknown>",
})
const ExchangeRateApiRefusal = type({ result: "'error'", "error-type": "string" })
const EXCHANGE_RATE_API_ERRORS: Record<string, [RatesErrorCode, string] | "missing"> = {
  "unsupported-code": "missing",
  "no-data-available": "missing",
  "invalid-key": ["unauthorized", "the key is not valid"],
  "inactive-account": ["unauthorized", "the account is not active"],
  "quota-reached": ["quota-reached", "the account's monthly quota is used up"],
  "plan-upgrade-required": ["plan-limit", "the account's plan has no history"],
  "malformed-request": ["invalid-request", "the provider called the request malformed"],
}
const API_KEY = /^[A-Za-z0-9]{8,64}$/

/**
 * Rates from exchangerate-api.com's history endpoint
 * (`GET /v6/{key}/history/{base}/{year}/{month}/{day}`, Pro plan and above). Its id is
 * `exchangerate-api`.
 *
 * Its terms forbid using its rates in a product that offers programmatic access to exchange rate
 * data: an app's own API or MCP server must never return them.
 *
 * A base it does not support, or a date it has no data for, lists every quote as missing. A bad
 * key, an inactive account, a used-up quota or a plan without history is an error.
 *
 * @throws {TypeError} When an option is malformed; the message names the option, not its value.
 */
export const createExchangeRateApiRates = (
  options: ExchangeRateApiRatesOptions,
): ExchangeRateSource => {
  const name = "createExchangeRateApiRates"
  checkOptions(name, options)
  if (typeof options.apiKey !== "string" || !API_KEY.test(options.apiKey)) {
    throw new TypeError(`${name}: apiKey must be 8 to 64 letters and digits`)
  }
  const id = "exchangerate-api"
  const transport = transportOf(name, id, options)
  const endpoint = `https://v6.exchangerate-api.com/v6/${options.apiKey}/history`

  return {
    id,
    async daily(date, base, quotes) {
      const asked = checkAsk(date, base, quotes)
      if (typeof asked === "string") return failure(id, "invalid-request", asked)
      if (asked.length === 0) return found([], asked, base)
      const [year, month, day] = date.split("-").map(Number)
      const reply = await getJson(transport, `${endpoint}/${base}/${year}/${month}/${day}`)
      if (isFailure(reply)) return reply
      const refusal = ExchangeRateApiRefusal(reply.body)
      if (!(refusal instanceof type.errors)) {
        const known = Object.hasOwn(EXCHANGE_RATE_API_ERRORS, refusal["error-type"])
          ? EXCHANGE_RATE_API_ERRORS[refusal["error-type"]]
          : undefined
        if (known === "missing") return found([], asked, base)
        if (known !== undefined) return failure(id, known[0], known[1], reply.status)
        return failure(id, "http-error", "the provider answered an error", reply.status)
      }
      if (reply.status < 200 || reply.status >= 300) return statusFailure(id, reply.status)
      const body = ExchangeRateApiReply(reply.body)
      if (body instanceof type.errors || body.base_code !== base) {
        return failure(id, "invalid-reply", "the reply is not a day of rates for this base")
      }
      const replyDate = [
        String(body.year).padStart(4, "0"),
        String(body.month).padStart(2, "0"),
        String(body.day).padStart(2, "0"),
      ].join("-")
      if (!isCalendarDate(replyDate)) {
        return failure(id, "invalid-reply", "the reply's date is not a calendar date")
      }
      const rates: ExchangeRate[] = []
      for (const quote of asked) {
        const value = Object.hasOwn(body.conversion_rates, quote)
          ? plainDecimal(body.conversion_rates[quote])
          : undefined
        if (value) rates.push({ base, quote, rate: value, date: replyDate, source: id })
      }
      return found(rates, asked, base)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// CoinGecko

/** CoinGecko's plans differ in host and key header: the free Demo plan, or a paid one. */
export type CoinGeckoPlan = "demo" | "pro"

/** CoinGecko's ids of common coins, by code. Pass `coins` for others: a code alone is ambiguous. */
export const COINGECKO_COINS: Readonly<Record<string, string>> = Object.freeze({
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  SOL: "solana",
  XRP: "ripple",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  DOGE: "dogecoin",
  ADA: "cardano",
})

/** Options of {@link createCoinGeckoRates}. */
export interface CoinGeckoRatesOptions extends ExchangeRateClientOptions {
  apiKey: string
  plan: CoinGeckoPlan
  /** Coin code to CoinGecko id; defaults to {@link COINGECKO_COINS}. */
  coins?: Readonly<Record<string, string>>
}

const COINGECKO_PLANS = {
  demo: { host: "https://api.coingecko.com/api/v3", header: "x-cg-demo-api-key" },
  pro: { host: "https://pro-api.coingecko.com/api/v3", header: "x-cg-pro-api-key" },
} as const
const CoinGeckoHistory = type({
  id: "string",
  "market_data?": type({ current_price: "Record<string, unknown>" }),
})
const CoinGeckoErrorCode = type({ "error?": "unknown", "status?": "unknown" })
const COIN_ID = /^[a-z0-9-]{1,100}$/
const HEADER_VALUE = /^[\x21-\x7E]+$/

/** CoinGecko's `error_code`, which sits under `status` or under `error.status`. */
const coinGeckoErrorCode = (body: unknown): unknown => {
  const outer = CoinGeckoErrorCode(body)
  if (outer instanceof type.errors) return undefined
  const holder = (outer.error ?? outer) as { status?: { error_code?: unknown } }
  return holder?.status?.error_code
}

/**
 * Coin prices from CoinGecko's `GET /coins/{id}/history`, a snapshot at 00:00 UTC of the date
 * asked. Its id is `coingecko`.
 *
 * With a coin as `base`, one call gives its price in every quote CoinGecko lists. With a currency
 * as `base`, each coin among `quotes` takes a call, and its rate comes the other way round: `BTC`
 * buys `rate` `USD`. A quote that is not a coin, or a coin CoinGecko has no price for that day, is
 * listed as missing.
 *
 * CoinGecko's terms ask for "Data provided by CoinGecko" next to its data on a paid plan, and for
 * stored prices to be refreshed within 24 hours and deleted when access ends.
 *
 * @throws {TypeError} When an option is malformed; the message names the option, not its value.
 */
export const createCoinGeckoRates = (options: CoinGeckoRatesOptions): ExchangeRateSource => {
  const name = "createCoinGeckoRates"
  checkOptions(name, options)
  if (typeof options.apiKey !== "string" || !HEADER_VALUE.test(options.apiKey)) {
    throw new TypeError(`${name}: apiKey must be printable ASCII without spaces`)
  }
  if (options.plan !== "demo" && options.plan !== "pro") {
    throw new TypeError(`${name}: plan must be demo or pro`)
  }
  const coins = options.coins ?? COINGECKO_COINS
  if (
    typeof coins !== "object" || coins === null ||
    !Object.entries(coins).every(([code, coin]) =>
      CODE.test(code) && typeof coin === "string" && COIN_ID.test(coin)
    )
  ) {
    throw new TypeError(`${name}: coins must map upper-case codes to CoinGecko ids`)
  }
  const coinOf = (code: string): string | undefined =>
    Object.hasOwn(coins, code) ? coins[code] : undefined
  const id = "coingecko"
  const { host, header } = COINGECKO_PLANS[options.plan]
  const transport = { ...transportOf(name, id, options), headers: { [header]: options.apiKey } }

  /** The coin's prices on `date` (`undefined` when CoinGecko has none), or the failure. */
  const pricesOf = async (
    coin: string,
    date: string,
  ): Promise<{ prices: Record<string, unknown> | undefined } | RatesResult> => {
    const [year, month, day] = date.split("-")
    const params = new URLSearchParams({ date: `${day}-${month}-${year}`, localization: "false" })
    const reply = await getJson(transport, `${host}/coins/${coin}/history?${params}`)
    if (isFailure(reply)) return reply
    if (coinGeckoErrorCode(reply.body) === 10012) {
      return failure(id, "plan-limit", "the plan does not reach back to this date", reply.status)
    }
    if (reply.status === 404) return { prices: undefined }
    if (reply.status < 200 || reply.status >= 300) return statusFailure(id, reply.status)
    const body = CoinGeckoHistory(reply.body)
    if (body instanceof type.errors) {
      return failure(id, "invalid-reply", "the reply is not a coin's history")
    }
    return { prices: body.market_data?.current_price }
  }

  const priceIn = (prices: Record<string, unknown> | undefined, code: string) => {
    const key = code.toLowerCase()
    return prices !== undefined && Object.hasOwn(prices, key)
      ? plainDecimal(prices[key])
      : undefined
  }

  return {
    id,
    async daily(date, base, quotes) {
      const asked = checkAsk(date, base, quotes)
      if (typeof asked === "string") return failure(id, "invalid-request", asked)
      if (asked.length === 0) return found([], asked, base)
      const rates: ExchangeRate[] = []
      const baseCoin = coinOf(base)
      if (baseCoin !== undefined) {
        const reply = await pricesOf(baseCoin, date)
        if ("success" in reply) return reply
        for (const quote of asked) {
          const rate = priceIn(reply.prices, quote)
          if (rate) rates.push({ base, quote, rate, date, source: id })
        }
        return found(rates, asked, base)
      }
      for (const quote of asked) {
        const coin = coinOf(quote)
        if (coin === undefined) continue
        const reply = await pricesOf(coin, date)
        if ("success" in reply) return reply
        const rate = priceIn(reply.prices, base)
        if (rate) rates.push({ base: quote, quote: base, rate, date, source: id })
      }
      return found(rates, asked, base)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Fallback

/**
 * One source made of several: each is asked in turn for the quotes still missing, and the rates
 * are joined. A source that fails is skipped and listed in `output.failures`. The call fails only
 * when every source it asked failed, with the first source's error. Its id is the sources' ids
 * joined by `" > "`.
 *
 * @example
 * ```ts
 * const rates = withFallback(
 *   createFrankfurterRates({ providers: ["ECB"] }),
 *   createExchangeRateApiRates({ apiKey: "<REDACTED:API_KEY>" }),
 * )
 * const day = await rates.daily("2026-10-31", "EUR", ["USD", "VND"])
 * ```
 *
 * @throws {TypeError} When no source is given.
 */
export const withFallback = (...sources: ExchangeRateSource[]): ExchangeRateSource => {
  if (sources.length === 0) throw new TypeError("withFallback: give at least one source")
  const id = sources.map((source) => source.id).join(" > ")
  return {
    id,
    async daily(date, base, quotes) {
      const asked = checkAsk(date, base, quotes)
      if (typeof asked === "string") return failure(id, "invalid-request", asked)
      let pending = asked
      const rates: ExchangeRate[] = []
      const failures: RatesError[] = []
      let answered = false
      for (const source of sources) {
        if (pending.length === 0) break
        const result = await source.daily(date, base, pending)
        if (!result.success) {
          failures.push(result.error)
          continue
        }
        answered = true
        for (const rate of result.output.rates) {
          const quote = otherSide(rate, base)
          if (quote !== undefined && pending.includes(quote)) {
            rates.push(rate)
            pending = pending.filter((other) => other !== quote)
          }
        }
      }
      if (!answered && failures.length > 0) {
        return { success: false, output: null, error: failures[0] }
      }
      return {
        success: true,
        output: { rates, missing: pending, failures },
        error: null,
      }
    },
  }
}
