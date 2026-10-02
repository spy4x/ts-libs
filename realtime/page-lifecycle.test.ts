import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { type PageLifecycleTarget, watchPageResume } from "./page-lifecycle.ts"

function createPage() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const add = (type: string, listener: (event: Event) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(listener)
  }
  const remove = (type: string, listener: (event: Event) => void) => {
    listeners.get(type)?.delete(listener)
  }
  const page = {
    visibilityState: "visible",
    fire(type: string, init: { persisted?: boolean } = {}) {
      const event = Object.assign(new Event(type), init)
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    target: {
      document: {
        get visibilityState() {
          return page.visibilityState
        },
        addEventListener: add,
        removeEventListener: remove,
      },
      addEventListener: add,
      removeEventListener: remove,
    } as PageLifecycleTarget,
  }
  return page
}

describe("watchPageResume", () => {
  it("resumes when the page becomes visible, not when it becomes hidden", () => {
    const page = createPage()
    let resumes = 0
    watchPageResume(() => resumes++, page.target)

    page.visibilityState = "hidden"
    page.fire("visibilitychange")
    expect(resumes).toBe(0)

    page.visibilityState = "visible"
    page.fire("visibilitychange")
    expect(resumes).toBe(1)
  })

  it("resumes when the browser comes back online", () => {
    const page = createPage()
    let resumes = 0
    watchPageResume(() => resumes++, page.target)

    page.fire("online")

    expect(resumes).toBe(1)
  })

  it("resumes for a page restored from the back-forward cache, not for a fresh load", () => {
    const page = createPage()
    let resumes = 0
    watchPageResume(() => resumes++, page.target)

    page.fire("pageshow", { persisted: false })
    expect(resumes).toBe(0)

    page.fire("pageshow", { persisted: true })
    expect(resumes).toBe(1)
  })

  it("stops listening once the returned function is called", () => {
    const page = createPage()
    let resumes = 0
    const stop = watchPageResume(() => resumes++, page.target)

    stop()
    page.fire("online")
    page.fire("visibilitychange")

    expect(resumes).toBe(0)
    expect(page.count()).toBe(0)
  })
})
