import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  type CatalogPair,
  createTranslator,
  negotiateLanguage,
  parseAcceptLanguage,
  pseudoLocalize,
  textDirection,
} from "./i18n.ts"

/** Shaped like a JSON import: plain `string` values, no literal types. */
const en = {
  "notes.empty": "No notes yet",
  "notes.count": { one: "{count} note", other: "{count} notes" },
  "notes.by": "Written by {name}",
  "signup.terms": "I agree to the <terms>Terms</terms> as {name}.",
}

const ru = {
  "notes.empty": "Заметок пока нет",
  "notes.count": {
    one: "{count} заметка",
    few: "{count} заметки",
    many: "{count} заметок",
    other: "{count} заметки",
  },
}

const ar = {
  "notes.count": {
    zero: "لا ملاحظات",
    one: "ملاحظة واحدة",
    two: "ملاحظتان",
    few: "{count} ملاحظات",
    many: "{count} ملاحظة",
    other: "{count} ملاحظة.",
  },
}

function translator(
  language: string,
  translation?: CatalogPair["translation"],
  numberLocale?: string,
) {
  const missing: string[] = []
  const translate = createTranslator<keyof typeof en>({
    language,
    numberLocale,
    catalogs: [{ source: en, translation }],
    onMissing: (key, lang) => missing.push(`${lang}:${key}`),
  })
  return { ...translate, missing }
}

describe("createTranslator", () => {
  it("returns English text and English plurals with grouped numbers", () => {
    const { t, missing } = translator("en")
    expect(t("notes.empty")).toBe("No notes yet")
    expect(t("notes.count", { count: 1 })).toBe("1 note")
    expect(t("notes.count", { count: 1234 })).toBe("1,234 notes")
    expect(missing).toEqual([])
  })

  it("picks Russian one, few and many forms", () => {
    const { t } = translator("ru", ru)
    expect(t("notes.count", { count: 1 })).toBe("1 заметка")
    expect(t("notes.count", { count: 3 })).toBe("3 заметки")
    expect(t("notes.count", { count: 5 })).toBe("5 заметок")
    expect(t("notes.count", { count: 21 })).toBe("21 заметка")
  })

  it("picks all six Arabic plural forms", () => {
    // Latin digits: whether `ar` alone formats with Arabic-Indic digits depends on the ICU version.
    const { t } = translator("ar", ar, "ar-u-nu-latn")
    expect([0, 1, 2, 3, 11, 100].map((count) => t("notes.count", { count }))).toEqual([
      "لا ملاحظات",
      "ملاحظة واحدة",
      "ملاحظتان",
      "3 ملاحظات",
      "11 ملاحظة",
      "100 ملاحظة.",
    ])
  })

  it("uses the many form in Spanish and Brazilian Portuguese for a million", () => {
    const many = { one: "{count} nota", many: "{count} de notas", other: "{count} notas" }
    const es = translator("es", { "notes.count": many })
    const pt = translator("pt-BR", { "notes.count": many })
    expect(es.t("notes.count", { count: 1_000_000 })).toBe("1.000.000 de notas")
    expect(pt.t("notes.count", { count: 1_000_000 })).toBe("1.000.000 de notas")
    expect(es.t("notes.count", { count: 2 })).toBe("2 notas")
  })

  it("falls back to the other form when the catalog lacks the chosen one", () => {
    const { t } = translator("ru", {
      "notes.count": { one: "{count} заметка", other: "{count} шт." },
    })
    expect(t("notes.count", { count: 5 })).toBe("5 шт.")
  })

  it("formats numbers for the region format and plurals for the language", () => {
    const de = { "notes.count": { one: "{count} Notiz", other: "{count} Notizen" } }
    expect(translator("de", de).t("notes.count", { count: 1234 })).toBe("1.234 Notizen")
    expect(translator("de", de, "en-US").t("notes.count", { count: 1234 })).toBe("1,234 Notizen")
  })

  it("falls back to English and reports a key the translation lacks", () => {
    const { t, missing } = translator("de", { "notes.empty": "Noch keine Notizen" })
    expect(t("notes.by", { name: "Ana" })).toBe("Written by Ana")
    expect(missing).toEqual(["de:notes.by"])
  })

  it("falls back to English for an empty translation", () => {
    const { t, missing } = translator("de", { "notes.empty": "" })
    expect(t("notes.empty")).toBe("No notes yet")
    expect(missing).toEqual(["de:notes.empty"])
  })

  it("falls back to English for a plural translation with an empty form", () => {
    const { t, missing } = translator("ru", { "notes.count": { ...ru["notes.count"], many: "" } })
    expect(t("notes.count", { count: 5 })).toBe("5 notes")
    expect(missing).toEqual(["ru:notes.count"])
  })

  it("treats prototype names as unknown keys and unknown values", () => {
    const missing: string[] = []
    const { t } = createTranslator<string>({
      language: "de",
      catalogs: [{
        source: { hi: "Hi {constructor}" },
        translation: { hi: "Hallo {constructor}" },
      }],
      onMissing: (key) => missing.push(key),
    })
    expect(t("constructor")).toBe("constructor")
    expect(t("toString")).toBe("toString")
    expect(t("hi", {})).toBe("Hallo {constructor}")
    expect(missing).toEqual(["constructor", "toString"])
    // English has no translation to miss, so only a key absent from the catalog itself is reported.
    const english = translator("en")
    // @ts-expect-error: not a catalog key.
    expect(english.t("constructor")).toBe("constructor")
    expect(english.missing).toEqual(["en:constructor"])
  })

  it("falls back to the key and reports a key no catalog has", () => {
    const { t, missing } = translator("en")
    // @ts-expect-error: the key type is `keyof typeof en`, so an unknown key does not compile.
    expect(t("notes.nope")).toBe("notes.nope")
    expect(missing).toEqual(["en:notes.nope"])
  })

  it("lets a later catalog override a key of an earlier one", () => {
    const library = { "ui.save": "Save", "ui.cancel": "Cancel" }
    const app = { "ui.save": "Save note" }
    const { t } = createTranslator<"ui.save" | "ui.cancel">({
      language: "en",
      catalogs: [{ source: library }, { source: app }],
    })
    expect(t("ui.save")).toBe("Save note")
    expect(t("ui.cancel")).toBe("Cancel")
  })

  it("leaves a placeholder without a value as it is", () => {
    expect(translator("en").t("notes.by")).toBe("Written by {name}")
    expect(translator("en").t("notes.by", { count: 1 })).toBe("Written by {name}")
  })

  it("drops tag markers from plain text", () => {
    expect(translator("en").t("signup.terms", { name: "Ana" })).toBe(
      "I agree to the Terms as Ana.",
    )
  })

  it("keeps a value that looks like a tag as text in plain text", () => {
    expect(translator("en").t("signup.terms", { name: "<terms>x</terms>" })).toBe(
      "I agree to the Terms as <terms>x</terms>.",
    )
  })

  it("fills a placeholder inside a tag span", () => {
    const { parts } = createTranslator<"link">({
      language: "en",
      catalogs: [{ source: { link: "See <terms>the terms of {name}</terms>" } }],
    })
    expect(parts("link", { name: "Ana" })).toEqual([
      "See ",
      { tag: "terms", text: "the terms of Ana" },
    ])
  })

  it("returns tag spans as parts and never turns a value into a tag", () => {
    const { parts } = translator("en")
    expect(parts("signup.terms", { name: "<terms>x</terms>" })).toEqual([
      "I agree to the ",
      { tag: "terms", text: "Terms" },
      " as <terms>x</terms>.",
    ])
  })

  it("gives the text direction of its language", () => {
    expect(translator("ar", ar).dir).toBe("rtl")
    expect(translator("ru", ru).dir).toBe("ltr")
  })
})

describe("textDirection", () => {
  it("is rtl for Arabic, Hebrew, Persian and Dhivehi, ltr for others", () => {
    expect(["ar", "he", "fa", "dv", "ar-EG"].map(textDirection)).toEqual(Array(5).fill("rtl"))
    expect(["en", "ru", "de", "pt-BR", "en-XA"].map(textDirection)).toEqual(Array(5).fill("ltr"))
  })

  it("is ltr for a tag Intl cannot parse", () => {
    expect(textDirection("not a tag!")).toBe("ltr")
  })
})

describe("negotiateLanguage", () => {
  const supported = ["en", "ru", "es", "de", "pt-BR", "ar"] as const

  it("prefers an exact tag, compared without case", () => {
    expect(negotiateLanguage(["PT-br"], supported, "en")).toBe("pt-BR")
  })

  it("matches the same language with another region", () => {
    expect(negotiateLanguage("pt-PT", supported, "en")).toBe("pt-BR")
    expect(negotiateLanguage("de-AT", supported, "en")).toBe("de")
  })

  it("takes the requested languages in order", () => {
    expect(negotiateLanguage(["fr", "de-CH", "ru"], supported, "en")).toBe("de")
  })

  it("prefers the bare language over a regional one for a regional request", () => {
    expect(negotiateLanguage("en-US", ["en-GB", "en"], "en-GB")).toBe("en")
  })

  it("looks at no more than the first 32 requested languages", () => {
    expect(negotiateLanguage([...Array(32).fill("fr"), "de"], supported, "en")).toBe("en")
    expect(negotiateLanguage([...Array(31).fill("fr"), "de"], supported, "en")).toBe("de")
  })

  it("returns the fallback when nothing matches", () => {
    expect(negotiateLanguage(["fr", "ja"], supported, "en")).toBe("en")
    expect(negotiateLanguage(null, supported, "en")).toBe("en")
  })

  it("never returns a tag outside the supported list for hostile input", () => {
    const hostile = [
      "../../etc/passwd",
      "__proto__",
      "constructor",
      "x".repeat(100_000),
      "ar".padEnd(10_000, "-a"),
      "",
      "-",
      "*",
      ...Array(1000).fill("fr"),
    ]
    for (const tag of hostile) {
      expect(supported).toContain(negotiateLanguage(tag, supported, "en"))
    }
    expect(negotiateLanguage(hostile, supported, "en")).toBe("en")
    // A non-string sneaked in through an untyped JSON value.
    expect(negotiateLanguage([42, {}] as unknown as string[], supported, "en")).toBe("en")
  })
})

describe("parseAcceptLanguage", () => {
  it("orders tags by quality, then by position", () => {
    expect(parseAcceptLanguage("de;q=0.5, ru, pt-BR;q=0.9, es;q=0.5")).toEqual([
      "ru",
      "pt-BR",
      "de",
      "es",
    ])
  })

  it("drops the wildcard, a zero quality and malformed entries", () => {
    expect(parseAcceptLanguage("*, de;q=0, en-US;q=abc, <script>, ru;q=0.1")).toEqual(["ru"])
  })

  it("returns nothing for a missing header", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([])
    expect(parseAcceptLanguage("")).toEqual([])
  })

  it("reads only the first 256 characters, cut back to the last whole entry", () => {
    const header = `${"fr,".repeat(83)} zh-Hant-TW, ru`
    // The cap falls inside the Chinese tag, and its cut-off start is a valid tag of its own.
    expect(header.slice(0, 256).endsWith(" zh-Han")).toBe(true)
    expect(parseAcceptLanguage(header)).toEqual(Array(83).fill("fr"))
  })
})

describe("pseudoLocalize", () => {
  it("accents, brackets and lengthens text, keeping placeholders and tags", () => {
    const pseudo = pseudoLocalize(en)
    const terms = pseudo["signup.terms"] as string
    expect(terms.startsWith("⟦")).toBe(true)
    expect(terms.endsWith("⟧")).toBe(true)
    expect(terms).toContain("<terms>")
    expect(terms).toContain("</terms>")
    expect(terms).toContain("{name}")
    expect(terms).toContain("Í ágréé")
    // "I agree to the ", "Terms", " as " and "." are 25 characters; 40 % of them is 10.
    expect(terms.match(/~/g)?.length).toBe(10)
  })

  it("keeps every plural form and its placeholder", () => {
    const count = pseudoLocalize(en)["notes.count"]
    expect(count).toEqual({ one: "⟦{count} ñóté~~⟧", other: "⟦{count} ñótés~~~⟧" })
  })

  it("renders through a translator with the placeholders still filled", () => {
    const { t } = createTranslator<keyof typeof en>({
      language: "en-XA",
      catalogs: [{ source: en, translation: pseudoLocalize(en) }],
    })
    expect(t("notes.by", { name: "Ana" })).toBe("⟦Wríttéñ bý Ana~~~~~⟧")
  })
})
