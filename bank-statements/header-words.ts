/**
 * The words of statement column names, in English, German, French and Russian: what
 * `guessProfile` names a column by, and the only words of a file that `inferProfile` sends a
 * model unmasked.
 *
 * @module
 */

import { foldHeader } from "./profile.ts"

/** Header words that name a column, in the languages of the first users. */
export const HEADER_WORDS = {
  balance: /balance|saldo|solde|остаток/,
  payee: /payee|recipient|beneficiary|counterparty|empfänger|получатель|bénéficiaire/,
  description: /description|memo|details|purpose|verwendungszweck|назначение|libellé/,
  reference: /reference|^ref/,
}

/**
 * Column-name words that `guessProfile` does not need, since it finds those columns by their
 * values (date, amount, debit and credit, currency, and the rest), and the small words between
 * them, as in "Datum der Buchung".
 */
const MORE_HEADER_WORDS = [
  // Dates.
  "date|datum|buchung|buchungstag|buchungsdatum|valuta|valutadatum|wertstellung|booking|posted|posting",
  "transaction|transactions|value|day|time|jour|opération|valeur|дата|операции|операция|проводки",
  // Amounts, debit and credit.
  "amount|betrag|umsatz|sum|total|montant|сумма|debit|credit|soll|haben|withdrawal|withdrawals",
  "deposit|deposits|paid|money|débit|crédit|belastung|gutschrift|дебет|кредит|приход|расход",
  "списание|зачисление|поступление|fee|fees|gebühr|frais|комиссия|original|originalbetrag",
  // Currency.
  "currency|ccy|währung|devise|monnaie|валюта",
  // Balances, parties, texts and identifiers that the guess does not name.
  "kontostand|account|konto|compte|счёт|счет|auftraggeber|zahlungsempfänger|name|payer|sender",
  "partner|merchant|контрагент|плательщик|text|buchungstext|note|notes|comment|kommentar",
  "описание|комментарий|type|typ|art|category|kategorie|catégorie|категория|status|iban|bic",
  "card|karte|carte|карта|number|nummer|nr|no|numéro|номер|bank|banque|банк",
  // The small words between them.
  // No one-letter words, so a name's initials stay masked.
  "the|of|in|out|and|or|to|from|by|der|die|das|des|und|im|für|von|nach|de|du|la|le|les|et|en",
  "по|на|от|для",
].join("|")

const WHOLE_HEADER_WORD = new RegExp(
  `^(?:${
    [...Object.values(HEADER_WORDS).map((words) => words.source), MORE_HEADER_WORDS].join("|")
  })$`,
  "u",
)

/** Whether `word`, after {@link foldHeader}, is a whole column-name word, never part of one. */
export function isHeaderWord(word: string): boolean {
  return WHOLE_HEADER_WORD.test(foldHeader(word))
}
