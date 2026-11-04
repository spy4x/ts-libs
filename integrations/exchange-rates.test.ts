import { assert, assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  createCoinGeckoRates,
  createExchangeRateApiRates,
  createFrankfurterRates,
  type ExchangeRateSource,
  type RatesResult,
  withFallback,
} from "./exchange-rates.ts"

// Every reply below is a file in `fixtures/`: recorded from the live API, except exchangerate-api's
// success, `no-data-available` and `invalid-key` replies, built from its documented shapes.

const KEY = "a1b2c3d4e5f6a7b8c9d0e1f2"
const CG_KEY = "CG-demoKeyExample0123456"

/** The text of a recorded reply. */
const fixture = (path: string): Promise<string> =>
  Deno.readTextFile(new URL(`./fixtures/${path}`, import.meta.url))

/** A recorded reply as the server sent it. */
const recorded = async (path: string, status = 200): Promise<Response> =>
  new Response(await fixture(path), {
    status,
    headers: { "content-type": "application/json" },
  })

interface Call {
  url: URL
  headers: Headers
}

/** A fetch stub that records each call and answers it with `respond(url, callIndex)`. */
const stub = (respond: (url: URL, index: number) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, headers: new Headers(init.headers) })
    return Promise.resolve().then(() => respond(url, calls.length - 1))
  }) as typeof fetch
  return { calls, fetcher }
}

const output = (result: RatesResult) => {
  assert(result.success, `expected success, got ${JSON.stringify(result.error)}`)
  return result.output
}

describe("createFrankfurterRates", () => {
  it("returns a Saturday request's rates dated the Friday before", async () => {
    const { calls, fetcher } = stub(() => recorded("frankfurter/saturday-ecb.json"))
    const source = createFrankfurterRates({ providers: ["ECB"], fetch: fetcher })

    const { rates, missing } = output(
      await source.daily("2026-10-31", "EUR", ["USD", "GBP", "JPY"]),
    )

    assertEquals(missing, [])
    assertEquals(rates.map((rate) => [rate.quote, rate.rate, rate.date]), [
      ["GBP", "0.8338", "2026-10-30"],
      ["JPY", "175.68", "2026-10-30"],
      ["USD", "1.1172", "2026-10-30"],
    ])
    assertEquals(rates[0].source, "frankfurter:ECB")
    assertEquals(source.id, "frankfurter:ECB")
    assertEquals(calls.length, 1)
    assertEquals(
      calls[0].url.origin + calls[0].url.pathname,
      "https://api.frankfurter.dev/v2/rates",
    )
    assertEquals(Object.fromEntries(calls[0].url.searchParams), {
      date: "2026-10-31",
      base: "EUR",
      quotes: "USD,GBP,JPY",
      providers: "ECB",
    })
  })

  it("turns a rate of 1.2907e-5 and one below 1e-6 into plain decimal strings", async () => {
    const replies = ["frankfurter/usd-btc-eth.json", "frankfurter/vnd-btc-usd.json"]
    const { fetcher } = stub((_url, index) => recorded(replies[index]))
    const source = createFrankfurterRates({ fetch: fetcher })

    const usd = output(await source.daily("2026-10-30", "USD", ["BTC", "ETH"]))
    const vnd = output(await source.daily("2026-10-30", "VND", ["BTC", "USD"]))

    assertEquals(usd.rates.map((rate) => rate.rate), ["0.000012907", "0.00044734"])
    assertEquals(vnd.rates.map((rate) => rate.rate), ["0.00000000050112", "0.000038826"])
    assertEquals(usd.rates[0].source, "frankfurter")
  })

  it("writes rates past 1e21 as digits and keeps only finite rates above zero", async () => {
    const { fetcher } = stub(() =>
      new Response(
        `[{"date":"2026-10-30","base":"EUR","quote":"AAA","rate":1.5e21},
          {"date":"2026-10-30","base":"EUR","quote":"BBB","rate":0},
          {"date":"2026-10-30","base":"EUR","quote":"CCC","rate":-1.2},
          {"date":"2026-10-30","base":"EUR","quote":"DDD","rate":"1.2"},
          {"date":"2026-10-30","base":"EUR","quote":"EEE","rate":1e999}]`,
      )
    )
    const source = createFrankfurterRates({ fetch: fetcher })

    const day = output(await source.daily("2026-10-30", "EUR", ["AAA", "BBB", "CCC", "DDD", "EEE"]))

    assertEquals(day.rates.map((rate) => [rate.quote, rate.rate]), [
      ["AAA", "1500000000000000000000"],
    ])
    assertEquals(day.missing, ["BBB", "CCC", "DDD", "EEE"])
  })

  it("lists a quote Frankfurter does not know as missing and asks again for the rest", async () => {
    const replies = [
      () => recorded("frankfurter/invalid-currency.json", 422),
      () => recorded("frankfurter/ecb-lacks-vnd-aed.json"),
    ]
    const { calls, fetcher } = stub((_url, index) => replies[index]())
    const source = createFrankfurterRates({ providers: ["ECB"], fetch: fetcher })

    const day = output(await source.daily("2026-10-31", "EUR", ["USD", "XXX", "VND", "AED"]))

    assertEquals(calls.map((call) => call.url.searchParams.get("quotes")), [
      "USD,XXX,VND,AED",
      "USD,VND,AED",
    ])
    assertEquals(day.rates.map((rate) => rate.quote), ["USD"])
    assertEquals(day.missing, ["XXX", "VND", "AED"])
  })

  it("lists every quote as missing for a base it does not know or a day with no rates", async () => {
    const replies = [
      () => recorded("frankfurter/invalid-currency.json", 422),
      () => recorded("frankfurter/no-rates.json"),
    ]
    const { calls, fetcher } = stub((_url, index) => replies[index]())
    const source = createFrankfurterRates({ fetch: fetcher })

    const unknownBase = output(await source.daily("2026-10-30", "XXX", ["USD"]))
    const future = output(await source.daily("2030-01-01", "EUR", ["USD"]))

    assertEquals(calls.length, 2)
    assertEquals(unknownBase, { rates: [], missing: ["USD"] })
    assertEquals(future, { rates: [], missing: ["USD"] })
  })

  it("lists every currency one refusal names as missing and asks again for the rest", async () => {
    const replies = [
      () => recorded("frankfurter/invalid-currencies.json", 422),
      () => recorded("frankfurter/ecb-lacks-vnd-aed.json"),
    ]
    const { calls, fetcher } = stub((_url, index) => replies[index]())
    const source = createFrankfurterRates({ providers: ["ECB"], fetch: fetcher })

    const day = output(await source.daily("2026-10-30", "EUR", ["USD", "DOGE", "ADA"]))

    assertEquals(calls.map((call) => call.url.searchParams.get("quotes")), ["USD,DOGE,ADA", "USD"])
    assertEquals(day.rates.map((rate) => rate.quote), ["USD"])
    assertEquals(day.missing, ["DOGE", "ADA"])
  })

  it("lists every quote as missing when one refusal names the base and a quote", async () => {
    const { calls, fetcher } = stub(() => recorded("frankfurter/invalid-base-and-quote.json", 422))
    const source = createFrankfurterRates({ fetch: fetcher })

    const day = output(await source.daily("2026-10-30", "XXX", ["USD", "YYY"]))

    assertEquals(calls.length, 1)
    assertEquals(day, { rates: [], missing: ["USD", "YYY"] })
  })

  it("calls a self-hosted Frankfurter at its baseUrl", async () => {
    const { calls, fetcher } = stub(() => recorded("frankfurter/no-rates.json"))
    const source = createFrankfurterRates({
      baseUrl: "https://rates.example.com/fx/",
      fetch: fetcher,
    })

    await source.daily("2026-10-30", "EUR", ["USD"])

    assertEquals(
      calls[0].url.origin + calls[0].url.pathname,
      "https://rates.example.com/fx/v2/rates",
    )
  })

  it("refuses a date or code it cannot ask for, without a call", async () => {
    const { calls, fetcher } = stub(() => recorded("frankfurter/no-rates.json"))
    const source = createFrankfurterRates({ fetch: fetcher })

    for (
      const [date, base, quotes] of [
        ["2026-02-30", "EUR", ["USD"]],
        ["30-10-2026", "EUR", ["USD"]],
        ["2026-10-30", "eur", ["USD"]],
        ["2026-10-30", "EUR", ["US D"]],
      ] as const
    ) {
      const result = await source.daily(date, base, quotes)
      assertEquals(result.success ? null : result.error.code, "invalid-request")
    }
    assertEquals(calls.length, 0)
  })

  it("reports a server error as unavailable, with its status", async () => {
    const { fetcher } = stub(() => new Response("<html>bad gateway</html>", { status: 502 }))
    const source = createFrankfurterRates({ fetch: fetcher })

    const result = await source.daily("2026-10-30", "EUR", ["USD"])

    assertEquals(result.error, {
      source: "frankfurter",
      code: "unavailable",
      message: "the server answered HTTP 502",
      status: 502,
    })
  })

  it("refuses malformed options at creation", () => {
    assertThrows(() => createFrankfurterRates({ baseUrl: "ftp://rates.example.com" }), TypeError)
    assertThrows(
      () => createFrankfurterRates({ baseUrl: "https://u:p@rates.example.com" }),
      TypeError,
    )
    assertThrows(() => createFrankfurterRates({ providers: [] }), TypeError)
    assertThrows(() => createFrankfurterRates({ timeoutMs: 0 }), TypeError)
  })
})

describe("createExchangeRateApiRates", () => {
  it("reads a day of rates from the history endpoint", async () => {
    const { calls, fetcher } = stub(() => recorded("exchangerate-api/history-eur-2026-10-31.json"))
    const source = createExchangeRateApiRates({ apiKey: KEY, fetch: fetcher })

    const day = output(await source.daily("2026-10-31", "EUR", ["VND", "AED", "XXX"]))

    assertEquals(
      String(calls[0].url),
      `https://v6.exchangerate-api.com/v6/${KEY}/history/EUR/2026/10/31`,
    )
    assertEquals(day.rates, [
      {
        base: "EUR",
        quote: "VND",
        rate: "28790.5",
        date: "2026-10-31",
        source: "exchangerate-api",
      },
      { base: "EUR", quote: "AED", rate: "4.1046", date: "2026-10-31", source: "exchangerate-api" },
    ])
    assertEquals(day.missing, ["XXX"])
  })

  it("maps the provider's error types", async () => {
    const cases: [string, number, string | null][] = [
      ["exchangerate-api/invalid-key.json", 403, "unauthorized"],
      ["exchangerate-api/inactive-account.json", 403, "unauthorized"],
      ["exchangerate-api/no-data-available.json", 404, null],
    ]
    for (const [path, status, code] of cases) {
      const { fetcher } = stub(() => recorded(path, status))
      const source = createExchangeRateApiRates({ apiKey: KEY, fetch: fetcher })

      const result = await source.daily("2026-10-31", "EUR", ["USD"])

      if (code === null) {
        assertEquals(output(result), { rates: [], missing: ["USD"] })
      } else {
        assertEquals(
          result.success ? null : `${result.error.code} ${result.error.status}`,
          `${code} ${status}`,
        )
      }
    }
  })

  it("refuses a key that is not letters and digits, without echoing it", () => {
    const error = assertThrows(() => createExchangeRateApiRates({ apiKey: "../secret" }), TypeError)
    assert(!error.message.includes("secret"))
  })
})

describe("createCoinGeckoRates", () => {
  it("prices a coin base in each quote with one call", async () => {
    const { calls, fetcher } = stub(() => recorded("coingecko/bitcoin-2026-10-30.json"))
    const source = createCoinGeckoRates({ apiKey: CG_KEY, plan: "demo", fetch: fetcher })

    const day = output(await source.daily("2026-10-30", "BTC", ["USD", "VND", "XXX"]))

    assertEquals(calls.length, 1)
    assertEquals(
      String(calls[0].url),
      "https://api.coingecko.com/api/v3/coins/bitcoin/history?date=30-10-2026&localization=false",
    )
    assertEquals(calls[0].headers.get("x-cg-demo-api-key"), CG_KEY)
    assertEquals(day.rates, [
      {
        base: "BTC",
        quote: "USD",
        rate: "77838.81456587692",
        date: "2026-10-30",
        source: "coingecko",
      },
      {
        base: "BTC",
        quote: "VND",
        rate: "2010040435.4333348",
        date: "2026-10-30",
        source: "coingecko",
      },
    ])
    assertEquals(day.missing, ["XXX"])
  })

  it("asks a currency base's price of each coin, coin first, on the paid host", async () => {
    const { calls, fetcher } = stub((url) =>
      recorded(`coingecko/${url.pathname.split("/")[4]}-2026-10-30.json`)
    )
    const source = createCoinGeckoRates({ apiKey: CG_KEY, plan: "pro", fetch: fetcher })

    const day = output(await source.daily("2026-10-30", "USD", ["BTC", "EUR", "ETH"]))

    assertEquals(calls.map((call) => call.url.origin + call.url.pathname), [
      "https://pro-api.coingecko.com/api/v3/coins/bitcoin/history",
      "https://pro-api.coingecko.com/api/v3/coins/ethereum/history",
    ])
    assertEquals(calls[0].headers.get("x-cg-pro-api-key"), CG_KEY)
    assertEquals(calls[0].headers.get("x-cg-demo-api-key"), null)
    assertEquals(day.rates.map((rate) => [rate.base, rate.quote]), [["BTC", "USD"], ["ETH", "USD"]])
    assertEquals(day.missing, ["EUR"])
  })

  it("lists a coin CoinGecko does not know as missing", async () => {
    const { fetcher } = stub(() => recorded("coingecko/coin-not-found.json", 404))
    const source = createCoinGeckoRates({
      apiKey: CG_KEY,
      plan: "demo",
      coins: { NOPE: "nope-coin" },
      fetch: fetcher,
    })

    assertEquals(output(await source.daily("2026-10-30", "USD", ["NOPE"])), {
      rates: [],
      missing: ["NOPE"],
    })
  })

  it("reports a date past the plan's history as a plan limit", async () => {
    const { fetcher } = stub(() => recorded("coingecko/past-plan-range.json", 401))
    const source = createCoinGeckoRates({ apiKey: CG_KEY, plan: "demo", fetch: fetcher })

    const result = await source.daily("2005-01-01", "BTC", ["USD"])

    assertEquals(result.success ? null : [result.error.code, result.error.status], [
      "plan-limit",
      401,
    ])
  })
})

describe("errors never carry a key or a URL", () => {
  /** Every way a call can fail, each with the URL (and so the key) in what the failure carries. */
  const failures = (url: URL, index: number): Response => {
    const href = String(url)
    switch (index) {
      case 0: {
        const error = new TypeError(`error sending request for url (${href})`, {
          cause: new Error(`dns error: ${href}`),
        })
        throw error
      }
      case 1:
        throw new DOMException(`signal timed out: ${href}`, "TimeoutError")
      case 2:
        return new Response(JSON.stringify({ error: href }), { status: 500 })
      case 3:
        return new Response(null, { status: 302, headers: { location: href } })
      case 4:
        return new Response(`not json ${href}`, { status: 200 })
      case 5:
        return new Response(JSON.stringify({ result: "error", "error-type": href }), {
          status: 400,
        })
      default:
        return new Response(JSON.stringify([{ unexpected: href }]), { status: 200 })
    }
  }

  const sources: [string, string, (fetcher: typeof fetch) => ExchangeRateSource][] = [
    [
      KEY,
      "v6.exchangerate-api.com",
      (fetcher) => createExchangeRateApiRates({ apiKey: KEY, fetch: fetcher }),
    ],
    [
      CG_KEY,
      "api.coingecko.com",
      (fetcher) => createCoinGeckoRates({ apiKey: CG_KEY, plan: "demo", fetch: fetcher }),
    ],
  ]

  for (const [key, host, create] of sources) {
    it(`${host}: no failure's whole text, cause included, holds the key or the URL`, async () => {
      const { calls, fetcher } = stub(failures)
      const source = withFallback(create(fetcher))
      for (let index = 0; index < 7; index++) {
        const base = host.includes("coingecko") ? "BTC" : "EUR"
        const result = await source.daily("2026-10-30", base, ["USD"])
        assert(!result.success, `failure ${index} should fail`)
        const text = Deno.inspect(result, { depth: Infinity, showHidden: true, colors: false })
        assert(!text.includes(key), `failure ${index} leaks the key: ${text}`)
        assert(!text.includes(host), `failure ${index} leaks the URL: ${text}`)
      }
      assertEquals(calls.length, 7)
      assert(String(calls[0].url).includes(host))
    })
  }
})

describe("withFallback", () => {
  /** A source that records the quotes it was asked for. */
  const spy = (source: ExchangeRateSource) => {
    const asked: string[][] = []
    const wrapped: ExchangeRateSource = {
      id: source.id,
      daily: (date, base, quotes) => {
        asked.push([...quotes])
        return source.daily(date, base, quotes)
      },
    }
    return { asked, wrapped }
  }

  const frankfurterEcb = () => {
    const replies = [
      () => recorded("frankfurter/invalid-currency.json", 422),
      () => recorded("frankfurter/ecb-lacks-vnd-aed.json"),
    ]
    const { fetcher } = stub((_url, index) => replies[index]())
    return createFrankfurterRates({ providers: ["ECB"], fetch: fetcher })
  }

  const exchangeRateApi = (path = "exchangerate-api/history-eur-2026-10-31.json", status = 200) => {
    const { calls, fetcher } = stub(() => recorded(path, status))
    return { calls, source: createExchangeRateApiRates({ apiKey: KEY, fetch: fetcher }) }
  }

  it("asks the second source only for the quotes the first lacked, and lists a quote neither has as missing", async () => {
    const second = spy(exchangeRateApi().source)
    const chain = withFallback(frankfurterEcb(), second.wrapped)

    const day = output(await chain.daily("2026-10-31", "EUR", ["USD", "XXX", "VND", "AED"]))

    assertEquals(second.asked, [["XXX", "VND", "AED"]])
    assertEquals(day.rates.map((rate) => [rate.quote, rate.rate, rate.date, rate.source]), [
      ["USD", "1.1172", "2026-10-30", "frankfurter:ECB"],
      ["VND", "28790.5", "2026-10-31", "exchangerate-api"],
      ["AED", "4.1046", "2026-10-31", "exchangerate-api"],
    ])
    assertEquals(day.missing, ["XXX"])
    assert(!day.rates.some((rate) => rate.quote === "XXX"))
    assertEquals(day.failures, [])
    assertEquals(chain.id, "frankfurter:ECB > exchangerate-api")
  })

  it("counts a rate quoted the other way round as covering its quote", async () => {
    const { fetcher } = stub(() => recorded("coingecko/bitcoin-2026-10-30.json"))
    const coins = spy(createCoinGeckoRates({ apiKey: CG_KEY, plan: "demo", fetch: fetcher }))
    const later = spy(exchangeRateApi().source)

    const day = output(
      await withFallback(coins.wrapped, later.wrapped).daily("2026-10-30", "EUR", ["BTC"]),
    )

    assertEquals(day.rates.map((rate) => [rate.base, rate.quote]), [["BTC", "EUR"]])
    assertEquals(later.asked, [])
  })

  it("skips a failing source, lists its failure and asks the next", async () => {
    const failing = exchangeRateApi("exchangerate-api/invalid-key.json", 403).source
    const day = output(
      await withFallback(failing, frankfurterEcb()).daily("2026-10-31", "EUR", ["USD", "XXX"]),
    )

    assertEquals(day.rates.map((rate) => rate.quote), ["USD"])
    assertEquals(day.missing, ["XXX"])
    assertEquals(day.failures?.map((failure) => [failure.source, failure.code]), [
      ["exchangerate-api", "unauthorized"],
    ])
  })

  it("fails with the first source's error when every source fails", async () => {
    const first = exchangeRateApi("exchangerate-api/invalid-key.json", 403).source
    const { fetcher } = stub(() => new Response("", { status: 503 }))
    const second = createFrankfurterRates({ fetch: fetcher })

    const result = await withFallback(first, second).daily("2026-10-31", "EUR", ["USD"])

    assertEquals(result.success ? null : [result.error.source, result.error.code], [
      "exchangerate-api",
      "unauthorized",
    ])
  })

  it("asks no further source once every quote has a rate", async () => {
    const later = spy(exchangeRateApi().source)
    const { fetcher } = stub(() => recorded("frankfurter/saturday-ecb.json"))
    const chain = withFallback(createFrankfurterRates({ fetch: fetcher }), later.wrapped)

    output(await chain.daily("2026-10-31", "EUR", ["USD", "GBP", "JPY"]))

    assertEquals(later.asked, [])
  })

  it("refuses to be built without a source", () => {
    assertThrows(() => withFallback(), TypeError)
  })
})
