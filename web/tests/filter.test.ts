import { describe, expect, it } from "vitest"
import { applyFilter } from "../src/lib/filter"
import type { RepoStatus } from "../src/types"

function repo(over: Partial<RepoStatus>): RepoStatus {
  return {
    id: "x",
    path: "C:\\r",
    name: "r",
    displayName: null,
    description: null,
    language: null,
    archived: false,
    note: null,
    lastOpened: null,
    mergedBranches: [],
    group: "g",
    tags: [],
    favorite: false,
    branch: "main",
    dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ahead: -1,
    upstream: null,
    behind: -1,
    stashCount: 0,
    remotes: [],
    lastCommit: null,
    health: [],
    githubInbox: null,
    stashOldest: null,
    release: null,
    error: null,
    scannedAt: "",
    ...over,
  }
}

describe("applyFilter", () => {
  const repos = [
    repo({ id: "1", name: "alpha", path: "D:\\p\\alpha", group: "365", tags: ["web"] }),
    repo({ id: "2", name: "beta", path: "D:\\p\\beta", group: "misc", lastCommit: { hash: "h", message: "m", author: "a", date: "2026-07-01T00:00:00Z" } }),
    repo({ id: "3", name: "gamma", path: "D:\\p\\gamma", group: "365", favorite: true, lastCommit: { hash: "h", message: "m", author: "a", date: "2026-01-01T00:00:00Z" } }),
  ]

  it("matches query against name, path and tags (case-insensitive)", () => {
    expect(applyFilter(repos, { query: "ALPHA", group: null, sort: "name", severity: null }).map((r) => r.id)).toEqual(["1"])
    expect(applyFilter(repos, { query: "p\\beta", group: null, sort: "name", severity: null }).map((r) => r.id)).toEqual(["2"])
    expect(applyFilter(repos, { query: "web", group: null, sort: "name", severity: null }).map((r) => r.id)).toEqual(["1"])
  })

  it("filters by tags with AND semantics", () => {
    const rs = [
      repo({ id: "a", name: "a", tags: ["web", "wip"] }),
      repo({ id: "b", name: "b", tags: ["web"] }),
      repo({ id: "c", name: "c", tags: ["wip"] }),
    ]
    const ids = (tags: string[]) => applyFilter(rs, { query: "", group: null, sort: "name", severity: null, tags }).map((r) => r.id)
    expect(ids(["web"])).toEqual(["a", "b"])
    expect(ids(["web", "wip"])).toEqual(["a"]) // 须同时带两个标签
    expect(ids([])).toEqual(["a", "b", "c"])
  })

  it("filters by group", () => {
    expect(applyFilter(repos, { query: "", group: "365", sort: "name", severity: null }).map((r) => r.id)).toEqual(["3", "1"]) // 收藏优先
  })

  it("sorts favorites first, then by name", () => {
    expect(applyFilter(repos, { query: "", group: null, sort: "name", severity: null }).map((r) => r.id)).toEqual(["3", "1", "2"])
  })

  it("sorts by recent activity, null lastCommit last", () => {
    expect(applyFilter(repos, { query: "", group: null, sort: "activity", severity: null }).map((r) => r.id)).toEqual(["3", "2", "1"])
  })

  it("matches query against displayName and description", () => {
    const rs = [repo({ id: "9", name: "027", displayName: "repo-radar", description: "本地面板" })]
    expect(applyFilter(rs, { query: "radar", group: null, sort: "name", severity: null })).toHaveLength(1)
    expect(applyFilter(rs, { query: "面板", group: null, sort: "name", severity: null })).toHaveLength(1)
  })

  it("filters by severity", () => {
    const rs = [
      repo({ id: "e1", health: [{ rule: "no-remote", severity: "error", message: "x" }] }),
      repo({ id: "e2", error: "broken" }),
      repo({ id: "w1", health: [{ rule: "dirty", severity: "warn", message: "x" }] }),
      repo({ id: "ok" }),
    ]
    const f = (severity: "error" | "warn" | null) =>
      applyFilter(rs, { query: "", group: null, sort: "name", severity }).map((r) => r.id)
    expect(f("error").sort()).toEqual(["e1", "e2"])
    expect(f("warn")).toEqual(["w1"])
    expect(f(null)).toHaveLength(4)
  })
})
