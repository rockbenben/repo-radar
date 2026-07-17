import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { commitRepo, createBranch, discardChanges, getRepoDetail, getRepoDiff, getRepoStatus, switchBranch } from "../src/git"
import { cleanupFixtures, git, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

describe("getRepoStatus", () => {
  it("lists merged local branches as cleanable, excluding current and main", async () => {
    const path = makeRepo({ commits: 1 })
    git(path, "branch", "feature-done") // 指向 main tip → 已合并
    const s = await getRepoStatus(path)
    expect(s.mergedBranches).toContain("feature-done")
    expect(s.mergedBranches).not.toContain("main")
  })

  it("reads a clean repo without upstream", async () => {
    const path = makeRepo()
    const s = await getRepoStatus(path)
    expect(s.name).toBe(basename(path))
    expect(s.branch).toBe("main")
    expect(s.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
    expect(s.ahead).toBe(-1)
    expect(s.behind).toBe(-1)
    expect(s.remotes).toEqual([])
    expect(s.stashCount).toBe(0)
    expect(s.lastCommit?.message).toBe("c0")
    expect(s.error).toBeNull()
    expect(s.displayName).toBeNull() // fixture 无 package.json、无 remote
    expect(s.description).toBeNull()
  })

  it("counts untracked file as dirty", async () => {
    const s = await getRepoStatus(makeRepo({ dirty: true }))
    expect(s.dirty.untracked).toBe(1)
  })

  it("reports detached HEAD as null branch", async () => {
    const s = await getRepoStatus(makeRepo({ detached: true }))
    expect(s.branch).toBeNull()
  })

  it("counts stash entries", async () => {
    const s = await getRepoStatus(makeRepo({ stash: true }))
    expect(s.stashCount).toBe(1)
  })

  it("reports ahead=1 behind=0 with upstream", async () => {
    const s = await getRepoStatus(makeRepoWithUpstream())
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(0)
    expect(s.remotes).toEqual([{ name: "origin", url: expect.any(String) }])
  })

  it("handles empty repo (no commits) with null lastCommit", async () => {
    const s = await getRepoStatus(makeRepo({ commits: 0 }))
    expect(s.lastCommit).toBeNull()
    expect(s.branch).toBe("main")
  })

  it("rejects for a non-git directory", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    await expect(getRepoStatus(mkdtempSync(join(tmpdir(), "rr-notgit-")))).rejects.toThrow()
  })
})

describe("getRepoDetail", () => {
  it("returns recent commits (newest first) and structured stash entries", async () => {
    const path = makeRepo({ commits: 3, stash: true })
    const d = await getRepoDetail(path)
    expect(d.recentCommits.length).toBeGreaterThanOrEqual(3)
    expect(d.recentCommits[0].message).toBe("c2")
    expect(d.stashes).toHaveLength(1)
    expect(d.stashes[0].ref).toMatch(/stash@\{0\}/)
    expect(d.stashes[0].sha).toMatch(/^[0-9a-f]{40}$/)
  })
  it("lists local branches with main first, no remote-only branches", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "branch", "feature")
    const d = await getRepoDetail(dir)
    expect(d.branches).toEqual(["main", "feature"]) // main 置顶
    expect(d.remoteBranches).toEqual([])
  })
  it("degrades to empty arrays for an empty repo", async () => {
    const d = await getRepoDetail(makeRepo({ commits: 0 }))
    expect(d).toEqual({ recentCommits: [], stashes: [], branches: [], remoteBranches: [] })
  })
})

describe("switchBranch", () => {
  it("switches to an existing local branch", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "branch", "feature")
    const res = await switchBranch(dir, "feature")
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(dir)).branch).toBe("feature")
  })
  it("reports failure (not throw) for a non-existent branch", async () => {
    const res = await switchBranch(makeRepo({ commits: 1 }), "no-such-branch")
    expect(res.ok).toBe(false)
    expect(res.message).not.toBe("")
  })
  it("checks out a remote-only branch, creating a local tracking branch", async () => {
    const repo = makeRepoWithUpstream() // origin/main + 本地领先
    git(repo, "push", "origin", "HEAD:refs/heads/feature-remote") // origin 上造一个本地没有的分支
    git(repo, "fetch")
    const d = await getRepoDetail(repo)
    expect(d.remoteBranches).toContain("feature-remote")
    expect(d.branches).not.toContain("feature-remote") // 本地尚无
    const res = await switchBranch(repo, "feature-remote") // dwim：自动建跟踪分支
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(repo)).branch).toBe("feature-remote")
  })
  it("excludes remote branch names present on multiple remotes (ambiguous DWIM)", async () => {
    const bare1 = mkdtempSync(join(tmpdir(), "rr-bare1-"))
    const bare2 = mkdtempSync(join(tmpdir(), "rr-bare2-"))
    git(bare1, "init", "--bare", "-b", "main")
    git(bare2, "init", "--bare", "-b", "main")
    const repo = makeRepo({ commits: 1 })
    git(repo, "remote", "add", "origin", bare1)
    git(repo, "remote", "add", "upstream", bare2)
    git(repo, "push", "origin", "HEAD:refs/heads/shared")
    git(repo, "push", "upstream", "HEAD:refs/heads/shared") // 两个远程同名
    git(repo, "push", "origin", "HEAD:refs/heads/only-origin") // 仅一个远程
    git(repo, "fetch", "--all")
    const d = await getRepoDetail(repo)
    expect(d.remoteBranches).toContain("only-origin") // 单远程可安全切换
    expect(d.remoteBranches).not.toContain("shared") // 多远程同名 → 排除（否则 git switch 歧义失败）
    rmSync(bare1, { recursive: true, force: true, maxRetries: 3 })
    rmSync(bare2, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("createBranch", () => {
  it("creates and switches to a new branch", async () => {
    const dir = makeRepo({ commits: 1 })
    const res = await createBranch(dir, "feature-x")
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(dir)).branch).toBe("feature-x")
  })
  it("fails (not throw) on an already-existing branch name", async () => {
    const res = await createBranch(makeRepo({ commits: 1 }), "main")
    expect(res.ok).toBe(false)
    expect(res.message).not.toBe("")
  })
})

describe("discardChanges", () => {
  it("reverts tracked changes and removes untracked files, leaving a clean tree", async () => {
    const dir = makeRepo({ commits: 1 }) // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "modified") // 已跟踪改动
    writeFileSync(join(dir, "untracked.txt"), "new") // 未跟踪
    const res = await discardChanges(dir)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0") // 已还原
    expect(existsSync(join(dir, "untracked.txt"))).toBe(false) // 已删除
    const s = await getRepoStatus(dir)
    expect(s.dirty.staged + s.dirty.unstaged + s.dirty.untracked).toBe(0) // 干净
  })
  it("discards staged files in an unborn (no-commit) repo", async () => {
    const dir = makeRepo({ commits: 0 }) // 空仓库，无 HEAD
    writeFileSync(join(dir, "staged.txt"), "x")
    git(dir, "add", "-A") // 暂存新文件
    writeFileSync(join(dir, "loose.txt"), "y") // 未跟踪
    const res = await discardChanges(dir)
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, "staged.txt"))).toBe(false) // 暂存的新文件也被丢弃
    expect(existsSync(join(dir, "loose.txt"))).toBe(false)
    const s = await getRepoStatus(dir)
    expect(s.dirty.staged + s.dirty.unstaged + s.dirty.untracked).toBe(0)
  })
})

describe("getRepoDiff", () => {
  it("returns non-empty diff for a modified tracked file", async () => {
    const path = makeRepo()
    writeFileSync(join(path, "f0.txt"), "modified content")
    const d = await getRepoDiff(path)
    expect(d.diff.length).toBeGreaterThan(0)
    expect(d.diff).toMatch(/f0\.txt/)
  })

  it("returns untracked file paths", async () => {
    const path = makeRepo({ dirty: true })
    const d = await getRepoDiff(path)
    expect(d.untracked).toContain("new.txt")
  })

  it("returns empty diff and untracked for a clean repo", async () => {
    const d = await getRepoDiff(makeRepo())
    expect(d.diff).toBe("")
    expect(d.untracked).toEqual([])
  })
})

describe("commitRepo", () => {
  it("commits a dirty repo and leaves the working tree clean", async () => {
    const path = makeRepo()
    writeFileSync(join(path, "f0.txt"), "modified content")
    const r = await commitRepo(path, "wip", false)
    expect(r.ok).toBe(true)
    const s = await getRepoStatus(path)
    expect(s.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  })

  it("returns ok:false when there is nothing to commit", async () => {
    const path = makeRepo()
    const r = await commitRepo(path, "empty", false)
    expect(r.ok).toBe(false)
  })
})
