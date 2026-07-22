import { describe, expect, it } from "vitest"
import { githubSlug, parseInboxResponse } from "../src/github"

describe("githubSlug", () => {
  it("parses https urls with and without .git", () => {
    expect(githubSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
    expect(githubSlug("https://github.com/owner/repo")).toBe("owner/repo")
    expect(githubSlug("https://github.com/owner/repo/")).toBe("owner/repo")
  })
  it("parses ssh urls", () => {
    expect(githubSlug("git@github.com:owner/repo.git")).toBe("owner/repo")
    expect(githubSlug("git@github.com:owner/repo")).toBe("owner/repo")
  })
  it("returns null for non-github urls", () => {
    expect(githubSlug("https://gitlab.com/owner/repo.git")).toBeNull()
    expect(githubSlug("https://example.com/x")).toBeNull()
  })
})

// 构造 gh graphql 响应体的小工具：repo 字段默认齐全（pullRequests/issues 都有值），
// 按需覆盖 mine/prOthers/defaultBranchRef 来模拟限流置空等场景
function stdout(opts: {
  pullRequests?: number | null
  issues?: number | null
  mine?: number | null
  prOthers?: number | null
  ciState?: string | null
  ciSha?: string | null
  omitDefaultBranchRef?: boolean
}): string {
  const repo: Record<string, unknown> = {}
  if (opts.pullRequests !== null) repo.pullRequests = opts.pullRequests === undefined ? { totalCount: 5 } : { totalCount: opts.pullRequests }
  if (opts.issues !== null) repo.issues = opts.issues === undefined ? { totalCount: 5 } : { totalCount: opts.issues }
  if (opts.mine !== undefined) repo.mine = opts.mine === null ? null : { totalCount: opts.mine }
  if (!opts.omitDefaultBranchRef) {
    repo.defaultBranchRef = { target: { oid: opts.ciSha ?? "sha1", statusCheckRollup: { state: opts.ciState ?? "SUCCESS" } } }
  }
  const data: Record<string, unknown> = { repository: repo }
  if (opts.prOthers !== undefined) data.prOthers = opts.prOthers === null ? null : { issueCount: opts.prOthers }
  return JSON.stringify({ data })
}

describe("parseInboxResponse", () => {
  it("me 已知、mine/prOthers 都正常 → 按'减去自己'口径计算，byViewer=true", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 10, issues: 10, mine: 3, prOthers: 4 }), 0, "octocat")
    expect(r).toMatchObject({ prs: 4, issues: 7, byViewer: true })
  })

  it("me 未知（viewer 查询失败）→ 用含自己的总数，不减，byViewer=false", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 10, issues: 10 }), 0, null)
    expect(r).toMatchObject({ prs: 10, issues: 10, byViewer: false })
  })

  // Important 1：mine 字段被二级限流单独置空时，之前会静默按 0 算，issues 虚高「自己开的」那部分
  it("mine 被限流置空、有旧缓存 issues → 沿用旧缓存，不按 0 算", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 10, issues: 10, mine: null, prOthers: 4 }), 0, "octocat", undefined, 6)
    expect(r).toMatchObject({ issues: 6 })
  })

  it("mine 被限流置空、无旧缓存 → 退回未减的总数（好过误判为 0）", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 10, issues: 10, mine: null, prOthers: 4 }), 0, "octocat")
    expect(r).toMatchObject({ issues: 10 })
  })

  it("prOthers 被限流置空、有旧缓存 prs → 沿用旧缓存（既有行为，回归保护）", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 10, issues: 10, mine: 3, prOthers: null }), 0, "octocat", 7)
    expect(r).toMatchObject({ prs: 7 })
  })

  it("pullRequests/issues 字段本身缺失 → 返回 null，保留旧缓存", () => {
    expect(parseInboxResponse(stdout({ pullRequests: null, issues: 5 }), 0, "octocat")).toBeNull()
    expect(parseInboxResponse(stdout({ pullRequests: 5, issues: null }), 0, "octocat")).toBeNull()
  })

  it("非零退出且 defaultBranchRef 缺失 → 返回 null（分不清真无默认分支还是被限流置空）", () => {
    expect(parseInboxResponse(stdout({ pullRequests: 5, issues: 5, omitDefaultBranchRef: true }), 1, "octocat")).toBeNull()
  })

  it("stdout 不是合法 JSON → 返回 null", () => {
    expect(parseInboxResponse("not json", 1, "octocat")).toBeNull()
  })

  it("CI 状态与 sha 原样透传", () => {
    const r = parseInboxResponse(stdout({ pullRequests: 0, issues: 0, mine: 0, prOthers: 0, ciState: "FAILURE", ciSha: "deadbeef" }), 0, "octocat")
    expect(r).toMatchObject({ ciFailed: true, ciSha: "deadbeef" })
  })
})
