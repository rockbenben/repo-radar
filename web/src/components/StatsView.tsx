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
  // 上面那排读数讲的是**提交**（热力图、活跃天数），所以「空仓库」按有没有提交过判：
  // git init 完写了两个文件的目录工作区是有 mtime 的，拿活跃口径判会把它算成活跃仓库
  const nonEmpty = activity.filter((a) => a.lastCommitDate !== null)
  const empty = activity.length - nonEmpty.length
  // 下面两个榜单按**活跃**筛，与看板卡片的排序同一口径——两处的标题在 18 种语言里逐字相同
  // （sort.activity 与 stats.recentActive）。用提交口径筛的话，两块地方对同一个仓库给出不同
  // 答案，而榜单照样凑满 15 行，看不出少了谁。
  //
  // 注意举例时别拿「git init 之后还没提交、改了一整天」当典型：那种仓库整棵树是一条
  // `? src/`，worktreeTouchedAt 只能取到目录 mtime——新建/删除文件算数，改文件内容不算
  // （见 git.ts worktreeTouchedAt 的少报清单）。它仍然属于这里要照顾的一类，只是不完整
  const dated = activity.filter((a) => a.lastActivityDate !== null)
  const top = dated.slice(0, 15)
  const topIds = new Set(top.map((a) => a.id))
  const stale = dated
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
      <span className="ago">{a.lastActivityDate ? relativeTime(a.lastActivityDate) : t("stats.emptyRepo")}</span>
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
        {/* legend 不能只给详情面板那张小图：这张才是主图（371 格、五档绿），
            没有色阶说明的话深浅只是装饰，读者无从判断"深一点"到底多多少 */}
        <Heatmap days={days} legend />
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
