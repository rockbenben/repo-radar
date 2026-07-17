import type { RepoStatus } from "../types"

export interface FilterState {
  query: string
  group: string | null
  sort: "name" | "activity" | "opened"
  severity: "error" | "warn" | null
  tags?: string[] // 选中的标签，AND 语义：仓库须同时带全部标签
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
      // 从未打开的排在打开过的之后；都没打开过再按提交时间兜底
      const byOpened = (b.lastOpened ?? "").localeCompare(a.lastOpened ?? "")
      if (byOpened !== 0) return byOpened
      return (b.lastCommit?.date ?? "").localeCompare(a.lastCommit?.date ?? "")
    }
    if (f.sort === "activity") {
      return (b.lastCommit?.date ?? "").localeCompare(a.lastCommit?.date ?? "")
    }
    return a.name.localeCompare(b.name)
  }

  return repos.filter(match).sort(cmp)
}
