import { runGit } from "./git"
import { mapLimit } from "./store"
import type { ActivityItem, HeatmapDay, RepoStatus } from "./types"

const TTL_MS = 5 * 60_000
const cache = new Map<string, { days: Map<string, number>; fetchedAt: number }>()

export function clearStatsCache(): void {
  cache.clear()
}

/** 丢弃单个仓库的所有窗口缓存——提交后调用，避免热力图落后于活跃列表最多一个 TTL */
export function evictRepoStats(repoId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${repoId}:`)) cache.delete(key)
  }
}

export async function repoCommitDays(path: string, repoId: string, sinceDays: number): Promise<Map<string, number>> {
  const key = `${repoId}:${sinceDays}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.days
  const days = new Map<string, number>()
  try {
    // --branches：只数本地分支的提交，排除 fetch 下来的远程跟踪提交（那些不是你写的）。
    // 按 committer 本地日期（%cI）分桶，与 --since（按 committer date 过滤）保持一致——
    // 否则 rebase 过的提交会通过时间窗口却落在窗口外的格子里，计入总数却不显示。
    // 前端 Heatmap 用浏览器本地日期渲染，同机单用户场景与此一致。
    const r = await runGit(path, ["log", `--since=${sinceDays} days ago`, "--format=%cI", "--branches"])
    for (const line of r.stdout.split("\n")) {
      const date = line.trim().slice(0, 10)
      if (date !== "") days.set(date, (days.get(date) ?? 0) + 1)
    }
  } catch {
    // 空仓库 / 非 git 目录：空热力图
  }
  cache.set(key, { days, fetchedAt: Date.now() })
  return days
}

export async function aggregateHeatmap(repos: { id: string; path: string }[], sinceDays: number): Promise<HeatmapDay[]> {
  const total = new Map<string, number>()
  await mapLimit(repos, 8, async (r) => {
    const days = await repoCommitDays(r.path, r.id, sinceDays)
    for (const [date, count] of days) total.set(date, (total.get(date) ?? 0) + count)
  })
  return [...total.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }))
}

export function buildActivity(repos: RepoStatus[]): ActivityItem[] {
  return repos
    .map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      lastCommitDate: r.lastCommit?.date ?? null,
    }))
    .sort((a, b) => {
      if (a.lastCommitDate === null) return b.lastCommitDate === null ? 0 : 1
      if (b.lastCommitDate === null) return -1
      // 按绝对时间比较：ISO 字符串带不同时区偏移时字符串比较会排错序
      return new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime()
    })
}
