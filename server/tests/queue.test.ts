import { describe, expect, it } from "vitest"
import { drainRepoLocks, pendingRepoOps, withRepoLock } from "../src/queue"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("withRepoLock", () => {
  it("serializes ops on the same repo", async () => {
    const order: number[] = []
    const p1 = withRepoLock("a", async () => { await sleep(30); order.push(1) })
    const p2 = withRepoLock("a", async () => { order.push(2) })
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it("runs different repos concurrently", async () => {
    const order: string[] = []
    const p1 = withRepoLock("a", async () => { await sleep(30); order.push("a") })
    const p2 = withRepoLock("b", async () => { order.push("b") })
    await Promise.all([p1, p2])
    expect(order).toEqual(["b", "a"])
  })

  it("keeps the chain alive after a failure", async () => {
    await expect(withRepoLock("c", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(withRepoLock("c", async () => "ok")).resolves.toBe("ok")
  })
})

// 退出时要等这些操作跑完：git 写操作被硬切会在 .git 里留下 index.lock
describe("drainRepoLocks — 退出前排空", () => {
  it("没有在跑的操作 → 立即返回 true", async () => {
    expect(pendingRepoOps()).toBe(0)
    await expect(drainRepoLocks(50)).resolves.toBe(true)
  })

  it("等到所有仓库的操作都结束（含排队中的后续操作）", async () => {
    const done: string[] = []
    void withRepoLock("d", async () => { await sleep(40); done.push("d1") })
    void withRepoLock("d", async () => { await sleep(20); done.push("d2") }) // 排在 d1 后面
    void withRepoLock("e", async () => { await sleep(30); done.push("e1") }) // 另一个仓库，并行
    expect(pendingRepoOps()).toBe(3)

    await expect(drainRepoLocks(2000)).resolves.toBe(true)
    expect(done).toEqual(["e1", "d1", "d2"]) // 全部跑完才返回
    expect(pendingRepoOps()).toBe(0)
  })

  it("失败的操作同样算「已结束」，不会把排空永久挂住", async () => {
    void withRepoLock("f", async () => { await sleep(10); throw new Error("boom") }).catch(() => {})
    await expect(drainRepoLocks(2000)).resolves.toBe(true)
  })

  it("超时返回 false（卡死的 git 子进程不能让退出永远等下去）", async () => {
    let release = () => {}
    const stuck = new Promise<void>((r) => (release = r))
    void withRepoLock("g", () => stuck)

    await expect(drainRepoLocks(60)).resolves.toBe(false)
    expect(pendingRepoOps()).toBe(1) // 还挂着，但退出流程已经放行

    release()
    await expect(drainRepoLocks(2000)).resolves.toBe(true)
  })
})
