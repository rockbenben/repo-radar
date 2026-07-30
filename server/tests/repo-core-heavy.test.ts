import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { composeStatus, getRepoCore, getRepoHeavy, getRepoStatus, repoId } from "../src/git"
import { cleanupFixtures, git, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

describe("getRepoCore", () => {
  it("给出分支、脏计数与 oid", async () => {
    const repo = makeRepo({ dirty: true })
    const core = await getRepoCore(repo)
    expect(core.branch).toBe("main")
    expect(core.dirty.untracked).toBe(1)
    expect(core.oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it("有 upstream 时给出 ahead/behind", async () => {
    const core = await getRepoCore(makeRepoWithUpstream())
    expect(core.ahead).toBe(1)
    expect(core.behind).toBe(0)
  })

  it("空仓库：oid 为 null，不抛", async () => {
    const core = await getRepoCore(makeRepo({ commits: 0 }))
    expect(core.oid).toBeNull()
  })
})

/** 有提交的普通仓库的 core 替身：只有 branch / oid 影响 heavy，别的字段 heavy 根本不看 */
const liveCore = (branch: string | null = "main") => ({ branch, oid: "0".repeat(40) })

describe("getRepoHeavy", () => {
  it("给出 stash / 最近提交", async () => {
    const repo = makeRepo({ stash: true })
    const { heavy } = await getRepoHeavy(repo, liveCore())
    expect(heavy.stashCount).toBe(1)
    expect(heavy.lastCommit?.message).toBe("c0")
  })

  // displayName / description / language 来自工作区（package.json / README / 根目录列表），
  // 而 heavy 是按一个完全由 .git 算出来的指纹缓存的。留在 heavy 里的话，改 package.json
  // 的 name——正是用户重命名项目的那一刻——卡片标题会冻结到某次无关的 git 操作为止
  it("工作区派生的字段不在 heavy 里（它们不可能被 .git 指纹感知）", async () => {
    const { heavy } = await getRepoHeavy(makeRepo(), liveCore())
    expect(heavy).not.toHaveProperty("displayName")
    expect(heavy).not.toHaveProperty("description")
    expect(heavy).not.toHaveProperty("language")
  })

  it("composeStatus 现算工作区字段：改 package.json 后无需任何 git 操作即刻生效", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core) // 只算一次，模拟「heavy 命中缓存」
    expect(composeStatus(repo, "id", core, heavy).displayName).toBeNull()

    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", description: "d" }))
    // 同一份 heavy 再拼一次——指纹一个字节都没变（package.json 不在 .git 下），
    // 而标题和描述必须已经跟上
    const after = composeStatus(repo, "id", core, heavy)
    expect(after.displayName).toBe("demo")
    expect(after.description).toBe("d")
  })

  it("mergedBranches 排除当前分支与主干", async () => {
    const repo = makeRepo()
    git(repo, "branch", "feature-done")
    const { heavy } = await getRepoHeavy(repo, liveCore())
    expect(heavy.mergedBranches).toEqual(["feature-done"])
  })

  // 不带 base 的 `git branch --merged` 判的是「已合并进 HEAD」。游离 HEAD 停在某条分支的尖端时
  // （从 git log 复制 sha 去 checkout 是最常见的入口），那条分支对 HEAD 恒成立、而 branch 为 null
  // 让「排除当前分支」的过滤恒真——它就会出现在「可清理分支」里。那是全应用唯一没有二次确认的
  // 破坏性按钮，点下去之后没有任何分支能到达那些提交（git fsck: unreachable commit）
  it("游离 HEAD 停在某条分支尖端时不把那条分支报成可清理", async () => {
    const repo = makeRepo()
    git(repo, "checkout", "-b", "feature")
    writeFileSync(join(repo, "f.txt"), "x")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "feature work")
    const sha = git(repo, "rev-parse", "HEAD").trim()
    git(repo, "checkout", "--detach", sha)
    const { heavy } = await getRepoHeavy(repo, await getRepoCore(repo))
    expect(heavy.mergedBranches).toEqual([])
  })

  // 站在 feature 上时「已合并进 HEAD」包括尚未并进主干的 develop——删掉它就只剩 reflog 能找回
  // 那个分支名。主干叫 dev/trunk（不是字面量 main/master）的仓库里，被报成可清理的就是主干本身
  it("站在 feature 分支上时不把尚未并进主干的分支报成可清理", async () => {
    const repo = makeRepo()
    git(repo, "checkout", "-b", "develop")
    writeFileSync(join(repo, "d.txt"), "d")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "develop work")
    git(repo, "checkout", "-b", "feature")
    const { heavy } = await getRepoHeavy(repo, await getRepoCore(repo))
    expect(heavy.mergedBranches).toEqual([])
  })

  // 另一个进入游离 HEAD 的入口：checkout 一个 tag。同样不给列表——游离时没有「相对谁安全」
  // 可言。（`git branch --merged` 此时还会多打一行伪条目 `(HEAD detached at v1)`；它对切换器
  // 的影响由 git-status.test.ts 那条用例守着，那里连名字带括号的**真**分支一起钉住了）
  it("游离 HEAD（checkout tag）时不给可清理分支列表", async () => {
    const repo = makeRepo()
    git(repo, "branch", "old-done")
    git(repo, "tag", "v1")
    git(repo, "checkout", "v1")
    const { heavy } = await getRepoHeavy(repo, liveCore(null))
    expect(heavy.mergedBranches).toEqual([])
  })

  it("从未打过 tag 时 release 为 null", async () => {
    expect((await getRepoHeavy(makeRepo(), liveCore())).heavy.release).toBeNull()
  })
})

/**
 * 降级标记的两个方向。这条边界做错会引入新 bug，且两边都很实在：
 *  · 真降级判成正当结果 → 一次瞬时的 git 失败被指纹缓存永久固化（H2 本体）；
 *  · 正当空结果判成降级 → 空仓库/无 tag 仓库**永远无法缓存**，每轮付全价。
 *
 * 失败注入用真实的 git 行为而不是 mock spawn：把某个 ref 指向一个不存在的对象，
 * 那条子命令会真的非零退出，而 `git status`（core）照常成功——正是生产上「某个子命令
 * 单独失败」的形状。
 */
describe("getRepoHeavy 的降级判定", () => {
  // (a) 正当空结果：这些仓库天天都是这个样子，绝不能因此每轮全价
  it("无 stash / 无 tag / 无远程的普通仓库不算降级", async () => {
    const { heavy, degraded } = await getRepoHeavy(makeRepo(), liveCore())
    expect(degraded).toBe(false)
    expect(heavy.stashCount).toBe(0)
    expect(heavy.release).toBeNull()
    expect(heavy.remotes).toEqual([])
  })

  // (a) 空仓库上 `git log -1` 与 `git branch --merged` 都非零退出（实测 git 2.48 分别报
  // 「does not have any commits yet」「malformed object name HEAD」），但那是
  // 「还没有提交」这个**正确答案**。判成降级的话每个空仓库都永远缓存不上
  it("空仓库（无 HEAD）上 log/branch 非零退出属于正当空结果，不算降级", async () => {
    const repo = makeRepo({ commits: 0 })
    const core = await getRepoCore(repo)
    expect(core.oid).toBeNull() // 判据本身：branch.oid 是 (initial)
    const { heavy, degraded } = await getRepoHeavy(repo, core)
    expect(degraded).toBe(false)
    expect(heavy.lastCommit).toBeNull()
    expect(heavy.mergedBranches).toEqual([])
  })

  // (b) 真降级：stash 那条子命令单独失败。改造前它与「这个仓库没有 stash」在返回值里
  // 长得一模一样，于是 count:0 被连同当前指纹写进 repo-cache.json 永久固化
  it("stash 子命令真失败时标记降级", async () => {
    const repo = makeRepo()
    // refs/stash 指向一个不存在的对象：`git stash list` 报 fatal: bad object，status 照常成功
    mkdirSync(join(repo, ".git", "refs"), { recursive: true })
    writeFileSync(join(repo, ".git", "refs", "stash"), `${"de".repeat(20)}\n`)
    const { heavy, degraded } = await getRepoHeavy(repo, liveCore())
    expect(degraded).toBe(true)
    expect(heavy.stashCount).toBe(0) // 值照常返回给本轮用，只是不该被固化
  })

  // (b) 真降级：for-each-ref 列不出 tag。与「从未打过 tag」（0 退出 + 空输出）必须分开——
  // 上面那条正当用例钉的正是后者
  it("for-each-ref 真失败时标记降级（与「从未打过 tag」区分开）", async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, ".git", "refs", "tags"), { recursive: true })
    writeFileSync(join(repo, ".git", "refs", "tags", "bad"), `${"de".repeat(20)}\n`)
    const { heavy, degraded } = await getRepoHeavy(repo, liveCore())
    expect(degraded).toBe(true)
    expect(heavy.release).toBeNull()
  })
})

// 拆分不得改变对外结果：这是本任务唯一真正重要的断言
describe("composeStatus 与 getRepoStatus 等价", () => {
  it("手工组合的结果与 getRepoStatus 一致", async () => {
    const repo = makeRepo({ dirty: true, stash: true })
    const viaStatus = await getRepoStatus(repo)
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const composed = composeStatus(repo, repoId(repo), core, heavy)
    // scannedAt 是各自的当前时刻，比对前对齐
    expect({ ...composed, scannedAt: "" }).toEqual({ ...viaStatus, scannedAt: "" })
  })

  it("getRepoStatus 可以接受外部传入的 id", async () => {
    const repo = makeRepo()
    expect((await getRepoStatus(repo, "forced-id")).id).toBe("forced-id")
  })
})
