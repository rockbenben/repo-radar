import type { RepoStatus } from "../types"
import { daysSince } from "./meta"

export const days = (d?: string | null): number => daysSince(d ?? null) ?? 0
const RELEASE_MIN_AHEAD = 3 // 发版雷达：tag 之后堆到几个提交才提醒（刚发完版提交一两个别急着烦人）
const STASH_MIN_DAYS = 7 // stash 搁几天才提醒
export const STASH_SNOOZE_MS = 30 * 86_400_000 // stash「已处理」是打盹不是消除：30 天后再提醒（不然真忘了的那条永远不响）
// 「已处理」三种失效规则：
// 计数类（PR/issue/落后/未推/未发版）——存当时数量，只在「更多（来了新的）」时重现；
// stash——打盹：存点击时间，30 天到点重响；没提交/冲突按 HEAD hash 记，提交一次才重评；
// CI 按远程默认分支 oid 记（远端条件，绝不落本地 hash——见 dismissVal 的注释）。
export const COUNT_KINDS = new Set(["pr", "issue", "behind", "unpushed", "release"])

/**
 * 计数类「已处理」的存储形状：`"4"`（水位）或 `"4@7"`（水位 @ 点击当时服务端的累计新到达数）。
 *
 * 为什么要多存后半截：光靠水位，「下探」只有在渲染进程活着、并且恰好观察到那一轮时才会被记下
 * （App 清理 effect 里的降档）。托盘常驻（--tray / 开机自启）恰恰是没有渲染进程的形态——
 * 4 个 PR 全被合掉（差值 ≤ 0 不弹通知，也没人降水位）、随后来了 2 个新的：系统通知照弹
 * 「PR +2」，用户点进来，这边却按 2 ≤ 4 判定为已处理，「该你了」里根本没有这条；紧接着清理
 * effect 把水位降到 2，2 ≤ 2 依然成立——除非 PR 数涨过 2，否则再也不出现。用户被通知叫来看一个
 * 不存在的条目，界面上还没有「撤销已处理」的入口。
 * 服务端在 InboxCache 里逐轮累加「新到达」数（只增不减，见 server/src/types.ts 的 prsAdded），
 * 面板关着的那些轮次照记，于是这里只要比对基线就知道「点了已处理之后到底有没有新东西进来」。
 * 只有 pr/issue 有这份服务端记账；旧格式（纯数字）与其余计数类退回原来的纯水位比较，
 * 下次点「已处理」时自动升级成新格式。
 */
export const parseMark = (v: string): { n: number; base: number | null } => {
  const at = v.indexOf("@")
  return at < 0 ? { n: Number(v), base: null } : { n: Number(v.slice(0, at)), base: Number(v.slice(at + 1)) }
}
export const formatMark = (n: number, base: number | null): string => (base === null ? String(n) : `${n}@${base}`)

// 服务端记的累计新到达数；没有这份记账（非 GitHub 类、或还没拉到 inbox）返回 null
export function kindArrivals(r: RepoStatus, kind: string): number | null {
  switch (kind) {
    case "pr":
      return r.githubInbox?.prsAdded ?? null
    case "issue":
      return r.githubInbox?.issuesAdded ?? null
    default:
      return null
  }
}

export const dismissKey = (q: { r: RepoStatus; kind: string }) => `${q.r.id}:${q.kind}`
// ci 按「远程默认分支 oid」记（CI 红是远端条件，按本地 HEAD 记的话别人推新提交触发的新失败永远不重现）；
// 缓存还没有 ciSha 时存哨兵 "0"——绝不落本地 hash：oid 下一轮到达时会和本地 hash 对不上，
// 刚点的已处理会无故复活（迁移重现）。哨兵语义见 isDismissed。
export const dismissVal = (q: { r: RepoStatus; kind: string; n: number }) =>
  q.kind === "stash"
    ? String(Date.now())
    : q.kind === "ci"
      ? (q.r.githubInbox?.ciSha ?? "0")
      : COUNT_KINDS.has(q.kind)
        ? formatMark(q.n, kindArrivals(q.r, q.kind)) // pr/issue 连服务端的累计新到达数一起存作基线
        : (q.r.lastCommit?.hash ?? "0")

// 计数类问题的当前数量——「已处理」清理时用来给水位降档
export function kindCount(r: RepoStatus, kind: string): number {
  switch (kind) {
    case "pr":
      return r.githubInbox?.prs ?? 0
    case "issue":
      return r.githubInbox?.issues ?? 0
    case "behind":
      return r.behind
    case "unpushed":
      return r.ahead
    case "release":
      return r.release?.ahead ?? 0
    default:
      return 0
  }
}

// 发版/stash 是否「该提醒」——队列生成与「已处理」清理共用一份判定，避免两处阈值漂移。
// 返回上下文（而非布尔）省去调用侧的重复计算与非空断言。
export const activeRelease = (r: RepoStatus) => (r.release && r.release.ahead >= RELEASE_MIN_AHEAD ? r.release : null)
export const activeStashDays = (r: RepoStatus): number | null => {
  if (r.stashCount === 0) return null
  const d = days(r.stashOldest)
  return d >= STASH_MIN_DAYS ? d : null
}

// 某仓库的某类「待处理」问题当前是否仍成立——用于清理已解决的「已处理」记录（解决即清，别压制之后的新情况）。
// 计数类直接委托 kindCount（同一映射，别再抄一份数字来源）；release 例外——它的「成立」带阈值。
export function issueActive(r: RepoStatus, kind: string): boolean {
  if (kind === "release") return activeRelease(r) !== null
  if (COUNT_KINDS.has(kind)) return kindCount(r, kind) > 0
  switch (kind) {
    case "ci":
      return !!r.githubInbox?.ciFailed
    case "conflict":
      return r.dirty.conflicted > 0
    case "dirty":
      return r.dirty.staged + r.dirty.unstaged + r.dirty.untracked > 0
    case "stash":
      return activeStashDays(r) !== null
    default:
      return false
  }
}

export type AttentionKey = "no-remote" | "detached" | "unpushed" | "dirty" | "behind" | "stash"
export const ATTENTION: { key: AttentionKey; labelKey: string; sev: "crit" | "warn" | "" ; test: (r: RepoStatus) => boolean }[] = [
  { key: "no-remote", labelKey: "lamp.noRemote", sev: "crit", test: (r) => r.remotes.length === 0 },
  { key: "detached", labelKey: "lamp.detached", sev: "crit", test: (r) => r.branch === null },
  { key: "unpushed", labelKey: "lamp.unpushed", sev: "warn", test: (r) => r.ahead > 0 },
  { key: "dirty", labelKey: "lamp.dirty", sev: "warn", test: (r) => r.dirty.staged + r.dirty.unstaged + r.dirty.untracked > 0 },
  { key: "behind", labelKey: "lamp.behind", sev: "warn", test: (r) => r.behind > 0 },
  { key: "stash", labelKey: "lamp.stash", sev: "", test: (r) => r.stashCount > 0 },
]
// 可一键批量处理的告警类型 → 对应的 git 操作
export const LAMP_OP: Partial<Record<AttentionKey, "push" | "pull">> = { unpushed: "push", behind: "pull" }
export const LAMP_KEYS = ATTENTION.map((a) => a.key)
