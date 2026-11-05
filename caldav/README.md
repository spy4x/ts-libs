# `@spy4x/caldav`

A CalDAV client that finds the user's calendars and changes tasks and events without overwriting
someone else's edit, plus the building blocks it uses: a safe reader for WebDAV multistatus XML,
request bodies that escape what they write, and the URL rules a CalDAV client needs (resolving
hrefs, comparing resources, sending credentials only to the configured server).

## Install

```bash
deno add jsr:@spy4x/caldav
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/caldav`](client.ts): A CalDAV client.
- [`@spy4x/caldav/xml`](xml.ts): WebDAV XML.
- [`@spy4x/caldav/url`](url.ts): URL rules for a CalDAV client.
- [`@spy4x/caldav/sync`](sync.ts): Brings a device's copy of CalDAV calendars up to date with the server, and nothing else.
- [`@spy4x/caldav/indexeddb`](indexeddb.ts): A durable copy of CalDAV calendars and their objects in IndexedDB, for browser apps.
- [`@spy4x/caldav/write`](write.ts): Sends an offline queue's writes to a CalDAV server, and reads the server's answers the way the queue needs them.
