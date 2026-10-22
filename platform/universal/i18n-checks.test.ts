import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type Catalog, checkCatalogs, findUnusedKeys, stampLocks } from "./i18n.ts"

const en = {
  "notes.empty": "No notes yet",
  "notes.count": { one: "{count} note", other: "{count} notes" },
  "signup.terms": "I agree to the <terms>Terms</terms>.",
}

/** A complete, correct translation in each of the six first languages. */
const languages: Record<string, Catalog> = {
  ru: {
    "notes.empty": "Заметок пока нет",
    "notes.count": {
      one: "{count} заметка",
      few: "{count} заметки",
      many: "{count} заметок",
      other: "{count} заметки",
    },
    "signup.terms": "Я принимаю <terms>Условия</terms>.",
  },
  es: {
    "notes.empty": "Aún no hay notas",
    "notes.count": { one: "{count} nota", many: "{count} de notas", other: "{count} notas" },
    "signup.terms": "Acepto los <terms>Términos</terms>.",
  },
  de: {
    "notes.empty": "Noch keine Notizen",
    "notes.count": { one: "{count} Notiz", other: "{count} Notizen" },
    "signup.terms": "Ich stimme den <terms>Bedingungen</terms> zu.",
  },
  "pt-BR": {
    "notes.empty": "Nenhuma nota ainda",
    "notes.count": { one: "{count} nota", many: "{count} de notas", other: "{count} notas" },
    "signup.terms": "Eu aceito os <terms>Termos</terms>.",
  },
  ar: {
    "notes.empty": "لا توجد ملاحظات بعد",
    "notes.count": {
      zero: "{count} ملاحظات",
      one: "ملاحظة {count}",
      two: "ملاحظتان {count}",
      few: "{count} ملاحظات",
      many: "{count} ملاحظة",
      other: "{count} ملاحظة",
    },
    "signup.terms": "أوافق على <terms>الشروط</terms>.",
  },
}

/** Check one German catalog against `source`, locked against `lockedSource`. */
async function checkGerman(de: Catalog, source: Catalog = en, lockedSource: Catalog = source) {
  const locks = await stampLocks(lockedSource, { de })
  return checkCatalogs({ source, languages: { de }, locks })
}

describe("checkCatalogs", () => {
  it("finds no problem in complete, freshly stamped catalogs for six languages", async () => {
    const locks = await stampLocks(en, languages)
    expect(await checkCatalogs({ source: en, languages, locks })).toEqual([])
  })

  it("reports a missing key", async () => {
    const { "notes.empty": _, ...de } = languages.de
    expect(await checkGerman(de)).toEqual([{
      kind: "missing",
      language: "de",
      key: "notes.empty",
      message: `de "notes.empty" is missing. ` +
        "Translate it in the de catalog, then run `deno task i18n:stamp`.",
    }])
  })

  it("reports an extra key", async () => {
    const problems = await checkGerman({ ...languages.de, "notes.old": "Alt" })
    expect(problems.map((problem) => [problem.kind, problem.key])).toEqual([
      ["extra", "notes.old"],
    ])
    expect(problems[0].message).toMatch(/Delete it from the de catalog, then run `.+`\.$/)
  })

  it("reports an empty text and an empty plural form", async () => {
    const problems = await checkGerman({
      ...languages.de,
      "notes.empty": "  ",
      "notes.count": { one: "{count} Notiz", other: "" },
    })
    expect(problems.map((problem) => [problem.kind, problem.key])).toEqual([
      ["empty", "notes.count"],
      ["empty", "notes.empty"],
    ])
  })

  it("reports a translation made from English that changed since", async () => {
    const newEnglish = { ...en, "notes.empty": "Nothing here yet" }
    const problems = await checkGerman(languages.de, newEnglish, en)
    expect(problems).toEqual([{
      kind: "stale",
      language: "de",
      key: "notes.empty",
      message: `de "notes.empty" was translated from older English. ` +
        "Check the translation against the English, then run `deno task i18n:stamp`.",
    }])
  })

  it("reports a translation that has no lock line", async () => {
    const problems = await checkCatalogs({
      source: en,
      languages: { de: languages.de },
      locks: {},
    })
    expect(problems.map((problem) => problem.kind)).toEqual(["stale", "stale", "stale"])
    expect(problems[0].message).toContain("has no lock line")
  })

  it("reports placeholders that differ from the English", async () => {
    const problems = await checkGerman({
      ...languages.de,
      "notes.count": { one: "{n} Notiz", other: "{n} Notizen" },
    })
    expect(problems.map((problem) => [problem.kind, problem.message])).toEqual([[
      "placeholder",
      `de "notes.count" has placeholders n, the English has count. ` +
      "Translate it in the de catalog, then run `deno task i18n:stamp`.",
    ]])
  })

  it("reports tags that differ from the English", async () => {
    const problems = await checkGerman({ ...languages.de, "signup.terms": "Ich stimme zu." })
    expect(problems.map((problem) => [problem.kind, problem.message])).toEqual([[
      "tag",
      `de "signup.terms" has tags none, the English has terms. ` +
      "Translate it in the de catalog, then run `deno task i18n:stamp`.",
    ]])
  })

  it("reports plural forms the language does not use, or lacks", async () => {
    const ru = {
      ...languages.ru,
      "notes.count": { one: "{count} заметка", other: "{count} заметки" },
    }
    const problems = await checkCatalogs({
      source: en,
      languages: { ru },
      locks: await stampLocks(en, { ru }),
    })
    expect(problems.map((problem) => [problem.kind, problem.message])).toEqual([[
      "plural",
      `ru "notes.count" has plural forms one, other, ru needs one, few, many, other. ` +
      "Translate it in the ru catalog, then run `deno task i18n:stamp`.",
    ]])
  })

  it("reports one text where the English has plural forms", async () => {
    const problems = await checkGerman({ ...languages.de, "notes.count": "{count} Notizen" })
    expect(problems.map((problem) => problem.kind)).toEqual(["plural"])
  })

  it("reports plural forms the English itself lacks", async () => {
    const source = { ...en, "notes.count": { other: "{count} notes" } }
    const problems = await checkCatalogs({ source, languages: {}, locks: {} })
    expect(problems.map((problem) => [problem.kind, problem.language])).toEqual([
      ["plural", "en"],
    ])
  })

  it("names the app's own stamp command", async () => {
    const { "notes.empty": _, ...de } = languages.de
    const [problem] = await checkCatalogs({
      source: en,
      languages: { de },
      locks: await stampLocks(en, { de }),
      stampCommand: "npm run i18n:stamp",
    })
    expect(problem.message).toMatch(/run `npm run i18n:stamp`\.$/)
  })
})

describe("stampLocks", () => {
  it("writes one sorted key and hash line per translated key", async () => {
    const { de } = await stampLocks(en, { de: { "signup.terms": "x", "notes.empty": "y" } })
    expect(de).toMatch(/^notes\.empty\t[0-9a-f]{16}\nsignup\.terms\t[0-9a-f]{16}\n$/)
  })

  it("gives the same hash whatever order the plural forms are written in", async () => {
    const reordered = { ...en, "notes.count": { other: "{count} notes", one: "{count} note" } }
    expect(await stampLocks(reordered, languages)).toEqual(await stampLocks(en, languages))
  })

  it("changes a key's hash when its English changes", async () => {
    const before = await stampLocks(en, { de: languages.de })
    const after = await stampLocks({ ...en, "notes.empty": "Nothing yet" }, { de: languages.de })
    const line = (lock: string) => lock.split("\n").find((l) => l.startsWith("notes.empty\t"))
    expect(line(after.de)).not.toBe(line(before.de))
  })
})

describe("findUnusedKeys", () => {
  const catalog = { "notes.empty": "", "notes.count": "", "errors.not_found": "", "a.b": "" }

  it("lists keys no source text names as a quoted literal", () => {
    const sources = [`t("notes.empty")`, "t('a.b')", "const k = `notes.count.extra`"]
    expect(findUnusedKeys(catalog, sources)).toEqual(["errors.not_found", "notes.count"])
  })

  it("counts every quote style and skips declared dynamic families", () => {
    const sources = [`t("notes.empty")`, "t('a.b')", "t(`notes.count`)"]
    expect(findUnusedKeys(catalog, sources, { allowedDynamicPrefixes: ["errors."] })).toEqual([])
  })
})
