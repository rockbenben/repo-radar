import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { composeStatus, getRepoCore, getRepoHeavy, getRepoStatus, repoId, worktreeTouchedAt } from "../src/git"
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

describe("workedAt：最近活跃看的是「修改」而不是「提交」", () => {
  it("干净仓库为 null——工作区与 HEAD 一致时，最后一次修改就是那次提交，交给 lastCommit", async () => {
    expect((await getRepoCore(makeRepo())).workedAt).toBeNull()
  })

  it("有未提交改动时取那些文件的 mtime", async () => {
    const repo = makeRepo({ dirty: true })
    const workedAt = (await getRepoCore(repo)).workedAt
    expect(workedAt).not.toBeNull()
    expect(Math.abs(Date.now() - new Date(workedAt!).getTime())).toBeLessThan(60_000)
  })

  it("含空格与中文的文件名照样能 stat 到（靠 core.quotePath=false）", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "中文 文件.txt"), "x")
    // 不带 QUOTE_PATH_OFF 的话这里是 `"\344\270\255…"`，join 出来的路径不存在，stat 静默失败
    expect((await getRepoCore(repo)).workedAt).not.toBeNull()
  })

  it("未跟踪的 node_modules 不算修改——没写 .gitignore 的仓库不该因为一次构建就跳到最前", async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, "node_modules"), { recursive: true })
    writeFileSync(join(repo, "node_modules", "pkg.js"), "x")
    const core = await getRepoCore(repo)
    expect(core.dirty.untracked).toBe(1) // git 确实报了它（没有 .gitignore，它只是未跟踪）
    expect(core.workedAt).toBeNull() // 但它不构成「我动过这个项目」
  })

  // 目录名过滤只能对**未跟踪**条目生效。本仓库自己就跟踪着 build/installer.nsh，Go 项目
  // 把 vendor/ 提交进仓库更是常规做法——一视同仁地滤，这些仓库会一边显示「1 处未提交改动」
  // 一边永远排在「三个月前提交过」的那批下面，而且不自愈：下一轮重扫算出同一个 null
  it("已跟踪的 build/ vendor/ bin/ 里的改动算修改", async () => {
    const repo = makeRepo()
    for (const dir of ["build", "vendor", "bin"]) {
      mkdirSync(join(repo, dir), { recursive: true })
      writeFileSync(join(repo, dir, "keep.txt"), "v1")
    }
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "track them")
    writeFileSync(join(repo, "build", "keep.txt"), "v2") // 改一个受版本控制的 build/ 文件
    const core = await getRepoCore(repo)
    expect(core.dirty.unstaged).toBe(1)
    expect(core.workedAt).not.toBeNull()
  })

  it("被 .gitignore 忽略的文件不算修改", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, ".gitignore"), "build.log\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "ignore")
    writeFileSync(join(repo, "build.log"), "noise")
    expect((await getRepoCore(repo)).workedAt).toBeNull()
  })

  it("composeStatus 的 lastActivity 取「工作区 mtime」与「最后提交」里晚的那个", async () => {
    const repo = makeRepo({ dirty: true })
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const status = composeStatus(repo, "id", core, heavy)
    // 提交在前、改文件在后，所以取的是工作区那一侧
    expect(status.lastActivity).toBe(core.workedAt)
    expect(new Date(status.lastActivity!).getTime()).toBeGreaterThanOrEqual(new Date(heavy.lastCommit!.date).getTime())
  })

  it("干净仓库的 lastActivity 回落到最后提交时间", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    expect(composeStatus(repo, "id", core, heavy).lastActivity).toBe(heavy.lastCommit!.date)
  })

  // 未来的提交时间比未来的 mtime 更毒：它躲在 .git 指纹缓存后面，仓库不动指纹就不变，
  // 重扫和重启都刷不掉，那个仓库会永久钉在「最近活跃」第一名
  it("落在未来的提交时间不参与排序，也不把仓库钉在第一名", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const future = new Date(Date.now() + 400 * 86_400_000).toISOString()
    const bogus = { ...heavy, committedAt: future, lastCommit: { ...heavy.lastCommit!, date: future } }
    expect(composeStatus(repo, "id", core, bogus).lastActivity).toBeNull()
  })

  // 排序看 %cI 而不是 %aI：cherry-pick / rebase / commit --amend 会重写提交却原样保留
  // 作者时间。按 %aI 排的话,今天把三个月前的提交摘过来的仓库会显示成陈年老仓库,
  // 还可能落进「最久没碰的 10 个」,而热力图(用 %cI)同时把今天这一格点亮
  it("提交那侧看的是 committer 时间，cherry-pick 过来的老提交算今天的活儿", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const picked = {
      ...heavy,
      lastCommit: { ...heavy.lastCommit!, date: "2026-01-01T00:00:00Z" }, // 作者时间：一月
      committedAt: "2026-08-25T09:00:00Z", // 提交者时间：今天摘过来的
    }
    expect(composeStatus(repo, "id", core, picked).lastActivity).toBe("2026-08-25T09:00:00Z")
  })

  // committedAt 缺失（旧缓存条目、或格式被干扰）时回落到 %aI，别让排序整个塌成 null
  it("committedAt 缺失时回落到作者时间", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const legacy = { ...heavy, committedAt: null }
    expect(composeStatus(repo, "id", core, legacy).lastActivity).toBe(heavy.lastCommit!.date)
  })

  // 损坏的 date 行会让 git 把 `%aI` 占位符原样吐出来。不设防的话它单向获胜（x >= NaN 恒假），
  // 而前端 relativeTime 对 NaN 每个分支都不成立、最后落到「刚刚」——全屏最新鲜的那个
  it("解析不出来的提交时间被丢掉，回落到工作区 mtime", async () => {
    const repo = makeRepo({ dirty: true })
    const core = await getRepoCore(repo)
    const { heavy } = await getRepoHeavy(repo, core)
    const bogus = { ...heavy, lastCommit: { ...heavy.lastCommit!, date: "%aI" } }
    expect(composeStatus(repo, "id", core, bogus).lastActivity).toBe(core.workedAt)
  })
})

describe("worktreeTouchedAt", () => {
  it("上限约束的是循环次数，不只是 stat 次数——否则被过滤掉的条目可以无限多", async () => {
    const repo = makeRepo()
    // 5 万条全部命中目录名过滤。只数 stat 的话计数器停在 0、break 永不发生，
    // 每轮刷新白跑 5 万次 resolve + relative + 正则切分（实测 248ms，且当时是同步的）
    const flood = Array.from({ length: 50_000 }, (_, i) => ({ path: `node_modules/p${i}/x.js`, untracked: true }))
    const t = Date.now()
    expect(await worktreeTouchedAt(repo, flood)).toBeNull()
    expect(Date.now() - t).toBeLessThan(200)
  })

  it("软链取的是软链自己的 mtime（lstat），指向失效也不算作「文件已删除」", async () => {
    const repo = makeRepo()
    try {
      symlinkSync(join(repo, "nonexistent-target.txt"), join(repo, "dangling.lnk"))
    } catch {
      return // Windows 上非管理员/未开开发者模式建不了软链，跳过
    }
    // stat 会对失效软链抛 ENOENT（被当成「文件已删除」咽掉），lstat 照样读得到软链本身
    expect(await worktreeTouchedAt(repo, [{ path: "dangling.lnk", untracked: true }])).not.toBeNull()
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
