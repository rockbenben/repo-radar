import { describe, expect, it, vi } from "vitest"
import type { Config } from "../src/config"
import { DEFAULT_CONFIG } from "../src/config"
import type { RepoCore, RepoHeavy, RepoHeavyResult } from "../src/git"

// 全量扫描是逐仓库增量读的：仓库扫完之后、整轮收尾之前，用户可能已经 commit，
// refreshOne（文件监听触发）拿到的才是新状态。收尾若用本轮快照整份覆盖，看板会凭空
// 「回退」到旧状态且没有补救事件。这组测试用可控的 getRepoCore 确定性地复现该交错——
// 真实 git 仓库做不到在「已读取」和「收尾」之间稳定插入一次变更。
// 挂钩点从 getRepoStatus 换成 getRepoCore：store.ts 改造后先调 core 再决定要不要调 heavy，
// mock core 就足以控制 dirty 计数、且能复现「core 挂起」的交错时机；heavy 给个恒定值即可。
const gitMock = vi.hoisted(() => ({
  getRepoCore: vi.fn<(path: string) => Promise<RepoCore>>(),
  getRepoHeavy: vi.fn<(path: string, core: Pick<RepoCore, "branch" | "oid">) => Promise<RepoHeavyResult>>(),
}))
vi.mock("../src/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/git")>()),
  getRepoCore: gitMock.getRepoCore,
  getRepoHeavy: gitMock.getRepoHeavy,
}))
// REPO 是假路径（"/fake/r1"），磁盘上真不存在——refreshRepo 新加的存在性检查会在
// 走到 mock 的 getRepoCore 之前就抛错，把这组测试全部依赖的交错时机破坏掉。
// 这里只关心 core/heavy 的交错，存在性检查不是这组测试的对象，恒真即可
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}))

import { repoId } from "../src/git"
import { RepoStore } from "../src/store"

const REPO = "/fake/r1"
const R1 = repoId(REPO) // store.ts 现在显式传 repoId(p)，不再由 getRepoStatus 内部代算

const makeCore = (unstaged: number): RepoCore => ({
  branch: "main",
  dirty: { staged: 0, unstaged, untracked: 0, conflicted: 0 },
  ahead: 0,
  behind: 0,
  oid: null,
})
const HEAVY: RepoHeavy = {
  stashCount: 0,
  stashOldest: null,
  release: null,
  remotes: [],
  lastCommit: null,
  mergedBranches: [],
}
gitMock.getRepoHeavy.mockResolvedValue({ heavy: HEAVY, degraded: false }) // 全文件恒定；这组测试只关心 core 带来的 dirty 计数

const cfg = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), manualRepos: [REPO] })

describe("RepoStore：全量扫描与 refreshOne 交错", () => {
  it("扫描中途被 refreshOne 刷过的仓库，收尾时不被本轮旧快照覆盖", async () => {
    const store = new RepoStore(cfg)
    // 第一轮：正常入库（脏 1 处）
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(1))
    await store.refreshAll()
    expect(store.get(R1)?.dirty.unstaged).toBe(1)

    // 第二轮：扫描读到的是「脏」（用户 commit 之前的状态），挂起等我们放行
    let releaseScan!: (c: RepoCore) => void
    gitMock.getRepoCore.mockImplementationOnce(() => new Promise((r) => (releaseScan = r)))
    const round = store.refreshAll()

    // 扫描进行中，用户 commit 了 → 文件监听触发 refreshOne，读到「干净」
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(0))
    await store.refreshOne(R1)
    expect(store.get(R1)?.dirty.unstaged).toBe(0)

    // 扫描这时才拿到它开头读的旧状态并收尾——不能把「干净」打回「脏」
    releaseScan(makeCore(1))
    await round
    expect(store.get(R1)?.dirty.unstaged).toBe(0)
  })

  // decorate 用的 config 是扫描开跑时读的快照。用户在扫描进行中打 ⭐ / 加标签（redecorate
  // 已广播新状态），收尾若按旧快照整份装回去，星标会当着用户的面消失，且要错到下一轮
  // redecorate 或兜底重扫（默认 30 分钟）才恢复
  it("扫描期间改的收藏/标签在收尾时不被开跑时的配置快照打回", async () => {
    const liveCfg = cfg() // 可变引用：模拟扫描期间配置被 PATCH
    const store = new RepoStore(() => structuredClone(liveCfg))
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(0))
    await store.refreshAll()
    expect(store.get(R1)?.favorite).toBe(false)

    // 第二轮：git 读挂起；扫描进行中用户把 r1 收藏了
    let releaseScan!: (c: RepoCore) => void
    gitMock.getRepoCore.mockImplementationOnce(() => new Promise((r) => (releaseScan = r)))
    const round = store.refreshAll()
    liveCfg.favorites = [R1]
    store.redecorate(R1)
    expect(store.get(R1)?.favorite).toBe(true)

    releaseScan(makeCore(0))
    await round
    expect(store.get(R1)?.favorite).toBe(true) // 收尾用的是「现在」的配置，星标还在
  })

  it("交错记录只在本轮内生效：下一轮全量扫描照常以扫描结果为准", async () => {
    const store = new RepoStore(cfg)
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(1))
    await store.refreshAll()

    // 一轮带交错的扫描（同上）
    let releaseScan!: (c: RepoCore) => void
    gitMock.getRepoCore.mockImplementationOnce(() => new Promise((r) => (releaseScan = r)))
    const round = store.refreshAll()
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(0))
    await store.refreshOne(R1)
    releaseScan(makeCore(1))
    await round

    // 下一轮没有 refreshOne 交错：扫描结果（脏 2 处）就是最终状态，
    // 上一轮的交错记录不能残留下来遮住它
    gitMock.getRepoCore.mockResolvedValueOnce(makeCore(2))
    await store.refreshAll()
    expect(store.get(R1)?.dirty.unstaged).toBe(2)
  })
})
