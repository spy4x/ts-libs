import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import {
  createTelegramWebhookHandler,
  pollTelegramUpdates,
  TelegramBot,
  TelegramClient,
  type TelegramConversationStore,
  type TelegramUpdate,
} from "./telegram.ts"

const TOKEN = `123456:TEST-token_not-real`
const SECRET = `webhook-secret_1`

interface Call {
  url: string
  method: string
  params: Record<string, unknown>
}

/** A fake Bot API: records every call and answers from `answer`, or `{ ok: true, result: true }`. */
function fakeTelegram(answer?: (call: Call, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    const call = {
      url,
      method: url.slice(url.lastIndexOf(`/`) + 1),
      params: JSON.parse(String(init.body)),
    }
    calls.push(call)
    return answer ? await answer(call, init) : Response.json({ ok: true, result: true })
  }
  const delays: number[] = []
  const client = new TelegramClient({ token: TOKEN }, {
    fetcher,
    sleep: () => Promise.resolve(),
    onDelay: (ms) => delays.push(ms),
    random: () => 0.5,
  })
  return { client, calls, delays }
}

function memoryStore() {
  const values = new Map<string, string>()
  const ttls: number[] = []
  const store: TelegramConversationStore = {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value, ttlSec) => {
      values.set(key, value)
      ttls.push(ttlSec)
      return Promise.resolve()
    },
    del: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
  return { store, values, ttls }
}

const person = { id: 7, is_bot: false, first_name: `Ann` }
const chat = { id: 42, type: `private` }
let nextId = 1

function textUpdate(text: string): TelegramUpdate {
  return {
    update_id: nextId++,
    message: { message_id: nextId, date: 1, chat, from: person, text },
  }
}

function pressUpdate(data: string): TelegramUpdate {
  return {
    update_id: nextId++,
    callback_query: {
      id: `q${nextId}`,
      from: person,
      data,
      message: { message_id: 1, date: 1, chat },
    },
  }
}

function webhookRequest(body: unknown, secret: string | null = SECRET): Request {
  const headers = new Headers({ "content-type": `application/json` })
  if (secret !== null) headers.set(`x-telegram-bot-api-secret-token`, secret)
  return new Request(`https://bot.example.com/telegram`, {
    method: `POST`,
    headers,
    body: typeof body === `string` ? body : JSON.stringify(body),
  })
}

describe(`TelegramClient`, () => {
  it(`posts the parameters as JSON to the bot's method and returns Telegram's result`, async () => {
    const sent = { message_id: 5, date: 1, chat, text: `Hi` }
    const { client, calls } = fakeTelegram(() => Response.json({ ok: true, result: sent }))
    const result = await client.sendMessage({ chat_id: 42, text: `Hi` })
    expect(result).toEqual({ ok: true, result: sent, attempts: 1 })
    expect(calls).toEqual([{
      url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      method: `sendMessage`,
      params: { chat_id: 42, text: `Hi` },
    }])
  })

  it(`returns Telegram's description on a 400 and does not retry it`, async () => {
    const { client, calls } = fakeTelegram(() =>
      Response.json({ ok: false, error_code: 400, description: `Bad Request: chat not found` }, {
        status: 400,
      })
    )
    const result = await client.sendMessage({ chat_id: 1, text: `x` })
    expect(result).toEqual({
      ok: false,
      code: `http_error`,
      message: `Bad Request: chat not found`,
      status: 400,
      attempts: 1,
    })
    expect(calls.length).toBe(1)
  })

  it(`waits Telegram's retry_after on a 429, then succeeds`, async () => {
    let first = true
    const { client, delays } = fakeTelegram(() => {
      if (!first) return Response.json({ ok: true, result: true })
      first = false
      return Response.json(
        {
          ok: false,
          error_code: 429,
          description: `Too Many Requests`,
          parameters: { retry_after: 3 },
        },
        { status: 429 },
      )
    })
    const result = await client.deleteWebhook()
    expect(result).toEqual({ ok: true, result: true, attempts: 2 })
    expect(delays).toEqual([3000])
  })

  it(`keeps the token out of a transport error`, async () => {
    const { client } = fakeTelegram((call) => {
      throw new TypeError(`error sending request for url (${call.url})`)
    })
    const result = await client.getMe()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it(`refuses a redirect instead of following it`, async () => {
    const { client, calls } = fakeTelegram(() =>
      new Response(null, { status: 302, headers: { location: `https://elsewhere.example` } })
    )
    const result = await client.getMe()
    expect(result).toMatchObject({ ok: false, code: `redirected`, status: 302 })
    expect(calls.length).toBe(1)
  })

  it(`throws on a malformed token without quoting it`, () => {
    expect(() => new TelegramClient({ token: `secret-without-colon` })).toThrow(
      /malformed; expected <digits>:<letters>$/,
    )
  })
})

describe(`TelegramBot behind the webhook handler`, () => {
  function setup(options: { username?: string } = {}) {
    const telegram = fakeTelegram()
    const { store, values, ttls } = memoryStore()
    const bot = new TelegramBot({
      client: telegram.client,
      username: options.username,
      conversations: { store, ttlSec: 600 },
    })
    const errors: unknown[] = []
    const webhook = createTelegramWebhookHandler({
      secretToken: SECRET,
      onUpdate: (update) => bot.handleUpdate(update),
      onError: (error) => errors.push(error),
    })
    return { ...telegram, bot, webhook, errors, store, values, ttls }
  }

  it(`routes /start to its handler, which replies in the chat`, async () => {
    const { bot, webhook, calls } = setup()
    bot.command(`start`, (ctx) => ctx.reply(`Welcome`))
    const response = await webhook(webhookRequest(textUpdate(`/start`)))
    expect(response.status).toBe(200)
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      [`sendMessage`, { chat_id: 42, text: `Welcome` }],
    ])
  })

  it(`routes a button press by its prefix and answers the press`, async () => {
    const { bot, webhook, calls } = setup()
    bot.callback(`menu`, (ctx) => ctx.reply(`You chose ${ctx.args}`))
    await webhook(webhookRequest(pressUpdate(`menu:reports`)))
    expect(calls.map((call) => call.method)).toEqual([`sendMessage`, `answerCallbackQuery`])
    expect(calls[0].params.text).toBe(`You chose reports`)
  })

  it(`still answers a button press whose handler threw`, async () => {
    const { bot, calls } = setup()
    bot.callback(`menu`, () => {
      throw new Error(`boom`)
    })
    await expect(bot.handleUpdate(pressUpdate(`menu`))).rejects.toThrow(`boom`)
    expect(calls.map((call) => call.method)).toEqual([`answerCallbackQuery`])
  })

  it(`answers a press only once when the handler answered it`, async () => {
    const { bot, calls } = setup()
    bot.callback(`save`, (ctx) => ctx.answer(`Saved`))
    await bot.handleUpdate(pressUpdate(`save`))
    expect(calls.map((call) => [call.method, call.params.text])).toEqual([
      [`answerCallbackQuery`, `Saved`],
    ])
  })

  it(`answers a press on a message the bot cannot see, without a handler`, async () => {
    const { bot, calls } = setup()
    const seen: string[] = []
    bot.callback(`menu`, () => seen.push(`menu`))
    const update: TelegramUpdate = {
      update_id: nextId++,
      callback_query: { id: `inline-1`, from: person, data: `menu` },
    }
    expect(await bot.handleUpdate(update)).toBe(false)
    expect(seen).toEqual([])
    expect(calls.map((call) => [call.method, call.params.callback_query_id])).toEqual([
      [`answerCallbackQuery`, `inline-1`],
    ])
  })

  it(`gives a command the text after it as args`, async () => {
    const { bot } = setup()
    let args = ``
    bot.command(`link`, (ctx) => (args = ctx.args))
    await bot.handleUpdate(textUpdate(`/link ABC123`))
    expect(args).toBe(`ABC123`)
  })

  it(`ignores a command addressed to another bot`, async () => {
    const { bot } = setup({ username: `our_bot` })
    const seen: string[] = []
    bot.command(`start`, () => seen.push(`start`))
    bot.text((ctx) => seen.push(`text: ${ctx.text}`))
    expect(await bot.handleUpdate(textUpdate(`/start@other_bot`))).toBe(false)
    expect(await bot.handleUpdate(textUpdate(`/start@Our_Bot`))).toBe(true)
    expect(seen).toEqual([`start`])
  })

  it(`refuses a call with a wrong secret and never runs a handler`, async () => {
    const { bot, webhook, calls } = setup()
    bot.command(`start`, (ctx) => ctx.reply(`Welcome`))
    const response = await webhook(webhookRequest(textUpdate(`/start`), `webhook-secret_2`))
    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it(`refuses a call with no secret header`, async () => {
    const { bot, webhook, calls } = setup()
    bot.command(`start`, (ctx) => ctx.reply(`Welcome`))
    const response = await webhook(webhookRequest(textUpdate(`/start`), null))
    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it(`answers 400 to a body that is not an update, and 413 to one over the cap`, async () => {
    const { webhook } = setup()
    expect((await webhook(webhookRequest(`{not json`))).status).toBe(400)
    expect((await webhook(webhookRequest({ update_id: `one` }))).status).toBe(400)
    const small = createTelegramWebhookHandler({
      secretToken: SECRET,
      onUpdate: () => {},
      onError: () => {},
      maxBodyBytes: 16,
    })
    expect((await small(webhookRequest(textUpdate(`/start`)))).status).toBe(413)
  })

  it(`checks the secret before it reads the body`, async () => {
    const { webhook } = setup()
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode(JSON.stringify(textUpdate(`/start`))))
        controller.close()
      },
    }, { highWaterMark: 0 }) // pulled only when someone reads it
    const request = new Request(`https://bot.example.com/telegram`, {
      method: `POST`,
      headers: { "x-telegram-bot-api-secret-token": `wrong` },
      body,
    })
    expect((await webhook(request)).status).toBe(401)
    expect(pulled).toBe(false)
  })

  it(`accepts a body up to 1 MiB by default and refuses one byte more`, async () => {
    const { webhook } = setup()
    const padded = (size: number) => {
      const base = JSON.stringify({ update_id: 1, pad: `` })
      return JSON.stringify({ update_id: 1, pad: `x`.repeat(size - base.length) })
    }
    expect((await webhook(webhookRequest(padded(1024 * 1024)))).status).toBe(200)
    expect((await webhook(webhookRequest(padded(1024 * 1024 + 1)))).status).toBe(413)
  })

  it(`answers 200 when the handler throws, and reports the error`, async () => {
    const { bot, webhook, errors } = setup()
    bot.command(`start`, () => {
      throw new Error(`boom`)
    })
    const response = await webhook(webhookRequest(textUpdate(`/start`)))
    expect(response.status).toBe(200)
    expect(errors).toEqual([new Error(`boom`)])
  })

  it(`refuses to build with a secret Telegram would not accept`, () => {
    expect(() =>
      createTelegramWebhookHandler({
        secretToken: `has space`,
        onUpdate: () => {},
        onError: () => {},
      })
    ).toThrow(TypeError)
  })
})

describe(`TelegramBot conversations`, () => {
  /** A product's two-step rename flow, registered the same way on every bot instance. */
  function renameBot(store: TelegramConversationStore) {
    const { client, calls } = fakeTelegram()
    const bot = new TelegramBot({ client, conversations: { store, ttlSec: 600 } })
      .command(`rename`, async (ctx) => {
        await ctx.conversation.start(`rename`)
        await ctx.reply(`New name?`)
      })
      .command(`cancel`, (ctx) => ctx.conversation.end())
      .conversation(`rename`, {
        name: async (ctx) => {
          await ctx.reply(`Sure? yes or no`)
          return { step: `confirm`, data: { name: ctx.text } }
        },
        confirm: async (ctx, data) => {
          await ctx.reply(ctx.text === `yes` ? `Renamed to ${data.name}` : `Kept`)
          return { done: true }
        },
      })
    return { bot, calls }
  }

  it(`survives a restart, because its state lives in the passed-in store`, async () => {
    const { store, values } = memoryStore()
    const before = renameBot(store)
    await before.bot.handleUpdate(textUpdate(`/rename`))
    await before.bot.handleUpdate(textUpdate(`Budget`))

    const after = renameBot(store) // a new process: nothing but the store carries over
    await after.bot.handleUpdate(textUpdate(`yes`))
    expect(after.calls.map((call) => call.params.text)).toEqual([`Renamed to Budget`])
    expect(values.size).toBe(0)
  })

  it(`saves each step with the configured expiry`, async () => {
    const { store, ttls } = memoryStore()
    const { bot } = renameBot(store)
    await bot.handleUpdate(textUpdate(`/rename`))
    await bot.handleUpdate(textUpdate(`Budget`))
    expect(ttls).toEqual([600, 600])
  })

  it(`lets a command end a running conversation`, async () => {
    const { store, values } = memoryStore()
    const { bot, calls } = renameBot(store)
    await bot.handleUpdate(textUpdate(`/rename`))
    await bot.handleUpdate(textUpdate(`/cancel`))
    expect(values.size).toBe(0)
    await bot.handleUpdate(textUpdate(`Budget`))
    expect(calls.map((call) => call.params.text)).toEqual([`New name?`])
  })

  it(`drops a saved state whose step no longer exists`, async () => {
    const { store, values } = memoryStore()
    values.set(
      `telegram:conversation:42:7`,
      JSON.stringify({ name: `rename`, step: `old`, data: {} }),
    )
    const { bot } = renameBot(store)
    expect(await bot.handleUpdate(textUpdate(`hello`))).toBe(false)
    expect(values.size).toBe(0)
  })

  it(`refuses to register a conversation without a store`, () => {
    const bot = new TelegramBot({ client: fakeTelegram().client })
    expect(() => bot.conversation(`rename`, { name: () => ({ done: true }) })).toThrow(
      /needs options.conversations/,
    )
  })
})

describe(`pollTelegramUpdates`, () => {
  it(`stops when its signal aborts during a long poll`, async () => {
    const controller = new AbortController()
    const { client, calls } = fakeTelegram((_call, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(`abort`, () => reject(init.signal!.reason))
      })
    )
    const errors: unknown[] = []
    const started = Date.now()
    const loop = pollTelegramUpdates({
      client,
      signal: controller.signal,
      onUpdate: () => {},
      onError: (error) => errors.push(error),
    })
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await loop
    // Without the abort the call would hang until its 40s timeout.
    expect(Date.now() - started).toBeLessThan(900)
    expect(calls.length).toBe(1)
    expect(calls[0].params.timeout).toBe(30)
    expect(errors).toEqual([])
  })

  it(`stops while waiting after a failed call when its signal aborts`, async () => {
    const controller = new AbortController()
    const { client } = fakeTelegram(() =>
      Response.json({ ok: false, error_code: 409, description: `Conflict` }, { status: 409 })
    )
    const errors: unknown[] = []
    const started = Date.now()
    // The real wait: the first backoff is 1s, and the abort comes 20ms into it.
    await pollTelegramUpdates({
      client,
      signal: controller.signal,
      onUpdate: () => {},
      onError: (error) => {
        errors.push(error)
        setTimeout(() => controller.abort(), 20)
      },
    })
    expect(Date.now() - started).toBeLessThan(900)
    expect(errors.map(String)).toEqual([`Error: Telegram getUpdates failed: http_error: Conflict`])
  })

  it(`moves the offset past an update that is not valid, and reports it`, async () => {
    const controller = new AbortController()
    const batches: unknown[][] = [[{ update_id: 20, message: `not a message` }]]
    const { client, calls } = fakeTelegram(() => {
      const batch = batches.shift()
      if (!batch) controller.abort()
      return Response.json({ ok: true, result: batch ?? [] })
    })
    const seen: number[] = []
    const errors: unknown[] = []
    await pollTelegramUpdates({
      client,
      signal: controller.signal,
      onUpdate: (update) => seen.push(update.update_id),
      onError: (error) => errors.push(error),
    })
    expect(seen).toEqual([])
    expect(errors.map(String)).toEqual([`Error: Telegram sent an update that is not valid`])
    expect(calls.map((call) => call.params.offset)).toEqual([undefined, 21])
  })

  it(`hands every update over in order and moves the offset past each, even one that threw`, async () => {
    const controller = new AbortController()
    const batches: unknown[][] = [[
      { update_id: 10, message: { message_id: 1, date: 1, chat, text: `a` } },
      { update_id: 11, message: { message_id: 2, date: 1, chat, text: `b` } },
    ]]
    const { client, calls } = fakeTelegram(() => {
      const batch = batches.shift()
      if (!batch) controller.abort()
      return Response.json({ ok: true, result: batch ?? [] })
    })
    const seen: number[] = []
    const errors: unknown[] = []
    await pollTelegramUpdates({
      client,
      signal: controller.signal,
      onUpdate: (update) => {
        seen.push(update.update_id)
        if (update.update_id === 10) throw new Error(`handler failed`)
      },
      onError: (error) => errors.push(error),
    })
    expect(seen).toEqual([10, 11])
    expect(errors).toEqual([new Error(`handler failed`)])
    expect(calls.map((call) => call.params.offset)).toEqual([undefined, 12])
  })
})
