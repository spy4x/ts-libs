# `@spy4x/search`

A forgiving full-text search for site and app search boxes. It is built on
[MiniSearch](https://github.com/lucaong/minisearch) 7.2.0 (MIT, no dependencies, about 6 KB gzipped)
and adds folding, aliases, a wrong-keyboard-layout pass, a typo pass and text the UI can mark
without HTML strings.

## Install

```bash
deno add jsr:@spy4x/search
```

Runs on: shared. Its sources use web standards only and no `Deno.*` API; a server builds the
index and a browser loads it.

## Module

- [`@spy4x/search`](mod.ts): `createIndex`, `loadIndex` and the entry and result types. Usage is
  in its module doc, shown by `deno doc` and on JSR.

## Example: an entry with aliases

```ts
import { createIndex, loadIndex } from "@spy4x/search"

const index = createIndex([
  { label: "Тёмная тема", aliases: ["dark mode", "night theme"], href: "/settings/theme" },
  { label: "ГосУслуги", detail: "Public services portal", href: "/gosuslugi" },
])

index.search("dark").hits[0].alias // "dark mode"
index.search("gosuslugy").hits[0].entry.href // "/gosuslugi"
index.search("ujceckeub").correction // "layout": typed in the wrong layout

// The server writes `JSON.stringify(index)` to `/search.json`; the browser loads it.
const loaded = loadIndex(await (await fetch("/search.json")).text())
loaded.search("темная", { limit: 10 }).hits[0].labelParts
// [{ text: "Тёмная", match: true }, { text: " тема", match: false }]
```

## How it matches

- Index and query words fold to one form: lower case, accents removed, `ё` as `е`, Cyrillic in
  Latin letters, `kh` as `h`, and `y` and `j` as `i`.
- Field weights: aliases = label > keywords > detail > text.
- Three passes, stopping at the first that finds anything: every word as a word prefix; the query
  read in the other keyboard layout (ЙЦУКЕН and QWERTY); one typo in words of four letters or
  more. `correction` says which pass answered.
- Equal scores keep the order the entries were passed in.
