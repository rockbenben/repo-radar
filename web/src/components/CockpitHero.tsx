import { useEffect, useId, useRef, useState } from "react"
import { githubInboxUrl, githubRemoteUrl, githubSlug, isGithubInboxKind } from "../../../shared/src/github"
import { useT } from "../i18n"
import type { RepoStatus } from "../types"

export type QueueItem = { r: RepoStatus; sev: "crit" | "warn"; kind: string; n: number; age: number; score: number; githubTime?: number }

const PREVIEW_SIZE = 3
const AGED_KINDS = new Set(["dirty", "unpushed", "stash"]) // 显示「搁 N 天」的类型（release 另用「距上个 tag N 天」，含义不同）

/**
 * 工作入口：进门第一屏只回答「现在该我管什么」——按紧迫度排的跨仓库行动队列，条目能直接动手。
 * 点击按类型分流：等我的(PR/issue/CI)→ 跳 GitHub 对应页；其余(没提交/冲突/落后/未推)→ 开详情弹窗；未推的另给一键 push。
 * 超过 3 条可展开看全部。可「已处理」消掉(有新的再回来)、可 ↻ 手动刷新。「接着上次」交给下方卡片墙。
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
  onOpenStash: (id: string) => void
  onPush: (id: string) => void
  onDismiss: (q: QueueItem) => void
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const queueId = useId()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

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
  const act = (q: QueueItem) => {
    if (isGithubInboxKind(q.kind)) {
      const remote = githubRemoteUrl(q.r.remotes)
      const slug = remote && githubSlug(remote)
      if (slug) {
        const inbox = q.r.githubInbox
        // 一行有多个 PR 或 issue 时，打开完整列表以保留对所有待处理项的访问。
        const target = q.kind === "ci" ? inbox?.ciSha : q.n === 1
          ? (q.kind === "pr" ? inbox?.latestPr?.number : inbox?.latestIssue?.number)
          : null
        window.open(githubInboxUrl(slug, q.kind, target), "_blank", "noopener,noreferrer")
        return
      }
    }
    if (q.kind === "stash") onOpenStash(q.r.id)
    else onOpenRepo(q.r.id)
  }
  const itemTitle = (q: QueueItem) => (isGithubInboxKind(q.kind) ? t("queue.openGithub") : q.kind === "stash" ? t("queue.openStash") : t("common.openRepoTip"))

  const shown = expanded ? queue : queue.slice(0, PREVIEW_SIZE)
  const toggleLabel = t(open ? "cockpit.hide" : "cockpit.show")

  return (
    <section className="rr-home">
      <div className="rr-home-head">
        <h2>{t("home.needsYou")}</h2>
        <span className="rr-queue-count">{queue.length}</span>
        <div className="rr-home-actions">
          {open && queue.length > PREVIEW_SIZE && (
            <button type="button" className="rr-home-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? t("home.showLess") : t("home.showAll", { n: queue.length })}
            </button>
          )}
          <button type="button" className={`rr-home-refresh${refreshing ? " on" : ""}`} onClick={refresh} disabled={refreshing} title={t("home.refresh")} aria-label={t("home.refresh")}>
            ↻
          </button>
          <button type="button" className="rr-home-toggle" onClick={onToggle} title={toggleLabel} aria-label={toggleLabel} aria-expanded={open} aria-controls={queueId}>
            {open ? "▾" : "▸"}
          </button>
        </div>
      </div>
      <div id={queueId} hidden={!open}>
        {open && (queue.length === 0 ? (
          <div className="clear">{t("cockpit.allClear")}</div>
        ) : (
          <div className="queue-list">
            {shown.map((q) => (
              <div key={q.r.id} className={`item ${q.sev}`}>
                <button type="button" className="open" onClick={() => act(q)} title={itemTitle(q)}>
                  <span className="dot" aria-hidden="true" />
                  <bdi className="nm" title={q.r.name}>{label(q.r)}</bdi>
                  <span className="why" title={reason(q)}>{reason(q)}</span>
                  {q.age >= 2 && AGED_KINDS.has(q.kind) && <span className="aged">{t("queue.aged", { d: q.age })}</span>}
                  {q.kind === "release" && q.age >= 2 && <span className="aged">{t("queue.sinceTag", { d: q.age })}</span>}
                </button>
                {q.kind === "unpushed" && (
                  <button type="button" className="quick" onClick={() => onPush(q.r.id)} title={t("queue.push")} aria-label={t("queue.push")}>
                    ↑
                  </button>
                )}
                <button type="button" className="done" onClick={() => onDismiss(q)} title={t("queue.done")} aria-label={t("queue.done")}>
                  ✓
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
