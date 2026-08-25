import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { checkHealth } from "../src/health"
import type { RepoStatus } from "../src/types"

const cfg = (): Config => structuredClone(DEFAULT_CONFIG)

function repo(over: Partial<RepoStatus>): RepoStatus {
  return {
    id: "x", path: "C:\\r", name: "r", group: "g", tags: [], favorite: false,
    archived: false, note: null, lastOpened: null, mergedBranches: [],
    displayName: null, description: null, language: null, branch: "main",
    dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ahead: 0, behind: 0, upstream: null, stashCount: 0,
    remotes: [{ name: "origin", url: "u" }],
    lastCommit: { hash: "h", message: "m", author: "a", date: new Date().toISOString() },
    committedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    health: [], githubInbox: null, stashOldest: null, release: null, error: null, scannedAt: "", ...over,
  }
}

const rules = (r: RepoStatus, c = cfg()) => checkHealth(r, c).map((i) => i.rule)

describe("checkHealth", () => {
  it("healthy repo yields no issues", () => {
    expect(rules(repo({}))).toEqual([])
  })
  it("error repos skip health checks entirely", () => {
    expect(rules(repo({ error: "boom", remotes: [], branch: null }))).toEqual([])
  })
  it("detects error-level issues", () => {
    expect(rules(repo({ dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 } }))).toContain("conflicted")
    expect(rules(repo({ remotes: [] }))).toContain("no-remote")
    expect(rules(repo({ branch: null }))).toContain("detached-head")
  })
  it("detects warn-level issues", () => {
    expect(rules(repo({ dirty: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 } }))).toContain("dirty")
    expect(rules(repo({ ahead: 2 }))).toContain("unpushed")
    expect(rules(repo({ ahead: -1, behind: -1 }))).toContain("no-upstream")
  })
  it("detects info-level issues", () => {
    expect(rules(repo({ behind: 3 }))).toContain("behind")
    expect(rules(repo({ stashCount: 1 }))).toContain("stash-left")
    const old = new Date(Date.now() - 100 * 86400_000).toISOString()
    expect(rules(repo({ committedAt: old, lastCommit: { hash: "h", message: "m", author: "a", date: old } }))).toContain("stale")
  })

  // 徽章文案在 18 种语言里都写着「N 天没提交」，那是一句可证伪的话，所以规则必须按
  // **提交者**时间算。今天 cherry-pick 一个 210 天前的提交：作者时间还是 210 天前，
  // 而提交是今天落下的——按作者时间算，卡片会一边排在「最近活跃」第一位一边说「210 天没提交」
  it("stale 按提交者时间算：今天 cherry-pick 过来的老提交不算陈旧", () => {
    const old = new Date(Date.now() - 210 * 86400_000).toISOString()
    const r = repo({ committedAt: new Date().toISOString(), lastCommit: { hash: "h", message: "m", author: "a", date: old } })
    expect(rules(r)).not.toContain("stale")
  })

  // 旧缓存条目（v3 及以前）没有 committedAt，回落到作者时间——比不报强
  it("committedAt 缺失时回落到作者时间", () => {
    const old = new Date(Date.now() - 100 * 86400_000).toISOString()
    expect(rules(repo({ committedAt: null, lastCommit: { hash: "h", message: "m", author: "a", date: old } }))).toContain("stale")
  })
  it("no-upstream does not fire for detached or remoteless repos", () => {
    expect(rules(repo({ branch: null, ahead: -1 }))).not.toContain("no-upstream")
    expect(rules(repo({ remotes: [], ahead: -1 }))).not.toContain("no-upstream")
  })
  // 上游配着、只是远程分支被删了（ahead 同样是 -1）：说「未跟踪上游」与事实相反
  it("no-upstream does not fire when the upstream exists but its remote branch is gone", () => {
    expect(rules(repo({ ahead: -1, behind: -1, upstream: "origin/feat" }))).not.toContain("no-upstream")
  })
  it("stale respects configured threshold and disabledRules disables", () => {
    const c = cfg()
    c.health.staleDays = 200
    const old = new Date(Date.now() - 100 * 86400_000).toISOString()
    expect(rules(repo({ committedAt: old, lastCommit: { hash: "h", message: "m", author: "a", date: old } }), c)).not.toContain("stale")
    const c2 = cfg()
    c2.health.disabledRules = ["dirty", "unpushed"]
    expect(rules(repo({ ahead: 5, dirty: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 } }), c2)).toEqual([])
  })
  it("issues carry severity and a chinese message", () => {
    const issues = checkHealth(repo({ ahead: 2 }), cfg())
    expect(issues[0]).toMatchObject({ rule: "unpushed", severity: "warn" })
    expect(issues[0].message.length).toBeGreaterThan(0)
  })
})
