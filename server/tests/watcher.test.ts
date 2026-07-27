import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { RepoWatcher } from "../src/watcher"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")) }
    }, 100)
  })
}

describe("RepoWatcher", () => {
  it("fires once (debounced) for workdir changes and attributes the right repo", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 200, 2000)
    await watcher.watch([
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    await new Promise((r) => setTimeout(r, 300)) // chokidar ready 缓冲
    writeFileSync(join(repoA, "watched.txt"), "1")
    writeFileSync(join(repoA, "watched2.txt"), "2") // 与上一条合并进同一次防抖
    await waitFor(() => fired.length > 0)
    expect(fired).toEqual(["A"])
    await watcher.close()
  })

  it("fires for git ref changes (commit)", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 200, 2000)
    await watcher.watch([{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "c.txt"), "x")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "watched commit")
    await waitFor(() => fired.includes("R"))
    await watcher.close()
  })

  it("defers (not drops) changes arriving inside the cooldown window", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    // 防抖 100ms，冷却 1200ms —— 快速可测
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 1200)
    await watcher.watch([{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1) // 第一次正常触发
    await new Promise((r) => setTimeout(r, 400)) // 仍在冷却期内
    writeFileSync(join(repo, "second.txt"), "2") // 冷却期内的真实变更
    await new Promise((r) => setTimeout(r, 300))
    expect(fired.length).toBe(1) // 尚未触发（被延迟，而非丢弃）
    await waitFor(() => fired.length === 2, 3000) // 冷却结束后补触发
    expect(fired).toEqual(["R", "R"])
    await watcher.close()
  })

  // 兜底重扫每 30 分钟就会 applyWatch 一次，而 applyWatch 走的就是 watch()。若 watch() 像
  // 以前那样先整轮 close()，那些「已经收下、还没触发」的变更会连同定时器一起没掉——
  // 等于按重扫的节奏周期性吞事件，直接违背本类「任何真实变更都不会被丢弃」的承诺
  it("重建监听（同一批仓库）不丢弃已经收下、还没触发的变更", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 1500)
    const list = [{ id: "R", path: repo }]
    await watcher.watch(list)
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1) // 触发一次，进入冷却
    writeFileSync(join(repo, "second.txt"), "2") // 冷却期内的真实变更 → 挂上补票定时器
    await new Promise((r) => setTimeout(r, 200))
    expect(fired.length).toBe(1) // 还没补触发

    await watcher.watch(list) // 兜底重扫在这一刻重建监听
    await waitFor(() => fired.length === 2, 4000) // 补票定时器活下来了，变更没丢
    await watcher.close()
  })

  it("重建监听时丢掉已经不在列表里的仓库的定时器", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 1500)
    await watcher.watch([
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repoA, "first.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repoA, "second.txt"), "2") // A 挂上补票定时器
    await new Promise((r) => setTimeout(r, 200))

    await watcher.watch([{ id: "B", path: repoB }]) // A 被删除/排除，不再监听
    await new Promise((r) => setTimeout(r, 2200)) // 超过冷却窗口
    expect(fired).toEqual(["A"]) // A 的补票没有触发——它已经不在监听范围内了
    await watcher.close()
  })

  // watch()/close() 内部有 await 点：不串行化的话，定时重扫的 watch() 与 PUT /api/config
  // 触发的重装交错时，后者会把前者刚创建的 chokidar 实例引用置 null 而不关闭——孤儿实例
  // 永远在发事件（关了自动扫描看板还在刷新），句柄攒到 EMFILE
  it("并发的 watch() 与 close() 串行执行，不留下孤儿监听实例", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 2000)
    // 同时发起两个 watch 和一个 close，全都不 await —— close 排在最后，赢家必须是它
    const p1 = watcher.watch([{ id: "R", path: repo }])
    const p2 = watcher.watch([{ id: "R", path: repo }])
    const p3 = watcher.close()
    await Promise.all([p1, p2, p3])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "after-close.txt"), "x")
    await new Promise((r) => setTimeout(r, 600))
    expect(fired).toEqual([]) // 关掉之后没有任何实例还在监听
  })

  it("close() 是彻底停止：待触发的变更一并丢弃（用户关掉自动扫描 / 进程退出）", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 1500)
    await watcher.watch([{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repo, "second.txt"), "2")
    await new Promise((r) => setTimeout(r, 200))

    await watcher.close()
    await new Promise((r) => setTimeout(r, 2200)) // 超过冷却窗口
    expect(fired).toEqual(["R"]) // 关掉之后不该再有刷新
  })

  it("defers a change arriving immediately after a fire, never dropping it", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), 100, 800)
    await watcher.watch([{ id: "E", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "a.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repo, "b.txt"), "2") // 紧跟在触发之后——旧的 echo 窗口会丢弃它
    await new Promise((r) => setTimeout(r, 200))
    expect(fired.length).toBe(1) // 仍在冷却期，尚未补触发
    await waitFor(() => fired.length === 2, 3000) // 冷却结束后补触发——没有被丢弃
    await watcher.close()
  })
})
