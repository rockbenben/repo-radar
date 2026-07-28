import { afterAll, describe, expect, it } from "vitest"
import { getRepoStatus } from "../src/git"
import { startBatch, type BatchDeps } from "../src/tasks"
import type { BatchProgress, RepoStatus } from "../src/types"
import { cleanupFixtures, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

async function runBatchToEnd(action: "fetch" | "push", repos: RepoStatus[], extraIds: string[] = []) {
  const map = new Map(repos.map((r) => [r.id, r]))
  const events: BatchProgress[] = []
  let finish: () => void
  const done = new Promise<void>((r) => { finish = r })
  const deps: BatchDeps = {
    getRepo: (id) => map.get(id),
    refreshOne: async (id) => map.get(id),
    broadcast: (type, payload) => {
      if (type !== "batch:progress") return
      const p = payload as BatchProgress
      events.push(p)
      if (p.finished) finish()
    },
  }
  const taskId = startBatch(action, [...map.keys(), ...extraIds], deps)
  await done
  return { taskId, events }
}

describe("startBatch", () => {
  it("processes repos, reports progress and finishes", async () => {
    const repos = await Promise.all([makeRepoWithUpstream(), makeRepoWithUpstream()].map((path) => getRepoStatus(path)))
    const { taskId, events } = await runBatchToEnd("fetch", repos)
    expect(taskId).toMatch(/^batch-/)
    const last = events[events.length - 1]
    expect(last.finished).toBe(true)
    expect(last.done).toBe(2)
    expect(last.results.every((r) => r.ok)).toBe(true)
  })

  it("keeps going when one repo fails and reports it", async () => {
    const good = await getRepoStatus(makeRepoWithUpstream())
    const bad = await getRepoStatus(makeRepo()) // 无 remote，push 必败
    const { events } = await runBatchToEnd("push", [good, bad])
    const last = events[events.length - 1]
    expect(last.finished).toBe(true)
    expect(last.results.filter((r) => r.ok)).toHaveLength(1)
    expect(last.results.filter((r) => !r.ok)).toHaveLength(1)
  })

  it("reports unknown repo ids as failed results", async () => {
    const { events } = await runBatchToEnd("fetch", [], ["ghost"])
    const last = events[events.length - 1]
    expect(last.results[0]).toMatchObject({ repoId: "ghost", ok: false })
  })

  it("still finishes when refreshOne throws", async () => {
    const repo = await getRepoStatus(makeRepoWithUpstream())
    const events: BatchProgress[] = []
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    const deps: BatchDeps = {
      getRepo: () => repo,
      refreshOne: async () => { throw new Error("boom") },
      broadcast: (type, payload) => {
        if (type !== "batch:progress") return
        const p = payload as BatchProgress
        events.push(p)
        if (p.finished) finish()
      },
    }
    startBatch("fetch", [repo.id], deps)
    await done
    const last = events[events.length - 1]
    expect(last.finished).toBe(true)
    expect(last.results).toHaveLength(1)
  })
})
