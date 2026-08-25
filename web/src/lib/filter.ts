import type { RepoStatus } from "../types"

export interface FilterState {
  query: string
  group: string | null
  sort: "name" | "activity" | "opened"
  severity: "error" | "warn" | null
  tags?: string[] // 选中的标签，AND 语义：仓库须同时带全部标签
}

/**
 * ISO 时间 → 毫秒；null/无效 → 0（排到最后）。
 *
 * **不能改回字符串比较**：lastActivity 两种来源的形式不同——工作区 mtime 转出来是 UTC
 * （`…Z`），最后提交是 `%aI` 带本地偏移（`…+08:00`）。同一时刻的两种写法逐字符比是反的，
 * 表现为个别仓库在「最近活跃」里排到明显不对的位置，而其余的看着都正常。
 */
const ts = (s: string | null | undefined): number => {
  const t = s == null ? NaN : new Date(s).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function applyFilter(repos: RepoStatus[], f: FilterState): RepoStatus[] {
  const q = f.query.trim().toLowerCase()
  const tags = f.tags ?? []
  const match = (r: RepoStatus): boolean => {
    if (f.severity === "error" && r.error === null && !r.health.some((h) => h.severity === "error")) return false
    if (f.severity === "warn" && !r.health.some((h) => h.severity === "warn")) return false
    if (f.group !== null && r.group !== f.group) return false
    if (tags.length > 0 && !tags.every((t) => r.tags.includes(t))) return false
    if (q === "") return true
    const haystack = [r.name, r.displayName ?? "", r.description ?? "", r.path, r.language ?? "", ...r.tags]
    return haystack.some((s) => s.toLowerCase().includes(q))
  }

  const cmp = (a: RepoStatus, b: RepoStatus): number => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    if (f.sort === "opened") {
      // 从未打开的排在打开过的之后；都没打开过再按最近活跃兜底
      const byOpened = ts(b.lastOpened) - ts(a.lastOpened)
      if (byOpened !== 0) return byOpened
      return ts(b.lastActivity) - ts(a.lastActivity)
    }
    if (f.sort === "activity") {
      return ts(b.lastActivity) - ts(a.lastActivity)
    }
    return a.name.localeCompare(b.name)
  }

  return repos.filter(match).sort(cmp)
}
