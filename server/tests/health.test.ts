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
    ahead: 0, behind: 0, stashCount: 0,
    remotes: [{ name: "origin", url: "u" }],
    lastCommit: { hash: "h", message: "m", author: "a", date: new Date().toISOString() },
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
    expect(rules(repo({ lastCommit: { hash: "h", message: "m", author: "a", date: old } }))).toContain("stale")
  })
  it("no-upstream does not fire for detached or remoteless repos", () => {
    expect(rules(repo({ branch: null, ahead: -1 }))).not.toContain("no-upstream")
    expect(rules(repo({ remotes: [], ahead: -1 }))).not.toContain("no-upstream")
  })
  it("stale respects configured threshold and disabledRules disables", () => {
    const c = cfg()
    c.health.staleDays = 200
    const old = new Date(Date.now() - 100 * 86400_000).toISOString()
    expect(rules(repo({ lastCommit: { hash: "h", message: "m", author: "a", date: old } }), c)).not.toContain("stale")
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
