import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { RepoCache } from "../src/repo-cache"
import { RepoStore } from "../src/store"
import { DEFAULT_CONFIG } from "../src/config"
import * as git from "../src/git"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
function cacheFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-sc-"))
  dirs.push(d)
  return join(d, "repo-cache.json")
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
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
  })

  it("仓库动过之后重新调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    // manualRepos 而非 roots：makeRepo() 直接建在 OS 共享临时目录下，若按 dirname(repo)
    // 当 root 扫描，会把同一测试进程里其它并发用例正在建的 fixture 一并扫进来——
    // 全量套件并行跑时 getRepoHeavy 调用次数因此不确定，manualRepos 精确点名这一个仓库
    const cfg = { ...DEFAULT_CONFIG, manualRepos: [repo] }
    const store = new RepoStore(() => cfg, undefined, undefined, new RepoCache(cacheFile()))
    await store.refreshAll()

    const spy = vi.spyOn(git, "getRepoHeavy")
    writeFileSync(join(repo, "x.txt"), "x")
    const { execFileSync } = await import("node:child_process")
    execFileSync("git", ["add", "-A"], { cwd: repo })
    execFileSync("git", ["commit", "-m", "c"], { cwd: repo })

    await store.refreshAll()
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    spy.mockRestore()
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
