# `@spy4x/time`

Time and calendar primitives with no application domain attached. IANA timezone math on `Intl`,
plus an RFC 5545 iCalendar writer and a lossless iCalendar editor. Zero runtime dependencies.

## Install

```bash
deno add jsr:@spy4x/time
```

Runs on: shared — both the server and a browser bundle. Its sources use no `Deno.*` API.

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/time/date`](date.ts): Calendar arithmetic on plain `YYYY-MM-DD` dates — no zone, no clock, no locale.
- [`@spy4x/time/locale`](locale.ts): Calendar labels and week layout for a locale, read from `Intl` alone.
- [`@spy4x/time/tz`](tz.ts): IANA timezone math on `Intl` — the platform's own tzdata, zero dependencies.
- [`@spy4x/time/period`](period.ts): Calendar weeks and months as inclusive `YYYY-MM-DD` ranges, cut in a time zone.
- [`@spy4x/time/format`](format.ts): One set of formatters for a person's settings.
- [`@spy4x/time/ics`](ics.ts): RFC 5545 VCALENDAR/VEVENT writer.
- [`@spy4x/time/ics-core`](ics-core.ts): RFC 5545 iCalendar wire primitives.
- [`@spy4x/time/ical`](ical.ts): A lossless iCalendar (RFC 5545) document model.
- [`@spy4x/time/rrule`](rrule.ts): Repeat rules (RFC 5545 `RRULE`) for the subset Tasks.org writes, with a typed refusal for everything else.
- [`@spy4x/time/rrule-words/ar`](rrule-words/ar.ts): The words of `describeRrule` in ar, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/de`](rrule-words/de.ts): The words of `describeRrule` in de, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/en`](rrule-words/en.ts): The words of `describeRrule` in English, the source every translation is checked against.
- [`@spy4x/time/rrule-words/es`](rrule-words/es.ts): The words of `describeRrule` in es, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/fr`](rrule-words/fr.ts): The words of `describeRrule` in fr, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/ja`](rrule-words/ja.ts): The words of `describeRrule` in ja, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/pt-BR`](rrule-words/pt-BR.ts): The words of `describeRrule` in pt-BR, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/ru`](rrule-words/ru.ts): The words of `describeRrule` in ru, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/rrule-words/zh-CN`](rrule-words/zh-CN.ts): The words of `describeRrule` in zh-CN, translated from `./en.ts`, which explains every key.
- [`@spy4x/time/cron`](cron.ts): Cron schedules in UTC.
- [`@spy4x/time/ical-tasks`](ical-tasks.ts): Tasks (VTODO) and events (VEVENT) on top of the lossless iCalendar model in `./ical.ts`.
- [`@spy4x/time/ical-tasks-model`](ical-tasks-model.ts): The task a screen shows, read out of one CalDAV resource.
- [`@spy4x/time/ical-tasks-edit`](ical-tasks-edit.ts): Writes a task back to CalDAV.
- [`@spy4x/time/ical-tasks-reminders`](ical-tasks-reminders.ts): Which reminders of a task are due.
- [`@spy4x/time/ical-duration`](ical-duration-read.ts): Reading an iCalendar duration (`P1DT2H`) as another app writes it, and measuring it.
