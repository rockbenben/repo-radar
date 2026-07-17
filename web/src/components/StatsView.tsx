import { useEffect, useState } from "react"
import { gt, useT } from "../i18n"
import { relativeTime } from "../lib/time"
import type { ActivityItem, HeatmapDay } from "../types"
import { Heatmap } from "./Heatmap"

export function StatsView({ onOpenRepo }: { onOpenRepo: (id: string) => void }) {
  const t = useT()
  const [days, setDays] = useState<HeatmapDay[] | null>(null)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0) // 失败后手动重试：自增触发重取

  useEffect(() => {
    let cancelled = false
    setError(null)
    setDays(null)
    setActivity(null)
    Promise.all([
      fetch("/api/stats/heatmap?days=365").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      fetch("/api/stats/activity").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ])
      .then(([heat, act]) => {
        if (cancelled) return
        setDays(heat.days)
        setActivity(act.repos)
      })
      .catch((err) => !cancelled && setError(gt("stats.loadFail", { err: String(err) })))
    // 依赖 reload：挂载时取一次，失败后点「重试」再取（不把 t 放进依赖，避免切主题/语言时重复请求）
    return () => {
      cancelled = true
    }
  }, [reload])

  if (error)
    return (
      <div className="rr-empty err">
        {error}
        <button type="button" className="rr-retry" onClick={() => setReload((n) => n + 1)}>
          {t("common.retry")}
        </button>
      </div>
    )
  if (days === null || activity === null) return <div className="rr-empty">{t("stats.loading")}</div>

  const total = days.reduce((sum, d) => sum + d.count, 0)
  const activeDays = days.filter((d) => d.count > 0).length
  const nonEmpty = activity.filter((a) => a.lastCommitDate !== null)
  const empty = activity.length - nonEmpty.length
  const top = nonEmpty.slice(0, 15)
  const topIds = new Set(top.map((a) => a.id))
  const stale = nonEmpty
    .filter((a) => !topIds.has(a.id))
    .slice(-10)
    .reverse()

  const gauge = (v: number | string, k: string, cls = "") => (
    <span className="cell">
      <span className={`v${cls ? ` ${cls}` : ""}`}>{v}</span>
      <span className="k">{k}</span>
    </span>
  )
  const row = (a: ActivityItem, i: number) => (
    <button key={a.id} type="button" className="r rr-r-clk" onClick={() => onOpenRepo(a.id)} title={t("common.openRepoTip")}>
      <span className="rank">{i + 1}</span>
      <span className="nm">{a.displayName ?? a.name}</span>
      <span className="ago">{a.lastCommitDate ? relativeTime(a.lastCommitDate) : t("stats.emptyRepo")}</span>
    </button>
  )

  return (
    <div className="rr-stats">
      <div className="rr-readout rr-stat-gauges">
        {gauge(total, t("stats.commits"), "sig")}
        {gauge(activeDays, t("stats.activeDays"))}
        {gauge(nonEmpty.length, t("stats.activeRepos"), "ok")}
        {gauge(empty, t("stats.emptyRepos"), empty > 0 ? "dim" : "")}
        {gauge(activity.length, t("stats.totalRepos"))}
      </div>

      <section style={{ marginBottom: 28 }}>
        <h2>{t("stats.heatmapTitle")}</h2>
        <Heatmap days={days} />
      </section>
      <div style={{ display: "grid", gap: 28, gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
        <section>
          <h2>{t("stats.recentActive")}</h2>
          <div className="rr-actlist">{top.map(row)}</div>
        </section>
        <section>
          <h2>{t("stats.staleTop")}</h2>
          <div className="rr-actlist">{stale.map(row)}</div>
        </section>
      </div>
    </div>
  )
}
