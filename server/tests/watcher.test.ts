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
