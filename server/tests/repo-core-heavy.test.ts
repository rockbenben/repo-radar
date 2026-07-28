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
  it("给出 stash / 最近提交 / 语言", async () => {
    const repo = makeRepo({ stash: true })
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo" }))
    const heavy = await getRepoHeavy(repo, "main")
    expect(heavy.stashCount).toBe(1)
    expect(heavy.lastCommit?.message).toBe("c0")
    expect(heavy.displayName).toBe("demo")
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
