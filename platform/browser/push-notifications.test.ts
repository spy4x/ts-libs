import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  installPushNotifications,
  type PushClickEvent,
  type PushClient,
  type PushNotificationOptions,
  type PushNotificationsOptions,
  type PushScope,
  type PushScopeEvent,
  sameOriginUrl,
} from "./push-notifications.ts"

const ORIGIN = "https://app.example.com"

interface FakeWindow extends PushClient {
  focused: number
  navigated: string[]
}

/** An open window of the app; `controlled: false` makes `navigate` reject, as a browser does. */
function appWindow(path: string, controlled = true): FakeWindow {
  const client: FakeWindow = {
    url: `${ORIGIN}${path}`,
    focused: 0,
    navigated: [],
    focus: () => {
      client.focused++
      return Promise.resolve(client)
    },
    navigate: (url) => {
      if (!controlled) return Promise.reject(new TypeError("not controlled"))
      client.navigated.push(url)
      return Promise.resolve(client)
    },
  }
  return client
}

/** A fake worker scope that records what was shown and opened. */
function setup(options: PushNotificationsOptions = {}, windows: PushClient[] = []) {
  const listeners = new Map<string, (event: never) => void>()
  const world = {
    shown: [] as { title: string; options?: PushNotificationOptions }[],
    opened: [] as string[],
    queries: [] as unknown[],
    closed: 0,
  }
  const scope: PushScope = {
    location: { origin: ORIGIN },
    registration: {
      showNotification: (title, shown) => {
        world.shown.push({ title, options: shown })
        return Promise.resolve()
      },
    },
    clients: {
      matchAll: (query) => {
        world.queries.push(query)
        return Promise.resolve(windows)
      },
      openWindow: (url) => {
        world.opened.push(url)
        return Promise.resolve(null)
      },
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener as (event: never) => void)
    },
  }
  installPushNotifications(scope, options)

  /** Fires `push` with this payload (`undefined` for none) and waits for what it started. */
  async function push(payload: unknown, raw?: () => unknown): Promise<void> {
    const waited: Promise<unknown>[] = []
    const event: PushScopeEvent = {
      data: payload === undefined && !raw ? null : { json: raw ?? (() => payload) },
      waitUntil: (promise) => void waited.push(promise),
    }
    ;(listeners.get("push") as (event: PushScopeEvent) => void)(event)
    await Promise.all(waited)
  }

  /** Clicks a notification that carries `data` and waits for what the click started. */
  async function click(data: unknown): Promise<void> {
    const waited: Promise<unknown>[] = []
    const event: PushClickEvent = {
      notification: { close: () => void world.closed++, data },
      waitUntil: (promise) => void waited.push(promise),
    }
    ;(listeners.get("notificationclick") as (event: PushClickEvent) => void)(event)
    await Promise.all(waited)
  }

  /** Pushes `message`, then clicks the notification it showed. */
  async function pushAndClick(message: unknown): Promise<void> {
    await push(message)
    await click(world.shown.at(-1)?.options?.data)
  }

  return { world, push, click, pushAndClick }
}

describe("push notifications: showing a push", () => {
  it("shows the title, body and tag of the message, with the URL a click leads to", async () => {
    const { world, push } = setup()
    await push({ title: "Water the plants", body: "Due now", url: "/tasks/7", tag: "task-7|10:00" })
    expect(world.shown).toEqual([{
      title: "Water the plants",
      options: { body: "Due now", tag: "task-7|10:00", data: { url: `${ORIGIN}/tasks/7` } },
    }])
  })

  it("shows a message that has only a title, pointing at the default URL", async () => {
    const { world, push } = setup()
    await push({ title: "Hello" })
    expect(world.shown).toEqual([{ title: "Hello", options: { data: { url: `${ORIGIN}/` } } }])
  })

  it("gives two pushes of the same reminder the same tag, so the second replaces the first", async () => {
    const { world, push } = setup()
    await push({ title: "Water the plants", tag: "task-7|10:00" })
    await push({ title: "Water the plants", tag: "task-7|10:00" })
    await push({ title: "Feed the cat", tag: "task-8|10:00" })
    expect(world.shown.map((entry) => entry.options?.tag)).toEqual([
      "task-7|10:00",
      "task-7|10:00",
      "task-8|10:00",
    ])
  })

  it("adds the icon and the badge it was installed with", async () => {
    const { world, push } = setup({ icon: "/icon-192.png", badge: "/badge.png" })
    await push({ title: "Hello" })
    expect(world.shown[0].options).toEqual({
      icon: "/icon-192.png",
      badge: "/badge.png",
      data: { url: `${ORIGIN}/` },
    })
  })

  it("holds the event open until the notification is shown", async () => {
    const listeners = new Map<string, (event: PushScopeEvent) => void>()
    let show: () => void = () => {}
    const scope: PushScope = {
      location: { origin: ORIGIN },
      registration: { showNotification: () => new Promise<void>((resolve) => (show = resolve)) },
      clients: { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) },
      addEventListener: (type, listener) => void listeners.set(type, listener),
    }
    installPushNotifications(scope)
    const waited: Promise<unknown>[] = []
    listeners.get("push")!({
      data: { json: () => ({ title: "Hello" }) },
      waitUntil: (promise) => void waited.push(promise),
    })
    expect(waited).toHaveLength(1)
    let settled = false
    void waited[0].then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    show()
    await waited[0]
  })

  const ignored: [string, unknown][] = [
    ["no title", { body: "Due now" }],
    ["an empty title", { title: "" }],
    ["a title that is not text", { title: { toString: () => "x" } }],
    ["an unknown field", { title: "Hello", actions: [{ action: "x", title: "y" }] }],
    ["a title over 120 characters", { title: "a".repeat(121) }],
    ["a tag over 256 characters", { title: "Hello", tag: "a".repeat(257) }],
    ["a URL that is not text", { title: "Hello", url: { href: "/x" } }],
    ["a list", [{ title: "Hello" }]],
    ["plain text", "Hello"],
    ["null", null],
  ]
  for (const [label, payload] of ignored) {
    it(`shows nothing for a payload with ${label}`, async () => {
      const { world, push } = setup()
      await push(payload)
      expect(world.shown).toEqual([])
    })
  }

  it("shows nothing for a push with no payload, or with one that is not JSON", async () => {
    const { world, push } = setup()
    await push(undefined)
    await push(undefined, () => JSON.parse("{not json"))
    expect(world.shown).toEqual([])
  })
})

describe("push notifications: the URL a click leads to", () => {
  const offSite = [
    "https://evil.example.com/tasks/7",
    "//evil.example.com/tasks/7",
    "http://app.example.com/tasks/7",
    "https://app.example.com.evil.example/tasks/7",
    "https://app.example.com:8443/tasks/7",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://",
  ]
  for (const url of offSite) {
    it(`replaces ${url} with the default URL`, async () => {
      const { world, pushAndClick } = setup({ defaultUrl: "/inbox" })
      await pushAndClick({ title: "Hello", url })
      expect(world.shown[0].options?.data).toEqual({ url: `${ORIGIN}/inbox` })
      expect(world.opened).toEqual([`${ORIGIN}/inbox`])
    })
  }

  it("keeps a path, a query and an absolute URL of the app's own origin", async () => {
    const { world, push } = setup()
    await push({ title: "a", url: "/tasks/7?from=push#notes" })
    await push({ title: "b", url: `${ORIGIN}/tasks/8` })
    await push({ title: "c", url: "tasks/9" })
    expect(world.shown.map((entry) => entry.options?.data.url)).toEqual([
      `${ORIGIN}/tasks/7?from=push#notes`,
      `${ORIGIN}/tasks/8`,
      `${ORIGIN}/tasks/9`,
    ])
  })

  it("falls back to the app's root when the default URL itself is on another site", async () => {
    const { world, pushAndClick } = setup({ defaultUrl: "https://evil.example.com/" })
    await pushAndClick({ title: "Hello" })
    expect(world.opened).toEqual([`${ORIGIN}/`])
  })

  it("checks the URL again at the click, whatever the notification carries", async () => {
    for (
      const data of [
        { url: "https://evil.example.com/" },
        { url: 7 },
        {},
        null,
        undefined,
        "https://evil.example.com/",
      ]
    ) {
      const { world, click } = setup()
      await click(data)
      expect(world.opened).toEqual([`${ORIGIN}/`])
    }
  })

  it("sameOriginUrl answers the absolute URL, or undefined for anything off the origin", () => {
    expect(sameOriginUrl("/tasks/7", ORIGIN)).toBe(`${ORIGIN}/tasks/7`)
    expect(sameOriginUrl(`${ORIGIN}/tasks/7`, ORIGIN)).toBe(`${ORIGIN}/tasks/7`)
    expect(sameOriginUrl("//evil.example.com/", ORIGIN)).toBeUndefined()
    expect(sameOriginUrl("javascript:alert(1)", ORIGIN)).toBeUndefined()
    expect(sameOriginUrl("", ORIGIN)).toBeUndefined()
    expect(sameOriginUrl(null, ORIGIN)).toBeUndefined()
    expect(sameOriginUrl({ href: "/x" }, ORIGIN)).toBeUndefined()
  })
})

describe("push notifications: clicking a notification", () => {
  it("closes the notification", async () => {
    const { world, pushAndClick } = setup()
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(world.closed).toBe(1)
  })

  it("opens a new window at the URL when the app has none open", async () => {
    const { world, pushAndClick } = setup()
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(world.opened).toEqual([`${ORIGIN}/tasks/7`])
    expect(world.queries).toEqual([{ type: "window", includeUncontrolled: true }])
  })

  it("focuses an open window and sends it to the URL, opening nothing", async () => {
    const open = appWindow("/inbox")
    const { world, pushAndClick } = setup({}, [open])
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(open.focused).toBe(1)
    expect(open.navigated).toEqual([`${ORIGIN}/tasks/7`])
    expect(world.opened).toEqual([])
  })

  it("prefers the window that already shows the URL, and does not reload it", async () => {
    const other = appWindow("/inbox")
    const there = appWindow("/tasks/7")
    const { world, pushAndClick } = setup({}, [other, there])
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(there.focused).toBe(1)
    expect(there.navigated).toEqual([])
    expect(other.focused).toBe(0)
    expect(other.navigated).toEqual([])
    expect(world.opened).toEqual([])
  })

  it("opens a new window when the open one cannot be navigated", async () => {
    const uncontrolled = appWindow("/inbox", false)
    const { world, pushAndClick } = setup({}, [uncontrolled])
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(world.opened).toEqual([`${ORIGIN}/tasks/7`])
  })

  it("opens a new window when the browser has no navigate on a window", async () => {
    const open = appWindow("/inbox")
    delete open.navigate
    const { world, pushAndClick } = setup({}, [open])
    await pushAndClick({ title: "Hello", url: "/tasks/7" })
    expect(world.opened).toEqual([`${ORIGIN}/tasks/7`])
  })
})
