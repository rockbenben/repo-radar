import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { aggregateHeatmap, buildActivity, clearStatsCache, evictRepoStats, repoCommitDays } from "../src/stats"
import type { RepoStatus } from "../src/types"
import { cleanupFixtures, makeBehindRepo, makeRepoWithDates } from "./fixtures"

afterAll(cleanupFixtures)
beforeEach(clearStatsCache)

const D1 = "2026-07-01T10:00:00+08:00"
const D2 = "2026-07-01T18:00:00+08:00"
const D3 = "2026-07-03T09:00:00+08:00"

describe("repoCommitDays", () => {
  it("buckets commits by local date", async () => {
    const repo = makeRepoWithDates([D1, D2, D3])
    const days = await repoCommitDays(repo, "r1", 365)
    expect(days.get("2026-07-01")).toBe(2)
    expect(days.get("2026-07-03")).toBe(1)
  })
  it("returns empty map for a non-git path without throwing", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const days = await repoCommitDays(mkdtempSync(join(tmpdir(), "rr-nogit-")), "rX", 365)
    expect(days.size).toBe(0)
  })
  it("caches per sinceDays window, not just per repo", async () => {
    const now = new Date()
    const recent = now.toISOString()
    const old = new Date(now.getTime() - 100 * 86400_000).toISOString()
    const repo = makeRepoWithDates([old, recent])
    const short = await repoCommitDays(repo, "rw", 30)
    expect([...short.values()].reduce((a, b) => a + b, 0)).toBe(1) // 只有 recent
    const long = await repoCommitDays(repo, "rw", 365) // 同一 repoId、不同窗口，不得复用 30 天缓存
    expect([...long.values()].reduce((a, b) => a + b, 0)).toBe(2)
  })
  it("evictRepoStats drops all windows for one repo, forcing a re-read", async () => {
    const now = new Date()
    const repo = makeRepoWithDates([now.toISOString()])
    await repoCommitDays(repo, "ev", 30) // 填充缓存
    await repoCommitDays(repo, "keep", 30) // 另一仓库的缓存不受影响
    const { rmSync } = await import("node:fs")
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 }) // 删掉仓库：缓存命中会返回旧数据，重读会得到空
    expect([...(await repoCommitDays(repo, "ev", 30)).values()].reduce((a, b) => a + b, 0)).toBe(1) // 仍命中缓存
    evictRepoStats("ev")
    expect((await repoCommitDays(repo, "ev", 30)).size).toBe(0) // 缓存已作废，重读仓库已不存在 → 空
    expect([...(await repoCommitDays(repo, "keep", 30)).values()].reduce((a, b) => a + b, 0)).toBe(1) // keep 仍命中
  })
  it("counts only local-branch commits, not fetched remote-tracking ones", async () => {
    // makeBehindRepo：本地 main 只有 1 个提交，origin/main 多 1 个（fetch 下来的、你没写的）
    const days = await repoCommitDays(makeBehindRepo(), "branchtest", 365)
    expect([...days.values()].reduce((a, b) => a + b, 0)).toBe(1) // --branches 只数本地分支
  })
})

describe("aggregateHeatmap", () => {
  it("sums across repos sorted by date", async () => {
    const a = makeRepoWithDates([D1])
    const b = makeRepoWithDates([D2, D3])
    const days = await aggregateHeatmap(
      [
        { id: "a", path: a },
        { id: "b", path: b },
      ],
      365,
    )
    expect(days).toEqual([
      { date: "2026-07-01", count: 2 },
      { date: "2026-07-03", count: 1 },
    ])
  })
})

describe("buildActivity", () => {
  const stub = (id: string, date: string | null): RepoStatus =>
    ({
      id, path: id, name: id, group: "g", tags: [], favorite: false,
      archived: false, note: null, lastOpened: null, mergedBranches: [],
      displayName: null, description: null, language: null, branch: "main",
      dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      ahead: 0, behind: 0, stashCount: 0, remotes: [],
      lastCommit: date ? { hash: "h", message: "m", author: "a", date } : null,
      health: [], githubInbox: null, stashOldest: null, release: null, error: null, scannedAt: "",
    }) as RepoStatus
  it("sorts most-recent first, null last", () => {
    const out = buildActivity([stub("old", "2026-01-01T00:00:00Z"), stub("empty", null), stub("new", "2026-07-10T00:00:00Z")])
    expect(out.map((r) => r.id)).toEqual(["new", "old", "empty"])
    expect(out[2].lastCommitDate).toBeNull()
  })
  it("orders by absolute time across differing timezone offsets", () => {
    // b 的挂钟更晚但带 +08:00，实际是 UTC 02:00，早于 a 的 UTC 05:00
    const a = stub("a", "2026-07-01T05:00:00+00:00")
    const b = stub("b", "2026-07-01T10:00:00+08:00")
    expect(buildActivity([b, a]).map((r) => r.id)).toEqual(["a", "b"]) // a 更晚，排前
  })
})
