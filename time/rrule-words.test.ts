// Behaviour tests for `describeRrule` in the nine languages its catalogs ship. Expected labels are
// written as a native speaker reads the rule, not copied from the implementation.
//
// `@spy4x/platform` already depends on this package, so only this test imports it: the module
// itself takes any translator of the same shape.

import { assert, assertEquals } from "@std/assert"
import { checkCatalogs, createTranslator, stampLocks } from "@spy4x/platform/universal/i18n"
import { describeRrule, parseRrule, type Rrule, type RruleWords } from "./rrule.ts"
import ar from "./rrule-words/ar.ts"
import de from "./rrule-words/de.ts"
import en from "./rrule-words/en.ts"
import es from "./rrule-words/es.ts"
import fr from "./rrule-words/fr.ts"
import ja from "./rrule-words/ja.ts"
import ptBR from "./rrule-words/pt-BR.ts"
import ru from "./rrule-words/ru.ts"
import zhCN from "./rrule-words/zh-CN.ts"

const TRANSLATIONS = { ar, de, es, fr, ja, "pt-BR": ptBR, ru, "zh-CN": zhCN }
const LANGUAGES = [`en`, ...Object.keys(TRANSLATIONS)]

function rule(text: string): Rrule {
  const result = parseRrule(text)
  if (!result.success) throw new Error(`${text}: ${result.error.message}`)
  return result.output
}

/** A translator for `language` that fails the test on any key its catalog lacks. */
function words(language: string): RruleWords {
  const translation = TRANSLATIONS[language as keyof typeof TRANSLATIONS]
  return createTranslator({
    language,
    catalogs: [translation ? { source: en, translation } : { source: en }],
    onMissing: (key) => {
      throw new Error(`${language} has no text for ${key}`)
    },
  })
}

const say = (text: string, language: string) => describeRrule(rule(text), words(language))

/** Every rule form the English label table covers, and the rest of the catalog's keys. */
const TABLE = [
  `FREQ=DAILY`,
  `FREQ=DAILY;INTERVAL=3`,
  `FREQ=WEEKLY`,
  `FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`,
  `FREQ=WEEKLY;INTERVAL=21`,
  `FREQ=MONTHLY`,
  `FREQ=MONTHLY;INTERVAL=6`,
  `FREQ=MONTHLY;BYDAY=-1FR`,
  `FREQ=MONTHLY;BYDAY=2MO`,
  `FREQ=MONTHLY;BYDAY=1FR,-1FR`,
  `FREQ=MONTHLY;BYDAY=-2SU`,
  `FREQ=MONTHLY;BYDAY=3WE,-3SA,4TU,-4TH,5SU,-5MO,FR`,
  `FREQ=MONTHLY;BYMONTHDAY=15`,
  `FREQ=MONTHLY;BYMONTHDAY=-1`,
  `FREQ=MONTHLY;BYMONTHDAY=-3`,
  `FREQ=MONTHLY;BYMONTHDAY=-2,-21,-22,-23`,
  `FREQ=MONTHLY;BYMONTHDAY=15,1,-1`,
  `FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13`,
  `FREQ=MONTHLY;BYMONTH=9,3`,
  `FREQ=YEARLY`,
  `FREQ=YEARLY;INTERVAL=2`,
  `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29`,
  `FREQ=DAILY;COUNT=5`,
  `FREQ=DAILY;COUNT=1`,
  `FREQ=DAILY;COUNT=2`,
  `FREQ=DAILY;COUNT=11`,
  `FREQ=WEEKLY;UNTIL=20261231T235959Z`,
]

Deno.test(`the rrule catalogs translate every English key with matching placeholders and plurals`, async () => {
  const languages = TRANSLATIONS as Record<string, (typeof TRANSLATIONS)[keyof typeof TRANSLATIONS]>
  const problems = await checkCatalogs({
    source: en,
    languages,
    // Stamped here, so a stale translation is not reported: these catalogs change in one PR.
    locks: await stampLocks(en, languages),
  })
  assertEquals(problems.map((problem) => problem.message), [])
  assertEquals(LANGUAGES.sort(), [`ar`, `de`, `en`, `es`, `fr`, `ja`, `pt-BR`, `ru`, `zh-CN`])
})

Deno.test(`describeRrule gives a whole sentence in each of the nine languages for every rule`, () => {
  for (const language of LANGUAGES) {
    const seen = new Set<string>()
    for (const text of TABLE) {
      const label = say(text, language)
      assert(label.length > 0, `${language} ${text}`)
      assert(!/[{}]/.test(label), `${language} ${text} left a placeholder: ${label}`)
      assert(!/\b(nth|gender|freq|interval|ordinalNumber)\./.test(label), `${language} ${label}`)
      assert(!seen.has(label), `${language} says "${label}" for two rules`)
      seen.add(label)
    }
  }
})

Deno.test(`describeRrule with the English catalog reads like the default label`, () => {
  const english = words(`en`)
  for (const text of TABLE) {
    const plain = describeRrule(rule(text))
    const translated = describeRrule(rule(text), english)
    // A translator follows `en`'s own conventions: a serial comma, a written-out date.
    if (/, until /.test(plain) || /, [^,]* and /.test(plain)) continue
    assertEquals(translated, plain, text)
  }
  assertEquals(
    say(`FREQ=MONTHLY;BYMONTHDAY=15,1,-1`, `en`),
    `Monthly on day 1, day 15, and the last day`,
  )
  assertEquals(say(`FREQ=WEEKLY;UNTIL=20261231T235959Z`, `en`), `Weekly, until December 31, 2026`)
})

Deno.test(`describeRrule says "the last Friday of the month" in every language`, () => {
  const expected: Record<string, string> = {
    en: `Monthly on the last Friday`,
    ru: `Ежемесячно: последняя пятница`,
    es: `Mensualmente, el último viernes`,
    de: `Monatlich am letzten Freitag`,
    "pt-BR": `Mensalmente na última sexta-feira`,
    ar: `شهريًا في يوم الجمعة الأخير`,
    fr: `Tous les mois, le dernier vendredi`,
    ja: `毎月、最終金曜日`,
    "zh-CN": `每月的最后一个星期五`,
  }
  for (const language of LANGUAGES) {
    assertEquals(say(`FREQ=MONTHLY;BYDAY=-1FR`, language), expected[language], language)
  }
})

Deno.test(`describeRrule says which of day 31 and the last day a monthly rule is`, () => {
  const cases: [string, string, string][] = [
    [`en`, `Monthly on day 31`, `Monthly on the last day`],
    [`ru`, `Ежемесячно, 31-го числа`, `Ежемесячно, в последний день месяца`],
    [`de`, `Monatlich am 31.`, `Monatlich am letzten Tag`],
    [`ja`, `毎月、31日`, `毎月、末日`],
  ]
  for (const [language, day31, last] of cases) {
    assertEquals(say(`FREQ=MONTHLY;BYMONTHDAY=31`, language), day31, language)
    assertEquals(say(`FREQ=MONTHLY;BYMONTHDAY=-1`, language), last, language)
  }
  assertEquals(say(`FREQ=MONTHLY;BYMONTHDAY=1`, `ru`), `Ежемесячно, 1-го числа`)
})

Deno.test(`describeRrule makes the ordinal agree with the weekday's gender`, () => {
  assertEquals(say(`FREQ=MONTHLY;BYDAY=1MO`, `ru`), `Ежемесячно: первый понедельник`)
  assertEquals(say(`FREQ=MONTHLY;BYDAY=1WE`, `ru`), `Ежемесячно: первая среда`)
  assertEquals(say(`FREQ=MONTHLY;BYDAY=-1SU`, `ru`), `Ежемесячно: последнее воскресенье`)
  assertEquals(
    say(`FREQ=MONTHLY;BYDAY=-1SA,2TU`, `pt-BR`),
    `Mensalmente no último sábado e na segunda terça-feira`,
  )
})

Deno.test(`describeRrule picks each language's plural form for intervals and counts`, () => {
  const cases: [string, string, string][] = [
    [`ru`, `FREQ=WEEKLY;INTERVAL=2`, `Каждые 2 недели`],
    [`ru`, `FREQ=WEEKLY;INTERVAL=5`, `Каждые 5 недель`],
    [`ru`, `FREQ=WEEKLY;INTERVAL=21`, `Каждую 21 неделю`],
    [`ru`, `FREQ=DAILY;COUNT=3`, `Ежедневно, 3 раза`],
    [`ru`, `FREQ=DAILY;COUNT=5`, `Ежедневно, 5 раз`],
    [`ar`, `FREQ=WEEKLY;INTERVAL=2`, `كل أسبوعين`],
    [`ar`, `FREQ=WEEKLY;INTERVAL=3`, `كل 3 أسابيع`],
    [`ar`, `FREQ=WEEKLY;INTERVAL=11`, `كل 11 أسبوعًا`],
    [`ar`, `FREQ=DAILY;COUNT=1`, `يوميًا، مرة واحدة`],
    [`ar`, `FREQ=DAILY;COUNT=2`, `يوميًا، مرتين`],
    [`ar`, `FREQ=DAILY;COUNT=3`, `يوميًا، 3 مرات`],
    [`ar`, `FREQ=DAILY;COUNT=100`, `يوميًا، 100 مرة`],
    [`es`, `FREQ=DAILY;COUNT=1`, `Diariamente, 1 vez`],
    [`es`, `FREQ=DAILY;COUNT=2`, `Diariamente, 2 veces`],
    [`zh-CN`, `FREQ=MONTHLY;INTERVAL=3`, `每3个月`],
  ]
  for (const [language, text, label] of cases) {
    assertEquals(say(text, language), label, `${language} ${text}`)
  }
})

Deno.test(`describeRrule writes weekdays, months, lists, ordinals and dates the language's way`, () => {
  const cases: [string, string, string][] = [
    [`de`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`, `Alle 2 Wochen am Mo und Do`],
    [`fr`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`, `Toutes les 2 semaines (lun., jeu.)`],
    [`ja`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`, `2週間ごと（月、木）`],
    [`zh-CN`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO`, `每2周的周一、周四`],
    [`es`, `FREQ=MONTHLY;BYMONTHDAY=15,1,-1`, `Mensualmente, el día 1, el día 15 y el último día`],
    [`en`, `FREQ=MONTHLY;BYMONTHDAY=-21`, `Monthly on the 21st to last day`],
    [`fr`, `FREQ=MONTHLY;BYMONTHDAY=-3`, `Tous les mois, le 3e jour en partant de la fin du mois`],
    [`ru`, `FREQ=MONTHLY;BYMONTHDAY=-3`, `Ежемесячно, в 3-й день с конца месяца`],
    [`de`, `FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13`, `Monatlich, jeden Fr, nur am 13.`],
    [`pt-BR`, `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29`, `Anualmente no dia 29, em fev.`],
    [`ru`, `FREQ=MONTHLY;BYMONTH=9,3`, `Ежемесячно, месяцы: март, сент.`],
    [`de`, `FREQ=WEEKLY;UNTIL=20261231T235959Z`, `Wöchentlich, bis zum 31. Dezember 2026`],
    [`ja`, `FREQ=WEEKLY;UNTIL=20261231T235959Z`, `毎週、2026年12月31日まで`],
  ]
  for (const [language, text, label] of cases) {
    assertEquals(say(text, language), label, `${language} ${text}`)
  }
})
