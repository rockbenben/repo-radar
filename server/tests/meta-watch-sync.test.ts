import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createAutomation } from "../src/automation"
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../src/config"
import { createApi } from "../src/routes"
import { RepoStore } from "../src/store"
import type { WatchStrategy, WatchedRepo } from "../src/watch-strategy"
import { RepoWatcher } from "../src/watcher"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 不碰文件系统的监听策略：如实报出「非归档仓库的路径都挂上了」，与 RecursiveRootStrategy
 *  对 roots 之外的 manualRepos 各挂一个句柄的行为一致。用真实策略的话，覆盖数会随平台/时序
 *  变化，这组用例要观察的「事件有没有被丢弃」就被别的原因遮住了 */
const fakeStrategy = (): WatchStrategy => ({
  async start(roots: readonly string[], repos: readonly WatchedRepo[]) {
    return [...roots, ...repos.filter((r) => !r.archived).map((r) => r.path)]
  },
  async stop() {},
})

/**
 * 「排除 → 重扫 → 取消排除 → 改文件」这条跨步骤旅程。
 *
 * 每一步单看都对：PATCH meta 把 archived 落了盘、redecorate 也广播了新状态，卡片确实回到看板；
 * watcher 那边把归档仓库记进静音名单也是对的（不这么做，归档仓库的每一次保存都会被当成
 * 「目录结构变化」触发全量重扫）。错在两者之间没有连线——静音名单只在 indexRepos 里重算，
 * 而它的入口只有 setRoots / setRepos，全在全量重扫链上，PATCH meta 一个都碰不到。
 */
describe("PATCH /api/repos/:id/meta 与监听器的同步", () => {
  it("取消排除后，仓库的文件事件不再被 watcher 丢弃", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-metasync-"))
    dirs.push(dir)
    const configFile = join(dir, "config.json")
    const repoPath = makeRepo()
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), manualRepos: [repoPath] }
    saveConfig(configFile, cfg)

    const store = new RepoStore(() => loadConfig(configFile))
    const fired: string[] = []
    // debounce 10ms / cooldown 0：只关心事件有没有被丢弃，不关心合并窗口
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fakeStrategy())
    const automation = createAutomation({
      configFile,
      watcher,
      listRepos: () => store.list(),
      rescan: async () => {},
      fetchAll: async () => {},
    })
    const app = createApi(store, configFile, { syncRepos: () => automation.applyRepos(store.list()) })
    const patch = (id: string, body: unknown) =>
      app.request(`/api/repos/${id}/meta`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const touch = join(repoPath, "src", "a.ts")

    // ① 启动：扫描 + 建立监听
    await automation.applyWatch(true, await store.refreshAll())
    const id = store.list()[0].id
    watcher.handleEventForTest(touch)
    await sleep(40)
    expect(fired).toEqual([id]) // 前提：这个仓库本来是会刷新的

    // ② 点「排除」→ ③ 等一轮兜底重扫（applyRepos），watcher 把它记进静音名单（此时静音是对的）
    expect((await patch(id, { archived: true })).status).toBe(200)
    automation.applyRepos(await store.refreshAll())
    fired.length = 0
    watcher.handleEventForTest(touch)
    await sleep(40)
    expect(fired).toEqual([]) // 归档期间不刷新它，这一条是既有行为，不能被改掉
    expect(automation.coverage().total).toBe(0)

    // ④ 在「已排除」视图里取消排除 → ⑤ 在仓库里改文件
    expect((await patch(id, { archived: false })).status).toBe(200)
    watcher.handleEventForTest(touch)
    await sleep(40)
    // 不同步的话事件在 watcher 的静音判断处就地丢弃：卡片停在取消排除那一刻，
    // 默认要等下一轮兜底重扫（≤30 分钟），autoScanMinutes=0 时整个进程生命周期都不刷新
    expect(fired).toEqual([id])
    // 同一根因的次生症状：设置面板「监听 N / M」的分母同样只在这条链上重算
    expect(automation.coverage().total).toBe(1)

    await watcher.close()
  })

  it("只改标签/备注不惊动监听器（这条路径没有任何监听状态需要重算）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-metasync-"))
    dirs.push(dir)
    const configFile = join(dir, "config.json")
    const repoPath = makeRepo()
    saveConfig(configFile, { ...structuredClone(DEFAULT_CONFIG), manualRepos: [repoPath] })
    const store = new RepoStore(() => loadConfig(configFile))
    await store.refreshAll()
    const id = store.list()[0].id

    let syncs = 0
    const app = createApi(store, configFile, { syncRepos: () => void syncs++ })
    const patch = (body: unknown) =>
      app.request(`/api/repos/${id}/meta`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    await patch({ tags: ["wip"], note: "hi", group: "g" })
    expect(syncs).toBe(0)
    await patch({ archived: false }) // 原值 round-trip：没翻转就没什么要重算的
    expect(syncs).toBe(0)
    await patch({ favorite: true })
    expect(syncs).toBe(1)
  })
})
