import type { AttentionKey } from "./attention"
import type { FilterState } from "./filter"

// 记住显示选项（每浏览器）；搜索词与告警筛选不持久化，刷新即清空
export const pref = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`rr.${key}`) ?? fallback
  } catch {
    return fallback
  }
}
export const savePref = (key: string, value: string) => {
  try {
    localStorage.setItem(`rr.${key}`, value)
  } catch {
    /* localStorage 不可用时静默 */
  }
}

// 保存的视图：一套命名的筛选 + 排序 + 分组组合
export type SavedView = {
  name: string
  query: string
  group: string | null
  sort: FilterState["sort"]
  groupMode: "folder" | "language" | "none"
  attention: AttentionKey | null
  tags?: string[]
}
export const loadViews = (): SavedView[] => {
  try {
    return JSON.parse(localStorage.getItem("rr.views") ?? "[]") as SavedView[]
  } catch {
    return []
  }
}

// 操作日志（客户端滚动记录）
export type LogEntry = { t: number; ok: boolean; text: string }
export const loadLog = (): LogEntry[] => {
  try {
    return JSON.parse(localStorage.getItem("rr.log") ?? "[]") as LogEntry[]
  } catch {
    return []
  }
}
