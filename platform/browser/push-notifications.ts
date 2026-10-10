/**
 * Web Push in a service worker: show the notification a push carries, and open the app where it
 * points when the notification is clicked.
 *
 * - `push`: the payload is read as JSON and checked against `pushNotificationMessageSchema`. A
 *   valid one is shown with its title, body and tag. A notification with the same tag replaces
 *   the one on screen, so the same reminder sent twice never stacks. A push with no payload, or
 *   with one that is not a notification message, shows nothing: the payload is input, and only
 *   the app's own server can produce a valid one. A key this module does not know is ignored,
 *   and the known ones are still checked. A browser can run yesterday's cached worker for a
 *   while, so a field added to the message later must not silence it. The server's check of an
 *   outgoing message stays strict.
 * - `notificationclick`: the notification is closed. An open window of the app is focused and
 *   sent to the message's URL; with none open, a new window opens there.
 * - Only a URL of the worker's own origin is ever opened. Any other (another site, a
 *   `javascript:` URL, something that is not a URL) is replaced by `defaultUrl`, as is a message
 *   with no URL.
 *
 * The worker's file then holds one more line. Bundle it before serving, as for
 * `browser/offline-shell`:
 *
 * ```js
 * // installPushNotifications comes from this package's `browser/push-notifications` entry point
 * import { installPushNotifications } from "<this package>/browser/push-notifications"
 * installPushNotifications(self, { icon: "/icon-192.png" })
 * ```
 *
 * Nothing touches a global at import time: the worker scope is a parameter.
 * @module
 */
import { type } from "arktype"
import { pushNotificationMessageSchema } from "../model/push.ts"

/** The parts of a `Client` this module uses; a `WindowClient` has all three. */
export interface PushClient {
  url: string
  focus?: () => Promise<unknown>
  navigate?: (url: string) => Promise<unknown>
}

/** What this module passes to `showNotification`. */
export interface PushNotificationOptions {
  body?: string
  tag?: string
  icon?: string
  badge?: string
  /** Where a click leads; read back in the `notificationclick` handler. */
  data: { url: string }
}

/** The parts of a `PushEvent` this module uses. */
export interface PushScopeEvent {
  /** `null` for a push with no payload. */
  data: { json: () => unknown } | null
  waitUntil: (promise: Promise<unknown>) => void
}

/** The parts of a `NotificationEvent` this module uses. */
export interface PushClickEvent {
  notification: { close: () => void; data?: unknown }
  waitUntil: (promise: Promise<unknown>) => void
}

/** The parts of the service-worker global scope this module uses; `self` fits. */
export interface PushScope {
  location: { origin: string }
  registration: {
    showNotification: (title: string, options?: PushNotificationOptions) => Promise<void>
  }
  clients: {
    matchAll: (
      options?: { type?: "window"; includeUncontrolled?: boolean },
    ) => Promise<readonly PushClient[]>
    openWindow: (url: string) => Promise<unknown>
  }
  /** `any` because the real scope types each event name's listener differently. */
  // deno-lint-ignore no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void
}

/** Options of {@link installPushNotifications}. */
export interface PushNotificationsOptions {
  /** Where a click leads when the message names no usable URL. Default `/`. */
  defaultUrl?: string
  /** URL of the image shown with every notification. */
  icon?: string
  /** URL of the small monochrome image a phone shows in its status bar. */
  badge?: string
}

/** The keys of a message this module reads; any other key of a pushed payload is ignored. */
const KNOWN_KEYS = ["title", "body", "url", "tag"]

/**
 * `raw` as an absolute URL when it belongs to `origin`, otherwise `undefined`. A path such as
 * `/tasks/1` is resolved against `origin`; `//other.example`, another scheme and a value that is
 * not a string are refused.
 */
export function sameOriginUrl(raw: unknown, origin: string): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined
  try {
    const url = new URL(raw, origin)
    return url.origin === origin ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the `push` and `notificationclick` listeners of a service worker.
 *
 * @param scope The worker global scope (`self`).
 * @param options See {@link PushNotificationsOptions}.
 */
export function installPushNotifications(
  scope: PushScope,
  options: PushNotificationsOptions = {},
): void {
  const { origin } = scope.location
  const home = sameOriginUrl(options.defaultUrl ?? "/", origin) ?? new URL("/", origin).href
  const target = (raw: unknown): string => sameOriginUrl(raw, origin) ?? home

  scope.addEventListener("push", (event: PushScopeEvent) => {
    // deno-lint-ignore no-explicit-any
    let payload: any
    try {
      payload = event.data?.json()
    } catch {
      return
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return
    const message = pushNotificationMessageSchema(
      Object.fromEntries(
        KNOWN_KEYS.filter((key) => key in payload).map((key) => [key, payload[key]]),
      ),
    )
    if (message instanceof type.errors) return
    const shown: PushNotificationOptions = { data: { url: target(message.url) } }
    if (message.body !== null) shown.body = message.body
    if (message.tag !== undefined) shown.tag = message.tag
    if (options.icon !== undefined) shown.icon = options.icon
    if (options.badge !== undefined) shown.badge = options.badge
    event.waitUntil(scope.registration.showNotification(message.title, shown))
  })

  /** Focus a window of the app and send it to `url`, or open a new one there. */
  async function open(url: string): Promise<void> {
    const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true })
    const client = windows.find((candidate) => candidate.url === url) ?? windows[0]
    if (!client) {
      await scope.clients.openWindow(url)
      return
    }
    try {
      await client.focus?.()
      if (client.url === url) return
      // A window this worker does not control yet cannot be navigated: that rejects, and a
      // browser without `navigate` cannot do it at all. Both end in a new window.
      if (!client.navigate) throw new Error("this window cannot be navigated")
      await client.navigate(url)
    } catch {
      await scope.clients.openWindow(url)
    }
  }

  scope.addEventListener("notificationclick", (event: PushClickEvent) => {
    event.notification.close()
    // The data was written by the push handler above; it is checked again all the same.
    const data = event.notification.data as { url?: unknown } | null | undefined
    event.waitUntil(open(target(data?.url)))
  })
}
