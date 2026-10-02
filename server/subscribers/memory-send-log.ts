import type { SendLog, SendLogEntry } from "./send-log.ts"

/**
 * A {@link SendLog} held in this process, for tests and single-process prototypes. It holds to the
 * same contract as the file log and loses everything on restart. Every read hands out copies, so a
 * caller cannot change a stored entry.
 */
export function createMemorySendLog(): SendLog {
  const entries = new Map<string, SendLogEntry>()
  const locked = new Set<string>()
  const copy = (entry: SendLogEntry): SendLogEntry => ({
    ...entry,
    startedAt: new Date(entry.startedAt),
    ...(entry.audience && { audience: [...entry.audience] }),
    ...(entry.recipients && { recipients: [...entry.recipients] }),
    ...(entry.completedAt && { completedAt: new Date(entry.completedAt) }),
  })
  const stored = (issue: string): SendLogEntry => {
    const entry = entries.get(issue)
    if (entry === undefined) throw new Error(`send log: issue ${issue} was never started`)
    return entry
  }

  return {
    lock(issue) {
      if (locked.has(issue)) return Promise.resolve(undefined)
      locked.add(issue)
      let held = true
      return Promise.resolve({
        release() {
          if (held) locked.delete(issue)
          held = false
          return Promise.resolve()
        },
      })
    },

    find(issue) {
      const entry = entries.get(issue)
      return Promise.resolve(entry && copy(entry))
    },

    start({ issue, subject, audience, at }) {
      let entry = entries.get(issue)
      if (entry === undefined) {
        entry = {
          issue,
          subject,
          startedAt: new Date(at),
          audience: [...audience],
          recipients: [],
        }
        entries.set(issue, entry)
      } else if (entry.recipients !== undefined && entry.audience === undefined) {
        entry.audience = [...audience]
      }
      return Promise.resolve(copy(entry))
    },

    // `async`, so a never-started issue rejects like the other adapters instead of throwing.
    // deno-lint-ignore require-await
    async record(issue, mark) {
      const entry = stored(issue)
      const recipients = entry.recipients ??= []
      if (!recipients.includes(mark)) recipients.push(mark)
    },

    // deno-lint-ignore require-await
    async finish({ issue, failed, at }) {
      const entry = stored(issue)
      entry.sent = entry.recipients?.length ?? 0
      entry.failed = failed
      if (failed === 0) entry.completedAt = new Date(at)
    },
  }
}
