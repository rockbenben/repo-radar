import { writeFileSync } from "node:fs"
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

describe("getRepoHeavy", () => {
  it("给出 stash / 最近提交", async () => {
    const repo = makeRepo({ stash: true })
    const heavy = await getRepoHeavy(repo, "main")
    expect(heavy.stashCount).toBe(1)
    expect(heavy.lastCommit?.message).toBe("c0")
  })

  // displayName / description / language 来自工作区（package.json / README / 根目录列表），
  // 而 heavy 是按一个完全由 .git 算出来的指纹缓存的。留在 heavy 里的话，改 package.json
  // 的 name——正是用户重命名项目的那一刻——卡片标题会冻结到某次无关的 git 操作为止
  it("工作区派生的字段不在 heavy 里（它们不可能被 .git 指纹感知）", async () => {
    const heavy = await getRepoHeavy(makeRepo(), "main")
    expect(heavy).not.toHaveProperty("displayName")
    expect(heavy).not.toHaveProperty("description")
    expect(heavy).not.toHaveProperty("language")
  })

  it("composeStatus 现算工作区字段：改 package.json 后无需任何 git 操作即刻生效", async () => {
    const repo = makeRepo()
    const core = await getRepoCore(repo)
    const heavy = await getRepoHeavy(repo, core.branch) // 只算一次，模拟「heavy 命中缓存」
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
    const heavy = await getRepoHeavy(repo, "main")
    expect(heavy.mergedBranches).toEqual(["feature-done"])
  })

  it("从未打过 tag 时 release 为 null", async () => {
    expect((await getRepoHeavy(makeRepo(), "main")).release).toBeNull()
  })
})

// 拆分不得改变对外结果：这是本任务唯一真正重要的断言
describe("composeStatus 与 getRepoStatus 等价", () => {
  it("手工组合的结果与 getRepoStatus 一致", async () => {
    const repo = makeRepo({ dirty: true, stash: true })
    const viaStatus = await getRepoStatus(repo)
    const core = await getRepoCore(repo)
    const heavy = await getRepoHeavy(repo, core.branch)
    const composed = composeStatus(repo, repoId(repo), core, heavy)
    // scannedAt 是各自的当前时刻，比对前对齐
    expect({ ...composed, scannedAt: "" }).toEqual({ ...viaStatus, scannedAt: "" })
  })

  it("getRepoStatus 可以接受外部传入的 id", async () => {
    const repo = makeRepo()
    expect((await getRepoStatus(repo, "forced-id")).id).toBe("forced-id")
  })
})
