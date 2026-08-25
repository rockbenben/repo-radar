import type { RepoStatus } from "../types"

export interface FilterState {
  query: string
  group: string | null
  // activity = 最近动过（工作区 mtime 与提交时间取晚者）；commit = 只看最后一次提交，
  // 也就是卡片上直接显示的那个时间。两者在「改了一整天没提交」的仓库上会给出完全不同的次序，
  // 而哪一种有用取决于你在问什么，所以都留着让用户切
  sort: "name" | "activity" | "commit" | "opened"
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
  // 未来时间同样归 0（排最后）。服务端只清洗了 lastActivity，lastCommit.date（%aI）是原样
  // 发下来的——时钟跑偏的构建机、手写 `--date=` 都能留下 2099 年的提交，而它会把那个仓库
  // 永久钉在「最近提交」第一名（卡片上写着「73 年后」），且躲在 .git 指纹缓存后面刷不掉。
  // 容差与服务端 FUTURE_SLACK_MS 一致：容器/虚拟机的时钟快几秒是常态，不能一刀切
  return Number.isNaN(t) || t > Date.now() + 5 * 60_000 ? 0 : t
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
    if (f.sort === "commit") {
      // 刻意用 lastCommit.date（%aI）而不是服务端排序用的 %cI：这一档排的就是卡片上
      // 那个「最后提交 x 天前」，用户能逐个对上。想问「什么时候真干的活」请用 activity
      return ts(b.lastCommit?.date) - ts(a.lastCommit?.date)
    }
    return a.name.localeCompare(b.name)
  }

  return repos.filter(match).sort(cmp)
}
