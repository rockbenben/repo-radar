import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n"
import { isGithubUrl, remoteWeb } from "../lib/meta"
import type { RepoStatus } from "../types"

export type QueueItem = { r: RepoStatus; sev: "crit" | "warn"; kind: string; n: number; age: number; score: number }

/** GitHub 来源的队列类型（等我的）：点击跳 GitHub 对应页；App 的「已处理」清理也据此判断 inbox=null 是否算未知 */
export const GITHUB_KINDS = new Set(["pr", "issue", "ci"])
const GH_PATH: Record<string, string> = { pr: "/pulls", issue: "/issues", ci: "/actions" }
const AGED_KINDS = new Set(["dirty", "unpushed", "stash"]) // 显示「搁 N 天」的类型（release 另用「距上个 tag N 天」，含义不同）

/**
 * 工作入口：进门第一屏只回答「现在该我管什么」——按紧迫度排的跨仓库行动队列，条目能直接动手。
 * 点击按类型分流：等我的(PR/issue/CI)→ 跳 GitHub 对应页；其余(没提交/冲突/落后/未推)→ 开详情弹窗；未推的另给一键 push。
 * 超过 10 条可展开看全部。可「已处理」消掉(有新的再回来)、可 ↻ 手动刷新。「接着上次」交给下方卡片墙。
 */
export function CockpitHero({
  queue,
  onOpenRepo,
  onOpenStash,
  onPush,
  onDismiss,
  open,
  onToggle,
}: {
  queue: QueueItem[]
  onOpenRepo: (id: string) => void
  onOpenStash: () => void
  onPush: (id: string) => void
  onDismiss: (q: QueueItem) => void
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => void (mounted.current = false), [])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetch("/api/github/refresh", { method: "POST" })
    } catch {
      /* 忽略：失败不影响已显示的数据 */
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  const label = (r: RepoStatus) => r.name.replace(/^(\d{3})-/, "") // 与卡片一致，用文件夹名
  const reason = (q: QueueItem) => {
    switch (q.kind) {
      case "ci":
        return t("queue.ci")
      case "pr":
        return t("queue.pr", { n: q.n })
      case "issue":
        return t("queue.issue", { n: q.n })
      case "conflict":
        return t("queue.conflict", { n: q.n })
      case "behind":
        return t("queue.behind", { n: q.n })
      case "dirty":
        return t("queue.dirty", { n: q.n })
      case "release":
        return t("queue.release", { n: q.n, tag: q.r.release?.tag ?? "" })
      case "stash":
        return t("queue.stash", { n: q.n })
      default:
        return t("queue.unpushed", { n: q.n })
    }
  }
  // 点击主区按类型分流：等我的 → 跳 GitHub 对应页（新标签）；stash → 直达收纳箱；其余 → 开本地详情。
  // URL 只从 github.com 的远程里挑（isGithubUrl 精确匹配主机名），remoteWeb 再 origin 优先——
  // 与服务端计数的挑选逻辑（githubRemoteUrl）同序，保证「计数来自哪个仓库，点开就是哪个仓库」
  const act = (q: QueueItem) => {
    const web = GITHUB_KINDS.has(q.kind) ? remoteWeb(q.r.remotes.filter((rm) => isGithubUrl(rm.url))) : null
    if (web) window.open(web.url + (GH_PATH[q.kind] ?? ""), "_blank", "noopener,noreferrer")
    else if (q.kind === "stash") onOpenStash()
    else onOpenRepo(q.r.id)
  }
  const itemTitle = (q: QueueItem) => (GITHUB_KINDS.has(q.kind) ? t("queue.openGithub") : q.kind === "stash" ? t("queue.openStash") : t("common.openRepoTip"))

  if (!open) {
    return (
      <div className="rr-home closed">
        <button className="rr-home-toggle" onClick={onToggle} title={t("cockpit.show")}>
          ▸
        </button>
        <div className="rr-home-slim">
          <span className={`tag${queue.length ? " on" : ""}`}>
            {queue.length} {t("home.needsYou")}
          </span>
          {queue[0] && (
            <span className="last">
              <b>{label(queue[0].r)}</b> {reason(queue[0])}
            </span>
          )}
        </div>
      </div>
    )
  }

  const shown = expanded ? queue : queue.slice(0, 10)

  return (
    <div className="rr-home">
      <button className="rr-home-toggle" onClick={onToggle} title={t("cockpit.hide")}>
        ▾
      </button>
      <div className="rr-home-head">
        <h4>
          {t("home.needsYou")}
          {queue.length > 0 ? ` · ${queue.length}` : ""}
        </h4>
        <button className={`rr-home-refresh${refreshing ? " on" : ""}`} onClick={refresh} disabled={refreshing} title={t("home.refresh")}>
          ↻
        </button>
      </div>
      {queue.length === 0 ? (
        <div className="clear">{t("cockpit.allClear")}</div>
      ) : (
        <>
          <div className="queue-list">
            {shown.map((q) => (
              <div key={q.r.id} className={`item ${q.sev}`}>
                <button className="open" onClick={() => act(q)} title={itemTitle(q)}>
                  <span className="dot" />
                  <span className="nm mono">{label(q.r)}</span>
                  <span className="why">{reason(q)}</span>
                  {q.age >= 2 && AGED_KINDS.has(q.kind) && <span className="aged">{t("queue.aged", { d: q.age })}</span>}
                  {q.kind === "release" && q.age >= 2 && <span className="aged">{t("queue.sinceTag", { d: q.age })}</span>}
                </button>
                {q.kind === "unpushed" && (
                  <button className="quick" onClick={() => onPush(q.r.id)} title={t("queue.push")}>
                    ↑
                  </button>
                )}
                <button className="done" onClick={() => onDismiss(q)} title={t("queue.done")}>
                  ✓
                </button>
              </div>
            ))}
          </div>
          {queue.length > 10 && (
            <button className="rr-home-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t("home.showLess") : t("home.showAll", { n: queue.length })}
            </button>
          )}
        </>
      )}
    </div>
  )
}
