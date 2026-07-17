import { App as AntdApp, Button, Segmented, Select } from "antd"
import { useEffect, useMemo, useRef, useState } from "react"
import { gt, useT } from "../i18n"
import { ymd } from "../lib/time"
import type { WorklogCommit } from "../types"

type Me = { name: string; email: string; emails?: string[] } | null // emails = 各仓库有效邮箱并集（含本地覆盖）
const ALL = "" // 提交人筛选：空串 = 全部

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return ymd(d)
}
// 转义 markdown 行内特殊字符，避免 commit 信息里的 `*_[]#|<>~ 破坏导出格式
const escMd = (s: string) => s.replace(/([\\`*_[\]#|<>~])/g, "\\$1")

const PRESETS = [0, 2, 6, 29] // 今天 / 近3天 / 近7天 / 近30天（含今天）

export function WorklogView({ onOpenRepo }: { onOpenRepo: (id: string) => void }) {
  const t = useT()
  const { message } = AntdApp.useApp()
  const [since, setSince] = useState(() => daysAgo(6))
  const [until, setUntil] = useState(() => ymd(new Date()))
  const [data, setData] = useState<WorklogCommit[] | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [me, setMe] = useState<Me>(null)
  const [author, setAuthor] = useState<string>(ALL) // 选中的提交人邮箱；ALL = 全部
  const authorInited = useRef(false) // 只在首个响应把默认设成「只看我」，之后尊重用户选择

  useEffect(() => {
    // 范围为空（清空了日期框）或反转时别发请求、别卡转圈，直接清成空态
    if (since === "" || until === "" || since > until) {
      setData([])
      setFailed([])
      setError(null)
      return
    }
    setData(null)
    setError(null)
    setFailed([])
    let cancelled = false
    fetch(`/api/worklog?since=${since}&until=${until}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (cancelled) return
        setData(body.commits as WorklogCommit[])
        setFailed((body.failed as string[]) ?? [])
        const m = (body.me as Me) ?? null
        setMe(m)
        if (!authorInited.current) {
          authorInited.current = true
          setAuthor(m?.email ?? ALL) // 默认「只看我」；拿不到 git 身份则退回「全部」
        }
      })
      .catch((err) => !cancelled && setError(gt("worklog.loadFail", { err: String(err) })))
    return () => {
      cancelled = true
    }
  }, [since, until])

  const applyPreset = (n: number) => {
    setSince(daysAgo(n))
    setUntil(ymd(new Date()))
  }
  const activePreset = useMemo(() => {
    if (until !== ymd(new Date())) return -1
    return PRESETS.indexOf(PRESETS.find((n) => daysAgo(n) === since) ?? -1)
  }, [since, until])

  // 提交人下拉：从当前结果按邮箱汇总（去重）；「只看我」与「全部」始终在最前
  const authorOptions = useMemo(() => {
    const byEmail = new Map<string, string>() // email -> name
    for (const c of data ?? []) if (c.authorEmail && !byEmail.has(c.authorEmail)) byEmail.set(c.authorEmail, c.author)
    const opts: { value: string; label: string }[] = [{ value: ALL, label: t("worklog.authorAll") }]
    if (me) opts.push({ value: me.email, label: t("worklog.authorMe") })
    // 除主邮箱外其余仍单列——「只看我」是并集视图（含各仓库本地覆盖的邮箱），但每个邮箱保留可单独查看的入口，
    // 万一某仓库配了别人/bot 的邮箱被并进来，用户还能把它挑出来看
    for (const [email, name] of byEmail) if (email !== me?.email) opts.push({ value: email, label: name || email })
    return opts
  }, [data, me, t])

  // 按选中的提交人（邮箱）筛选；ALL = 不筛。「只看我」按整组邮箱匹配（全局 + 各仓库本地覆盖），
  // 不然本地覆盖了 user.email 的仓库里你的提交会被漏掉
  const shown = useMemo(() => {
    if (author === ALL) return data ?? []
    const mine = me && author === me.email ? new Set(me.emails ?? [me.email]) : new Set([author])
    return (data ?? []).filter((c) => mine.has(c.authorEmail))
  }, [data, author, me])

  // 已按新→旧排序；相邻同一天归组
  const groups = useMemo(() => {
    const gs: [string, WorklogCommit[]][] = []
    for (const c of shown) {
      const day = c.day // 服务端本地时区算好的日期，和范围过滤同一时区
      const last = gs[gs.length - 1]
      if (last && last[0] === day) last[1].push(c)
      else gs.push([day, [c]])
    }
    return gs
  }, [shown])
  const repoCount = useMemo(() => new Set(shown.map((c) => c.repoId)).size, [shown])

  const toMarkdown = () => {
    let s = `# ${t("nav.worklog")} ${since} ~ ${until}\n`
    for (const [day, cs] of groups) {
      s += `\n## ${day}\n`
      for (const c of cs) s += `- **${escMd(c.repoName)}** ${c.time} ${escMd(c.subject)}\n`
    }
    return s
  }
  const copyMd = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown())
      message.success(t("worklog.copied"))
    } catch {
      message.error(t("worklog.copyFail"))
    }
  }

  return (
    <div className="rr-stats rr-worklog">
      <div className="rr-wl-bar">
        <Segmented
          size="small"
          value={activePreset}
          onChange={(v) => applyPreset(PRESETS[v as number])}
          options={PRESETS.map((n, i) => ({ value: i, label: n === 0 ? t("worklog.today") : t("worklog.lastDays", { n: n + 1 }) }))}
        />
        <span className="range">
          {/* 清空日期框会传空串：忽略之，保留原值，避免范围变空导致整片空态 */}
          <input type="date" value={since} max={until} onChange={(e) => e.target.value !== "" && setSince(e.target.value > until ? until : e.target.value)} />
          <span className="sep">~</span>
          <input type="date" value={until} min={since} max={ymd(new Date())} onChange={(e) => e.target.value !== "" && setUntil(e.target.value < since ? since : e.target.value)} />
        </span>
        <Select
          size="small"
          className="rr-wl-author"
          value={author}
          onChange={setAuthor}
          options={authorOptions}
          popupMatchSelectWidth={false}
          style={{ minWidth: 110 }}
        />
        {data !== null && shown.length > 0 && (
          <>
            <span className="sum">{t("worklog.summary", { commits: shown.length, repos: repoCount, days: groups.length })}</span>
            <Button size="small" onClick={copyMd} style={{ marginLeft: "auto" }}>
              {t("worklog.copyMd")}
            </Button>
          </>
        )}
      </div>

      {failed.length > 0 && <div className="rr-wl-warn">⚠ {t("worklog.partial", { n: failed.length, names: failed.join("、") })}</div>}
      {error ? (
        <div className="rr-empty err">{error}</div>
      ) : data === null ? (
        <div className="rr-empty">{t("worklog.loading")}</div>
      ) : shown.length === 0 ? (
        <div className="rr-empty">{t("worklog.empty")}</div>
      ) : (
        groups.map(([day, cs]) => (
          <section key={day} className="rr-wl-day">
            <div className="rr-ghd">
              <span className="nm">{day}</span>
              <span className="ct">{cs.length}</span>
              <span className="ln" />
            </div>
            {cs.map((c) => (
              <div className="rr-wl-row" key={`${c.repoId}-${c.hash}`}>
                <span className="time">{c.time}</span>
                <button type="button" className="repo rr-repo-clk" onClick={() => onOpenRepo(c.repoId)} title={t("common.openRepoTip")}>
                  {c.repoName}
                </button>
                <span className="msg" title={c.subject}>
                  {c.subject}
                </span>
                <span className="hash">{c.hash}</span>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  )
}
