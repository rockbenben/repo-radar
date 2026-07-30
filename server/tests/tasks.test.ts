import { afterAll, describe, expect, it } from "vitest"
import { getRepoStatus } from "../src/git"
import { drainRepoLocks } from "../src/queue"
import { startBatch, startExec, type BatchDeps } from "../src/tasks"
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

  // 退出排空必须等到整批结束。批量在「跑完一个仓库的 git、放锁、还没取下一把锁」之间有一段
  // 空窗（refreshOne 那几百毫秒），逐次 withRepoLock 的计数会在这里归零——drainRepoLocks
  // 当场答「已排空」，退出流程一步不停地走完，而批量随即又给下一个仓库起 git，被硬切在中途
  // 就留下 index.lock，且连「强制退出」那行日志都不会打。这里就在那段空窗里问它一次。
  it("keeps the exit drain waiting until the whole batch ends", async () => {
    const repo = await getRepoStatus(makeRepoWithUpstream())
    const map = new Map([[repo.id, repo]])
    let finish!: () => void
    const done = new Promise<void>((r) => { finish = r })
    let batchFinished = false
    let sampled = false
    let verdict: { drained: boolean; finishedWhenDrainReturned: boolean } | null = null
    const deps: BatchDeps = {
      getRepo: (id) => map.get(id),
      refreshOne: async (id) => {
        // 此刻锁已放掉、下一把还没取——退出排空在这一刻会怎么答？（不 await，否则把批量堵死）
        if (!sampled) {
          sampled = true
          void drainRepoLocks(5000).then((drained) => {
            verdict = { drained, finishedWhenDrainReturned: batchFinished }
          })
        }
        await new Promise((r) => setTimeout(r, 50))
        return map.get(id)
      },
      broadcast: (type, payload) => {
        if (type !== "batch:progress") return
        const p = payload as BatchProgress
        if (p.finished) { batchFinished = true; finish() }
      },
    }
    startBatch("fetch", [repo.id], deps)
    await done
    await new Promise((r) => setTimeout(r, 20)) // 让 drain 的续体跑完
    expect(verdict).toEqual({ drained: true, finishedWhenDrainReturned: true })
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

/**
 * startExec 里的 refreshOne 原先落在 try **之外**（同一句在 startBatch 里是在 try 内的）。
 * 它一抛，这个 worker 就 reject，而 mapLimit 内部是 `Promise.all(workers)`——一个 worker
 * reject 会让它立刻整体 reject，收尾的 `.then(_, () => progress(null, true))` 于是在**其余
 * worker 还在跑**的时候就广播 finished:true：前端当场收摊，后面跑完的那些仓库的输出再也不
 * 显示，而命令其实还在一个个执行（批量执行正是最需要看全每仓库输出的功能）。
 * refreshOne 会抛不是假想：loadConfig 现在对非 ENOENT 的读失败原样抛出（见 config.ts）。
 */
describe("startExec 的收尾", () => {
  it("某个仓库的 refreshOne 抛出时，finished 仍然是最后一个事件（不抢在其余仓库前面收摊）", async () => {
    const [fast, slow] = await Promise.all([getRepoStatus(makeRepo()), getRepoStatus(makeRepo())])
    const events: BatchProgress[] = []
    const deps: BatchDeps = {
      getRepo: (id) => (id === fast.id ? fast : slow),
      refreshOne: async (id) => {
        if (id === fast.id) throw new Error("config.json 读不出来") // 先跑完的那个：刷新抛错
        await new Promise((r) => setTimeout(r, 150)) // 另一个还在刷新，批量远没结束
        return slow
      },
      broadcast: (type, payload) => {
        if (type === "batch:progress") events.push(payload as BatchProgress)
      },
    }

    startExec("git --version", [fast.id, slow.id], deps, false)
    await new Promise((r) => setTimeout(r, 800)) // 等所有 worker 都真的跑完

    const finishedAt = events.findIndex((e) => e.finished)
    expect(finishedAt).toBe(events.length - 1) // 提前收摊的话，后面还跟着那个慢仓库的进度事件
    expect(events[finishedAt].results).toHaveLength(2) // 两个仓库的输出都在最终结果里
  })
})
