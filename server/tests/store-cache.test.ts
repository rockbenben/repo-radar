import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { RepoCache } from "../src/repo-cache"
import { RepoStore } from "../src/store"
import { DEFAULT_CONFIG } from "../src/config"
import * as git from "../src/git"
import { gitFingerprint } from "../src/fingerprint"
// git as gitCmd：本文件已经用 `import * as git` 拿了被测模块的命名空间，同名会盖掉它
import { cleanupFixtures, git as gitCmd, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
function cacheFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-sc-"))
  dirs.push(d)
  return join(d, "repo-cache.json")
}
afterAll(() => {
  // maxRetries: 3——与套件里其余「异步/防抖写盘 + force:true 清理」的文件一致（desc-cache.test.ts、
  // inbox-cache.test.ts、store.test.ts 等 20+ 处）：并发 I/O 下 rmSync 偶发因文件正被写入而失败，
  // 重试几次就过去了，不加则在负载高时表现为 EPERM
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("RepoStore 指纹缓存", () => {
  it("第二轮重扫在仓库没动时不再调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    // manualRepos 而非 roots：makeRepo() 直接建在 OS 共享临时目录下，若按 dirname(repo)
    // 当 root 扫描，会把同一测试进程里其它并发用例正在建的 fixture 一并扫进来——
    // 全量套件并行跑时 getRepoHeavy 调用次数因此不确定，manualRepos 精确点名这一个仓库
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const cache = new RepoCache(cacheFile())
    const spy = vi.spyOn(git, "getRepoHeavy")

    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    await store.refreshAll()
    const afterFirst = spy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await store.refreshAll()
    expect(spy.mock.calls.length).toBe(afterFirst) // 一次都没再调用
    spy.mockRestore()
    cache.flush() // debounceMs 1000：refreshAll 内部的 cache.set() 是防抖写盘，不 flush 定时器会活过本文件的 afterAll
  })

  it("仓库动过之后重新调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    // manualRepos 而非 roots：makeRepo() 直接建在 OS 共享临时目录下，若按 dirname(repo)
    // 当 root 扫描，会把同一测试进程里其它并发用例正在建的 fixture 一并扫进来——
    // 全量套件并行跑时 getRepoHeavy 调用次数因此不确定，manualRepos 精确点名这一个仓库
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const cache = new RepoCache(cacheFile())
    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    await store.refreshAll()

    const spy = vi.spyOn(git, "getRepoHeavy")
    writeFileSync(join(repo, "x.txt"), "x")
    const { execFileSync } = await import("node:child_process")
    execFileSync("git", ["add", "-A"], { cwd: repo })
    execFileSync("git", ["commit", "-m", "c"], { cwd: repo })

    await store.refreshAll()
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    spy.mockRestore()
    cache.flush() // 同上：refreshAll 两轮各触发一次 cache.set()，防抖定时器不 flush 会活过 afterAll
  })

  // 缓存命中时看板上的字段必须与全价刷新完全一致，否则缓存就是在制造错误数据
  it("命中缓存的结果与全价刷新一致", async () => {
    const repo = makeRepo({ stash: true })
    // manualRepos 而非 roots：makeRepo() 直接建在 OS 共享临时目录下，若按 dirname(repo)
    // 当 root 扫描，会把同一测试进程里其它并发用例正在建的 fixture 一并扫进来——
    // 全量套件并行跑时 getRepoHeavy 调用次数因此不确定，manualRepos 精确点名这一个仓库
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const cache = new RepoCache(cacheFile())
    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    const first = (await store.refreshAll())[0]
    const second = (await store.refreshAll())[0]
    expect({ ...second, scannedAt: "" }).toEqual({ ...first, scannedAt: "" })
    cache.flush() // 同上
  })

  // 「应用自己写完之后立刻读到旧数据」——C1 里最严重的那个后果，端到端钉住。
  // 探针少了 refs/heads 时这条会红：git 真的删了分支，refreshOne 却命中缓存、
  // 把那几个已经不存在的分支原样返回并广播出去
  it("git branch -d 之后 refreshOne 立刻反映出分支已删（C1 回归）", async () => {
    const repo = makeRepo()
    gitCmd(repo, "branch", "feature-done")
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const cache = new RepoCache(cacheFile())
    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    const first = (await store.refreshAll())[0] // 预热缓存
    expect(first.mergedBranches).toEqual(["feature-done"])

    gitCmd(repo, "branch", "-d", "feature-done")
    const after = await store.refreshOne(first.id)
    expect(after?.mergedBranches).toEqual([])
    cache.flush()
  })

  // 探针集合永远不可能证明完备，skipCache 是关掉整类问题的那道闸。
  // 这里直接把缓存投毒成「指纹不变但内容过期」——精确模拟「探针漏判」这个条件本身，
  // 而不是依赖某一个具体的漏判操作（那些一旦补上探针就不再是漏判了，测试也就失去意义）
  it("skipCache 绕开缓存：指纹没变也重算（探针漏判时的兜底）", async () => {
    const repo = makeRepo()
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const cache = new RepoCache(cacheFile())
    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    const first = (await store.refreshAll())[0]
    expect(first.stashCount).toBe(0)

    const core = await git.getRepoCore(repo)
    const fp = gitFingerprint(repo, core.oid)
    expect(fp).not.toBeNull()
    const real = await git.getRepoHeavy(repo, core.branch)
    cache.set(first.id, fp!, { ...real, stashCount: 99 }) // 指纹保持当前值，内容故意作废

    expect((await store.refreshOne(first.id))?.stashCount).toBe(99) // 命中投毒：证明缓存确实生效
    expect((await store.refreshOne(first.id, { skipCache: true }))?.stashCount).toBe(0) // 绕开它
    cache.flush()
  })

  // 不传 cache 时必须完全退化成改造前的行为（每轮都全价刷新）
  it("未提供缓存时每轮都调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    // manualRepos 而非 roots：makeRepo() 直接建在 OS 共享临时目录下，若按 dirname(repo)
    // 当 root 扫描，会把同一测试进程里其它并发用例正在建的 fixture 一并扫进来——
    // 全量套件并行跑时 getRepoHeavy 调用次数因此不确定，manualRepos 精确点名这一个仓库
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const spy = vi.spyOn(git, "getRepoHeavy")
    await store.refreshAll()
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})
