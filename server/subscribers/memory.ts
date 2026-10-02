import type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"

export type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"

/**
 * A {@link SubscriberStore} held in this process, for tests and single-process prototypes. It holds
 * to the same contract as the file and Postgres stores and loses everything on restart. Every read
 * hands out copies, so a caller cannot change a stored row.
 */
export function createMemorySubscriberStore(): SubscriberStore {
  const rows = new Map<string, Subscriber>()
  /** Unsubscribe mark → when, in Unix milliseconds. */
  const marks = new Map<string, number>()
  const copy = (row: Subscriber): Subscriber => ({
    ...row,
    subscribedAt: new Date(row.subscribedAt),
  })

  return {
    list() {
      return Promise.resolve([...rows.values()].map(copy))
    },

    findByKey(key) {
      for (const row of rows.values()) {
        if (row.key === key) return Promise.resolve(copy(row))
      }
      return Promise.resolve(undefined)
    },

    add(input: AddSubscriberInput): Promise<AddSubscriberResult> {
      if (rows.has(input.email)) return Promise.resolve("known")
      const unsubscribedAt = marks.get(input.mark)
      if (unsubscribedAt !== undefined && unsubscribedAt >= input.issuedAt) {
        return Promise.resolve("replay")
      }
      rows.set(input.email, {
        email: input.email,
        key: input.key,
        subscribedAt: new Date(input.at),
      })
      return Promise.resolve("added")
    },

    remove(input: RemoveSubscriberInput) {
      const removed = rows.delete(input.email)
      const oldest = input.pruneBefore.getTime()
      for (const [mark, at] of marks) {
        if (at < oldest) marks.delete(mark)
      }
      marks.set(input.mark, input.at.getTime())
      return Promise.resolve(removed)
    },

    count() {
      return Promise.resolve(rows.size)
    },
  }
}
