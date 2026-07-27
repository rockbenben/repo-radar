import { Button, Card, Checkbox, Popover } from "antd"
import { memo, type MouseEvent, useEffect, useState } from "react"
import { gt, useT } from "../i18n"
import { isSideBranch, langColor, remoteWeb } from "../lib/meta"
import { relativeTime } from "../lib/time"
import type { CommitInfo, HealthIssue, RepoStatus } from "../types"

// 卡片内快速预览：点"⋯"弹出最近提交，不用打开详情弹窗。内容按需拉取。
function CommitPreview({ repoId, changes }: { repoId: string; changes: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  useEffect(() => {
    if (!open || commits !== null) return
    fetch(`/api/repos/${repoId}/detail?basic=1`) // 只要最近提交，跳过 stash/分支重活
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCommits(d?.recentCommits ?? []))
      .catch(() => setCommits([]))
  }, [open, commits, repoId])
  const content = (
    <div className="rr-preview" onClick={(e) => e.stopPropagation()}>
      {changes > 0 && <div className="ch">{t("preview.dirty", { n: changes })}</div>}
      {commits === null ? (
        <div className="dim">{t("preview.loading")}</div>
      ) : commits.length === 0 ? (
        <div className="dim">{t("preview.empty")}</div>
      ) : (
        commits.map((c) => (
          <div key={c.hash} className="row">
            <span className="t">{relativeTime(c.date)}</span>
            <span className="m">{c.message}</span>
          </div>
        ))
      )}
    </div>
  )
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      title={<span className="mono" style={{ fontSize: 12 }}>{t("preview.title")}</span>}
      content={content}
    >
      <button className="rr-c-peek" onClick={(e) => e.stopPropagation()} title={t("preview.title")}>
        ⋯
      </button>
    </Popover>
  )
}

export interface RepoCardProps {
  repo: RepoStatus
  clock: number // 每分钟 +1 的钟摆：让 memo 化的卡片定期重渲，相对时间（「5 分钟前」）才不会在长开页面里冻住
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string, target: "editor" | "terminal" | "explorer") => void
  onShowDetail: (id: string) => void
  onToggleFavorite: (id: string, next: boolean) => void
  onQuickFilter: (term: string) => void
  onFilterTag: (tag: string) => void
  onCopyPath: (path: string) => void
}

function severity(r: RepoStatus): "ok" | "warn" | "crit" {
  if (r.error || r.health.some((h) => h.severity === "error")) return "crit"
  if (r.health.some((h) => h.severity === "warn")) return "warn"
  return "ok"
}

// 365 每日项目的三位编号是真实序列结构——拆出来做成仪表"频道号"，其余为项目名
function splitName(name: string): [string, string] {
  const m = /^(\d{3})-(.+)$/.exec(name)
  return m ? [m[1], m[2]] : ["", name]
}

const OPENS = [
  { key: "editor", tk: "card.editor" },
  { key: "terminal", tk: "card.terminal" },
  { key: "explorer", tk: "card.dir" },
] as const

// 这些健康规则已在状态行以字形显示，不再重复成 chip
const GLYPH_RULES = new Set(["dirty", "unpushed", "behind", "detached-head", "no-upstream"])
const SEV_CHIP: Record<"error" | "warn" | "info", string> = { error: "c", warn: "w", info: "i" }

// chip 只求一眼可读：把服务端整句压成仪表化短标签，数字从原文里取（用全局 gt，非组件上下文）
function shortHealth(h: HealthIssue): string {
  const n = h.message.match(/\d+/)?.[0] ?? ""
  switch (h.rule) {
    case "conflicted":
      return gt("health.conflicted", { n })
    case "no-remote":
      return gt("health.noRemote")
    case "stash-left":
      return gt("health.stash", { n })
    case "stale":
      return n ? gt("health.stale", { n }) : gt("health.staleLong")
    default:
      return h.message
  }
}

// memo：仅当自身 props 变化才重渲。配合 App 里稳定的回调 + mergeRepo 保留未变仓库引用，
// 一条 repo:updated / 一次选择 / 打字搜索只重渲受影响的卡，而非全部 72 张。
export const RepoCard = memo(function RepoCard({
  repo,
  selected,
  onToggleSelect,
  onOpen,
  onShowDetail,
  onToggleFavorite,
  onQuickFilter,
  onFilterTag,
  onCopyPath,
}: RepoCardProps) {
  const t = useT()
  const sev = severity(repo)
  const [slot, baseName] = splitName(repo.name)
  const changes = repo.dirty.staged + repo.dirty.unstaged + repo.dirty.untracked
  const web = remoteWeb(repo.remotes)
  const desc = repo.description ?? (repo.displayName && repo.displayName !== repo.name ? repo.displayName : null)
  const chips = repo.health.filter((h) => !GLYPH_RULES.has(h.rule))
  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <Card
      className={`rr-card ${sev}${selected ? " sel" : ""}${repo.archived ? " arch" : ""}`}
      variant="borderless"
      onClick={() => onShowDetail(repo.id)}
    >
      <div className="rr-c-top">
        <span className="rr-c-check">
          <Checkbox checked={selected} onClick={stop} onChange={() => onToggleSelect(repo.id)} />
        </span>
        <button
          className={`rr-c-fav${repo.favorite ? " on" : ""}`}
          onClick={(e) => {
            stop(e)
            onToggleFavorite(repo.id, !repo.favorite)
          }}
          title={repo.favorite ? t("card.favOff") : t("card.favOn")}
        >
          ★
        </button>
        {slot && (
          <span className="rr-c-slot" title={`#${slot}`}>
            {slot}
          </span>
        )}
        <span className="rr-c-name">{baseName}</span>
        {repo.archived && <span className="rr-c-arch">{t("card.excluded")}</span>}
        {repo.language && (
          <button
            className="rr-c-lang"
            title={t("card.filterLang", { lang: repo.language })}
            onClick={(e) => {
              stop(e)
              onQuickFilter(repo.language!)
            }}
          >
            <span className="ld" style={{ background: langColor(repo.language) }} />
            {repo.language}
          </button>
        )}
      </div>

      {repo.note && (
        <div className="rr-c-notetext" title={repo.note}>
          📝 {repo.note}
        </div>
      )}
      {desc && <div className="rr-c-desc">{desc}</div>}

      <div className="rr-c-status">
        {repo.branch === null ? (
          <span className="br det">✖ {t("card.detached")}</span>
        ) : (
          <span className="br">
            ⎇ {repo.branch}
            {isSideBranch(repo.branch) && <span className="side"> ({t("card.nonMain")})</span>}
          </span>
        )}
        {changes === 0 && repo.branch !== null ? (
          <span className="clean">✓ clean</span>
        ) : (
          <>
            {repo.dirty.staged > 0 && <span className="stg">+{repo.dirty.staged}</span>}
            {repo.dirty.unstaged > 0 && <span className="mod">~{repo.dirty.unstaged}</span>}
            {repo.dirty.untracked > 0 && <span className="mod">?{repo.dirty.untracked}</span>}
          </>
        )}
        {repo.ahead > 0 && <span className="ahead">↑{repo.ahead}</span>}
        {repo.behind > 0 && <span className="behind">↓{repo.behind}</span>}
        {repo.ahead === -1 && repo.remotes.length > 0 && <span className="i">{t("card.noUpstream")}</span>}
      </div>

      {(chips.length > 0 || repo.mergedBranches.length > 0) && (
        <div className="rr-c-chips">
          {chips.map((h) => (
            <span key={h.rule} className={`rr-chip ${SEV_CHIP[h.severity]}`} title={h.message}>
              {shortHealth(h)}
            </span>
          ))}
          {repo.mergedBranches.length > 0 && (
            <span className="rr-chip i" title={t("health.cleanBranchesTip", { list: repo.mergedBranches.join("、") })}>
              {t("health.cleanBranches", { n: repo.mergedBranches.length })}
            </span>
          )}
        </div>
      )}

      {/* 弹簧：网格里矮内容的卡片被拉到同排高度时，多余空间吸收在这里——
          「最近提交 + 底部控制条」因此永远锚成页脚，而不是提交行悬在半空 */}
      <div className="rr-c-spring" />
      <div className="rr-c-last">
        {repo.error ? (
          <span className="msg" style={{ color: "var(--crit)" }}>
            {repo.error}
          </span>
        ) : repo.lastCommit ? (
          <>
            <span className="msg">
              <span className="q">“</span>
              {repo.lastCommit.message}
              <span className="q">”</span>
            </span>
            <span className="ago">{relativeTime(repo.lastCommit.date)}</span>
            <CommitPreview repoId={repo.id} changes={changes} />
          </>
        ) : (
          <span className="msg" style={{ color: "var(--dim)" }}>
            {t("card.emptyRepo")}
          </span>
        )}
      </div>

      <div className="rr-c-foot">
        {web && (
          <a className="rem" href={web.url} target="_blank" rel="noreferrer" onClick={stop} title={web.url}>
            {web.label}
          </a>
        )}
        {repo.tags.length > 0 && (
          <span className="tags">
            {repo.tags.map((tag) => (
              <button
                key={tag}
                title={t("card.filterTag", { tag })}
                onClick={(e) => {
                  stop(e)
                  onFilterTag(tag)
                }}
              >
                {tag}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="rr-c-acts" onClick={stop}>
        <div className="rr-c-rail">
          {OPENS.map((o) => (
            <button key={o.key} className="seg" title={t("card.openWith", { label: t(o.tk) })} onClick={() => onOpen(repo.id, o.key)}>
              {t(o.tk)}
            </button>
          ))}
          <button className="seg" title={t("card.copyTip", { path: repo.path })} onClick={() => onCopyPath(repo.path)}>
            {t("card.copy")}
          </button>
        </div>
      </div>
    </Card>
  )
})
