/**
 * Parse one quick-add line such as `Call Anna @phone #work tomorrow 3pm !high` into a title, tags,
 * contexts, a due date and a priority, plus the position of every recognised token so a field can
 * highlight them as the person types.
 *
 * A pure function: the clock and the time zone come in as arguments, and every date is worked out
 * by `@spy4x/time/tz`, never by hand.
 *
 * @module
 */

import { addDays, dayOfWeek, isoDateInTz, minToHHMM } from "@spy4x/time/tz"
import { parseIsoDate } from "@spy4x/time/date"

/** Task priority. The numbers are the digits of `!1`, `!2` and `!3`. */
export enum QuickAddPriority {
  High = 1,
  Medium = 2,
  Low = 3,
}

/** What a recognised token is. */
export enum QuickAddSpanKind {
  Tag = 1,
  Context = 2,
  Priority = 3,
  Date = 4,
  Time = 5,
}

/** One recognised token, as a half-open range of UTF-16 offsets into the original line. */
export interface QuickAddSpan {
  kind: QuickAddSpanKind
  /** Offset of the first character of the token in the line. */
  start: number
  /** Offset just after the last character, so `line.slice(start, end)` is the token. */
  end: number
  /** The token exactly as typed. */
  text: string
}

/** When the task is due: a calendar date in the given time zone, and a wall-clock time if typed. */
export interface QuickAddDue {
  /** `YYYY-MM-DD`. */
  date: string
  /** `HH:MM`, 24-hour, when the line named a time. */
  time?: string
}

/** The result of {@link parseQuickAdd}. */
export interface QuickAddResult {
  /** The line without its tokens, words joined by single spaces. Escapes are removed. */
  title: string
  /** `#tag` names without the `#`, in order of appearance. `#Work #work` is one tag, `Work`. */
  tags: string[]
  /** `@context` names without the `@`, nested as `work/meetings`; case-insensitively unique. */
  contexts: string[]
  due?: QuickAddDue
  priority?: QuickAddPriority
  /** Every recognised token, in order of appearance. */
  spans: QuickAddSpan[]
}

/** Options of {@link parseQuickAdd}. */
export interface QuickAddOptions {
  /** The current instant; "today" is read from it in `timeZone`. */
  now: Date
  /** IANA time zone the person lives in, e.g. `Asia/Ho_Chi_Minh`. */
  timeZone: string
  /**
   * BCP 47 tag choosing the words for dates and priorities. Only `en` exists today; any other tag
   * falls back to it.
   */
  locale?: string
}

/** The words a locale uses for date and priority tokens, all lower case. */
export interface QuickAddWords {
  today: string
  tomorrow: string
  /** Monday first. */
  weekdays: readonly string[]
  /** The word that starts "in 3 days". */
  in: string
  days: readonly string[]
  weeks: readonly string[]
  /** The word that may precede a time. */
  at: string
  high: string
  medium: string
  low: string
}

/**
 * The word tables by lower-case language subtag. `en` is the fallback for any locale not listed;
 * an app can add its own language here before parsing.
 */
export const quickAddWords: Record<string, QuickAddWords> = {
  en: {
    today: "today",
    tomorrow: "tomorrow",
    weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    in: "in",
    days: ["day", "days"],
    weeks: ["week", "weeks"],
    at: "at",
    high: "high",
    medium: "medium",
    low: "low",
  },
}

/** What `dayOfWeek` answers for each weekday, Monday first. */
const TZ_WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

const NAME = String.raw`[\p{L}\p{N}\p{M}_-]+`
const TAG = new RegExp(`^#(${NAME})$`, "u")
const CONTEXT = new RegExp(`^@(${NAME}(?:/${NAME})*)$`, "u")
const PRIORITY = /^!(.+)$/
const TIME_12H = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/
const TIME_24H = /^(\d{1,2}):(\d{2})$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const COUNT = /^\d{1,4}$/

/**
 * Read the tokens out of a quick-add line.
 *
 * Recognised tokens, each only as a whole space-separated word (so `a#b` and `me@example.com` are
 * plain text):
 *
 * - `#tag` and `@context`, where a context may nest as `@work/meetings`. Letters and digits of any
 *   script, `_` and `-` are allowed, so `#việc` and `@дом` work. A word with trailing punctuation
 *   such as `#work,` is not a token.
 * - `!high`, `!medium`, `!low`, or `!1`, `!2`, `!3` (high to low).
 * - A date: `today`, `tomorrow`, a full weekday name (the next one after today, never today),
 *   `in 3 days`, `in 2 weeks`, or `2026-03-14`. Days are counted in `timeZone`, so late in the
 *   evening "tomorrow" is the day after the person's today, not after UTC's.
 * - A time: `3pm`, `3:30pm`, `15:00`, optionally after `at`. A time with no date means today, even
 *   when that time has passed.
 *
 * Only the first date, first time and first priority count; a second one stays in the title. A
 * backslash before `#`, `@` or `!`, or before a date or time word, keeps it literal and is removed
 * from the title: `Room \#1` gives `Room #1`.
 *
 * The title is the remaining words joined by single spaces. Text is never changed otherwise, so
 * any script and emoji survive as typed.
 *
 * @throws When `timeZone` is not a valid IANA time zone, or `now` is an invalid `Date`.
 */
export function parseQuickAdd(line: string, options: QuickAddOptions): QuickAddResult {
  const language = options.locale?.split("-")[0].toLowerCase() ?? "en"
  const words = Object.hasOwn(quickAddWords, language) ? quickAddWords[language] : quickAddWords.en
  const today = isoDateInTz(options.now, options.timeZone)
  const tokens = [...line.matchAll(/\S+/gu)].map((m) => ({ text: m[0], start: m.index }))

  const tags: string[] = []
  const contexts: string[] = []
  const seenTags = new Set<string>()
  const seenContexts = new Set<string>()
  const spans: QuickAddSpan[] = []
  const title: string[] = []
  let date: string | undefined
  let time: string | undefined
  let priority: QuickAddPriority | undefined

  const span = (kind: QuickAddSpanKind, from: number, to: number) => {
    const first = tokens[from]
    const last = tokens[to]
    const end = last.start + last.text.length
    spans.push({ kind, start: first.start, end, text: line.slice(first.start, end) })
  }

  /** The date a word names, if it is one and a date is still wanted; `length` words consumed. */
  const dateAt = (i: number): { value: string; length: number } | undefined => {
    const word = tokens[i].text.toLowerCase()
    if (word === words.today) return { value: today, length: 1 }
    if (word === words.tomorrow) return { value: addDays(today, 1, options.timeZone), length: 1 }
    const weekday = words.weekdays.indexOf(word)
    if (weekday >= 0) {
      for (let n = 1; n <= 7; n++) {
        const candidate = addDays(today, n, options.timeZone)
        if (dayOfWeek(candidate, options.timeZone) === TZ_WEEKDAYS[weekday]) {
          return { value: candidate, length: 1 }
        }
      }
    }
    if (ISO_DATE.test(word)) {
      try {
        parseIsoDate(word)
        return { value: word, length: 1 }
      } catch {
        return undefined
      }
    }
    if (word === words.in && i + 2 < tokens.length && COUNT.test(tokens[i + 1].text)) {
      const unit = tokens[i + 2].text.toLowerCase()
      const count = Number(tokens[i + 1].text)
      if (words.days.includes(unit)) {
        return { value: addDays(today, count, options.timeZone), length: 3 }
      }
      if (words.weeks.includes(unit)) {
        return { value: addDays(today, count * 7, options.timeZone), length: 3 }
      }
    }
    return undefined
  }

  /** The `HH:MM` a word names, if it is a time. */
  const timeOf = (word: string): string | undefined => {
    const lower = word.toLowerCase()
    const twelve = TIME_12H.exec(lower)
    if (twelve) {
      const hour = Number(twelve[1])
      const minute = Number(twelve[2] ?? 0)
      if (hour < 1 || hour > 12 || minute > 59) return undefined
      return minToHHMM(((hour % 12) + (twelve[3] === "pm" ? 12 : 0)) * 60 + minute)
    }
    const full = TIME_24H.exec(lower)
    if (full) {
      const hour = Number(full[1])
      const minute = Number(full[2])
      if (hour > 23 || minute > 59) return undefined
      return minToHHMM(hour * 60 + minute)
    }
    return undefined
  }

  const looksLikeToken = (word: string): boolean => {
    const lower = word.toLowerCase()
    return /^[#@!]/.test(word) || lower === words.today || lower === words.tomorrow ||
      lower === words.in || lower === words.at || words.weekdays.includes(lower) ||
      ISO_DATE.test(lower) || timeOf(lower) !== undefined
  }

  for (let i = 0; i < tokens.length; i++) {
    const { text } = tokens[i]

    if (text.startsWith("\\") && looksLikeToken(text.slice(1))) {
      title.push(text.slice(1))
      continue
    }

    const tag = TAG.exec(text)
    if (tag) {
      if (!seenTags.has(tag[1].toLowerCase())) {
        seenTags.add(tag[1].toLowerCase())
        tags.push(tag[1])
      }
      span(QuickAddSpanKind.Tag, i, i)
      continue
    }

    const context = CONTEXT.exec(text)
    if (context) {
      if (!seenContexts.has(context[1].toLowerCase())) {
        seenContexts.add(context[1].toLowerCase())
        contexts.push(context[1])
      }
      span(QuickAddSpanKind.Context, i, i)
      continue
    }

    const level = priority === undefined ? PRIORITY.exec(text)?.[1].toLowerCase() : undefined
    const parsed = level === words.high || level === "1"
      ? QuickAddPriority.High
      : level === words.medium || level === "2"
      ? QuickAddPriority.Medium
      : level === words.low || level === "3"
      ? QuickAddPriority.Low
      : undefined
    if (parsed !== undefined) {
      priority = parsed
      span(QuickAddSpanKind.Priority, i, i)
      continue
    }

    if (date === undefined) {
      const found = dateAt(i)
      if (found) {
        date = found.value
        span(QuickAddSpanKind.Date, i, i + found.length - 1)
        i += found.length - 1
        continue
      }
    }

    if (time === undefined) {
      const hasAt = text.toLowerCase() === words.at && i + 1 < tokens.length
      const value = timeOf(hasAt ? tokens[i + 1].text : text)
      if (value !== undefined) {
        time = value
        span(QuickAddSpanKind.Time, i, hasAt ? i + 1 : i)
        if (hasAt) i++
        continue
      }
    }

    title.push(text)
  }

  const result: QuickAddResult = { title: title.join(" "), tags, contexts, spans }
  if (priority !== undefined) result.priority = priority
  if (date !== undefined || time !== undefined) {
    result.due = { date: date ?? today }
    if (time !== undefined) result.due.time = time
  }
  return result
}
