import { App as AntdApp, Button, Dropdown, Input, Modal, Popover, Segmented, Select, Switch } from "antd"
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CockpitHero, GITHUB_KINDS, type QueueItem } from "./components/CockpitHero"
import { CommandPalette } from "./components/CommandPalette"
import { DetailPanel } from "./components/DetailPanel"
import { RepoCard } from "./components/RepoCard"
import { ScopeMark } from "./components/ScopeMark"
import { StashView } from "./components/StashView"
import { StatsView } from "./components/StatsView"
import { WorklogView } from "./components/WorklogView"
import { LANGS, useI18n } from "./i18n"
import { applyFilter, type FilterState } from "./lib/filter"
import { daysSince, isGithubUrl } from "./lib/meta"
import { mergeRepo } from "./lib/repos"
import { connectEvents, type ServerEvent } from "./lib/ws"
import type { BatchProgress, BatchResultItem, RepoStatus } from "./types"

const JSON_HEADERS = { "content-type": "application/json" }
const REPO_URL = "https://github.com/rockbenben/repo-radar" // 顶栏 GitHub 链接（与 package.json repository 一致）

const days = (d?: string | null): number => daysSince(d ?? null) ?? 0
const RELEASE_MIN_AHEAD = 3 // 发版雷达：tag 之后堆到几个提交才提醒（刚发完版提交一两个别急着烦人）
const STASH_MIN_DAYS = 7 // stash 搁几天才提醒
const STASH_SNOOZE_MS = 30 * 86_400_000 // stash「已处理」是打盹不是消除：30 天后再提醒（不然真忘了的那条永远不响）
// 「已处理」三种失效规则：
// 计数类（PR/issue/落后/未推/未发版）——存当时数量，只在「更多（来了新的）」时重现；
// stash——打盹：存点击时间，30 天到点重响；HEAD 类（没提交/冲突/CI）——存 HEAD hash，提交一次才重评。
const COUNT_KINDS = new Set(["pr", "issue", "behind", "unpushed", "release"])

// 计数类问题的当前数量——「已处理」清理时用来给水位降档
function kindCount(r: RepoStatus, kind: string): number {
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
const activeRelease = (r: RepoStatus) => (r.release && r.release.ahead >= RELEASE_MIN_AHEAD ? r.release : null)
const activeStashDays = (r: RepoStatus): number | null => {
  if (r.stashCount === 0) return null
  const d = days(r.stashOldest)
  return d >= STASH_MIN_DAYS ? d : null
}

// 某仓库的某类「待处理」问题当前是否仍成立——用于清理已解决的「已处理」记录（解决即清，别压制之后的新情况）。
// 计数类直接委托 kindCount（同一映射，别再抄一份数字来源）；release 例外——它的「成立」带阈值。
function issueActive(r: RepoStatus, kind: string): boolean {
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

// 记住显示选项（每浏览器）；搜索词与告警筛选不持久化，刷新即清空
const pref = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`rr.${key}`) ?? fallback
  } catch {
    return fallback
  }
}
const savePref = (key: string, value: string) => {
  try {
    localStorage.setItem(`rr.${key}`, value)
  } catch {
    /* localStorage 不可用时静默 */
  }
}

type AttentionKey = "no-remote" | "detached" | "unpushed" | "dirty" | "behind" | "stash"
const ATTENTION: { key: AttentionKey; labelKey: string; sev: "crit" | "warn" | "" ; test: (r: RepoStatus) => boolean }[] = [
  { key: "no-remote", labelKey: "lamp.noRemote", sev: "crit", test: (r) => r.remotes.length === 0 },
  { key: "detached", labelKey: "lamp.detached", sev: "crit", test: (r) => r.branch === null },
  { key: "unpushed", labelKey: "lamp.unpushed", sev: "warn", test: (r) => r.ahead > 0 },
  { key: "dirty", labelKey: "lamp.dirty", sev: "warn", test: (r) => r.dirty.staged + r.dirty.unstaged + r.dirty.untracked > 0 },
  { key: "behind", labelKey: "lamp.behind", sev: "warn", test: (r) => r.behind > 0 },
  { key: "stash", labelKey: "lamp.stash", sev: "", test: (r) => r.stashCount > 0 },
]
// 可一键批量处理的告警类型 → 对应的 git 操作
const LAMP_OP: Partial<Record<AttentionKey, "push" | "pull">> = { unpushed: "push", behind: "pull" }

// 保存的视图：一套命名的筛选 + 排序 + 分组组合
type SavedView = {
  name: string
  query: string
  group: string | null
  sort: FilterState["sort"]
  groupMode: "folder" | "language" | "none"
  attention: AttentionKey | null
  tags?: string[]
}
const loadViews = (): SavedView[] => {
  try {
    return JSON.parse(localStorage.getItem("rr.views") ?? "[]") as SavedView[]
  } catch {
    return []
  }
}

// 操作日志（客户端滚动记录）
type LogEntry = { t: number; ok: boolean; text: string }
const loadLog = (): LogEntry[] => {
  try {
    return JSON.parse(localStorage.getItem("rr.log") ?? "[]") as LogEntry[]
  } catch {
    return []
  }
}

export default function App({
  themeMode,
  onToggleTheme,
}: {
  themeMode: "dark" | "light"
  onToggleTheme: () => void
}) {
  const { message, modal } = AntdApp.useApp()
  const { t, lang, setLang } = useI18n()
  const [repos, setRepos] = useState<RepoStatus[]>([])
  const [scanning, setScanning] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterState>(() => ({
    query: "",
    group: null,
    sort: pref("sort", "activity") as FilterState["sort"],
    severity: null,
    tags: [],
  }))
  const [attention, setAttention] = useState<AttentionKey | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState<BatchProgress | null>(null)
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total: number } | null>(null)
  const [view, setView] = useState<"board" | "stats" | "log" | "worklog">(() => pref("view", "board") as "board" | "stats" | "log" | "worklog")
  const [log, setLog] = useState<LogEntry[]>(loadLog)
  const addLog = (ok: boolean, text: string) =>
    setLog((prev) => [{ t: Date.now(), ok, text }, ...prev].slice(0, 80))
  const [groupMode, setGroupMode] = useState<"folder" | "language" | "none">(
    () => pref("group", "none") as "folder" | "language" | "none",
  )
  const [showArchived, setShowArchived] = useState(() => pref("arch", "0") === "1")
  const [showStash, setShowStash] = useState(false) // 跨仓库 stash 收纳箱子视图（不持久化，刷新即回看板）
  const [batchTag, setBatchTag] = useState("")
  const [execCmd, setExecCmd] = useState("")
  const [execResultOpen, setExecResultOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [autoWatch, setAutoWatch] = useState(false) // 文件监听实时刷新（服务端持久化，默认关）
  const [autoFetchMin, setAutoFetchMin] = useState(0) // 定时后台 fetch 间隔（分钟，0=关）
  const [notify, setNotify] = useState(() => pref("notify", "0") === "1")
  const notified = useRef(false)
  const manifestFileRef = useRef<HTMLInputElement>(null)
  const [bootAnim, setBootAnim] = useState(false) // 初次载入时的开机错峰淡入（仅一次，不在筛选/刷新时重播）
  const bootedRef = useRef(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newParent, setNewParent] = useState("")
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [views, setViews] = useState<SavedView[]>(loadViews)
  const [viewName, setViewName] = useState<string | null>(null)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [newViewName, setNewViewName] = useState("")
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState("")
  const [cloneParent, setCloneParent] = useState("")
  const [cloning, setCloning] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailRepo = detailId !== null ? (repos.find((r) => r.id === detailId) ?? null) : null
  const [cockpitOpen, setCockpitOpen] = useState(() => pref("cockpit", "1") === "1")
  useEffect(() => savePref("cockpit", cockpitOpen ? "1" : "0"), [cockpitOpen])
  // 「待处理」里被点过「已处理」的项：key=repoId:kind → 当时的状态签名。签名不变则保持隐藏，一旦有新变化（签名变）就再冒出来
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("rr.dismissed") ?? "{}") as Record<string, string>
    } catch {
      return {}
    }
  })
  useEffect(() => localStorage.setItem("rr.dismissed", JSON.stringify(dismissed)), [dismissed])
  // 清理「已处理」记录（key 形如 repoId:kind）：仓库已删、或该类问题已不成立（归 0 / CI 转绿 / 丢弃）都清掉——
  // 既防无限堆积，也保证问题解决后残留的旧值不会压制之后的新情况（如推空后又新提交、丢弃后又改动）。
  useEffect(() => {
    if (repos.length === 0) return
    const byId = new Map(repos.map((r) => [r.id, r]))
    setDismissed((d) => {
      const next: Record<string, string> = {}
      let changed = false
      for (const [k, v] of Object.entries(d)) {
        const sep = k.indexOf(":")
        const r = byId.get(k.slice(0, sep))
        if (!r) {
          changed = true // 仓库已删：清
          continue
        }
        const kind = k.slice(sep + 1)
        // 状态「未知」时不清，只在「确认已解决」时清——扫描瞬时出错（error 状态把计数全归零）
        // 或「有 GitHub 远程但还没拉到」（inbox 为 null）都不代表问题解决了，据此清会把用户的已处理/打盹一把抹光。
        // 但压根没有 GitHub 远程的仓库 inbox 恒为 null——那是「确认不存在」不是「未知」，旧记录该清（防永久堆积）
        const unknown = r.error !== null || (GITHUB_KINDS.has(kind) && r.githubInbox === null && r.remotes.some((rm) => isGithubUrl(rm.url)))
        if (unknown) {
          next[k] = v
          continue
        }
        if (!issueActive(r, kind)) {
          changed = true // 确认已解决：清
          continue
        }
        // 计数类：数量掉下去后把水位跟着降——「3 个 PR」已处理、合掉 2 个只剩 1，之后来 1 个新的（2>1）
        // 必须能冒出来；不降水位的话要涨过旧高点 3 才重现，违背「来了新的就回来」
        const cur = COUNT_KINDS.has(kind) ? kindCount(r, kind) : null
        if (cur !== null && cur < Number(v)) {
          next[k] = String(cur)
          changed = true
        } else {
          next[k] = v
        }
      }
      return changed ? next : d
    })
  }, [repos])
  // 单仓库同步的完成回执：按 taskId 挂起 Promise，收到该任务的 batch:progress(finished) 时兑现，供弹窗就地显示结果
  const syncResolvers = useRef(new Map<string, (r: BatchResultItem | null) => void>())
  const finishedBatches = useRef(new Map<string, BatchProgress>()) // 已完成任务（按 taskId）；兜住「完成事件早于 POST 返回」的竞态，单槽会被并发批量覆盖
  // 从统计/工作记录点某个项目：切回看板并打开它的详情面板（仓库已不在列表则忽略）
  const showRepoDetail = (id: string) => {
    if (!repos.some((r) => r.id === id)) return
    setView("board")
    setDetailId(id)
  }

  async function rescan() {
    setScanning(true)
    notified.current = false // 每次显式重扫后可再次提醒
    try {
      const res = await fetch("/api/scan", { method: "POST" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLoadError(null)
      const data = (await res.json()) as RepoStatus[]
      setRepos(data)
      setSelected((s) => new Set([...s].filter((id) => data.some((r) => r.id === id))))
    } catch (err) {
      setLoadError(t("msg.loadError", { err: String(err) }))
      addLog(false, t("msg.scanFail", { err: String(err) }))
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }

  useEffect(() => {
    rescan()
    const handler = (e: ServerEvent) => {
      if (e.type === "repo:updated") setRepos((rs) => mergeRepo(rs, e.payload.repo))
      else if (e.type === "batch:progress") {
        setBatch(e.payload)
        if (e.payload.finished) {
          // 已完成任务按 taskId 各存一份（单槽会被并发批量互相覆盖，漏掉「完成早于 POST 返回」的回执）；上限防增长
          finishedBatches.current.set(e.payload.taskId, e.payload)
          if (finishedBatches.current.size > 30) finishedBatches.current.delete(finishedBatches.current.keys().next().value!)
          // 兑现等待该任务的弹窗同步 Promise（单仓库任务只有一条结果）
          const resolve = syncResolvers.current.get(e.payload.taskId)
          if (resolve) {
            syncResolvers.current.delete(e.payload.taskId)
            resolve(e.payload.results[0] ?? null)
          }
          const f = e.payload.results.filter((r) => !r.ok)
          addLog(
            f.length === 0,
            t("batch.done", { action: e.payload.action, ok: e.payload.results.length - f.length }) +
              (f.length ? t("batch.doneFail", { n: f.length, names: f.map((x) => x.name).join("、") }) : ""),
          )
        }
      } else if (e.type === "scan:progress") setScanProgress(e.payload.scanned >= e.payload.total ? null : e.payload)
    }
    return connectEvents(handler, () => {
      void fetch("/api/repos")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: RepoStatus[] | null) => {
          if (data) setRepos(data)
        })
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // 仓库首次出现时播一次"开机"错峰淡入；bootedRef 确保只此一次
  useEffect(() => {
    if (!bootedRef.current && repos.length > 0) {
      bootedRef.current = true
      setBootAnim(true)
      const t = setTimeout(() => setBootAnim(false), 900)
      return () => clearTimeout(t)
    }
  }, [repos])

  useEffect(() => savePref("sort", filter.sort), [filter.sort])
  useEffect(() => savePref("view", view), [view])
  useEffect(() => savePref("group", groupMode), [groupMode])
  useEffect(() => savePref("arch", showArchived ? "1" : "0"), [showArchived])
  useEffect(() => savePref("notify", notify ? "1" : "0"), [notify])
  useEffect(() => savePref("views", JSON.stringify(views)), [views])
  useEffect(() => savePref("log", JSON.stringify(log)), [log])

  const applyView = (v: SavedView) => {
    setFilter({ query: v.query, group: v.group, sort: v.sort, severity: null, tags: v.tags ?? [] })
    setGroupMode(v.groupMode)
    setAttention(v.attention)
    setViewName(v.name)
  }
  const saveCurrentView = (name: string) => {
    const v: SavedView = { name, query: filter.query, group: filter.group, sort: filter.sort, groupMode, attention, tags: filter.tags ?? [] }
    setViews((prev) => [...prev.filter((x) => x.name !== name), v])
    setViewName(name)
  }
  const deleteView = (name: string) => {
    setViews((prev) => prev.filter((x) => x.name !== name))
    if (viewName === name) setViewName(null)
  }

  async function runBatch(action: "fetch" | "pull" | "push", ids: string[]) {
    if (ids.length === 0) return
    await fetch("/api/batch", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action, repoIds: ids }) })
  }

  // 单仓库同步：起一个任务并等它真正跑完（靠 batch:progress WS 回执兑现），供弹窗就地显示「进行中 → ✓/✗」
  async function syncOne(id: string, action: "fetch" | "pull" | "push"): Promise<BatchResultItem | null> {
    let res: Response
    try {
      res = await fetch(`/api/repos/${id}/${action}`, { method: "POST", headers: JSON_HEADERS, body: "{}" })
    } catch (err) {
      return { repoId: id, name: "", ok: false, message: String(err) }
    }
    if (!res.ok) return { repoId: id, name: "", ok: false, message: `HTTP ${res.status}` }
    const { taskId } = (await res.json()) as { taskId: string }
    // 完成事件可能比 POST 响应先到（WS 与 HTTP 是两条通道）：先查已完成任务表，命中同 taskId 就直接返回。
    // 下面注册 resolver 与这次判断在同一同步执行段内，中间不会插入新的 WS 事件，故无遗漏窗口。
    const fb = finishedBatches.current.get(taskId)
    if (fb) {
      finishedBatches.current.delete(taskId) // 用过即清
      return fb.results[0] ?? null
    }
    return new Promise((resolve) => {
      // 兜底超时：万一没收到回执（WS 断连等），60s 后按 null 收场，避免弹窗一直转圈
      const timer = setTimeout(() => {
        syncResolvers.current.delete(taskId)
        resolve(null)
      }, 60_000)
      syncResolvers.current.set(taskId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  async function runExec(dryRun: boolean) {
    const command = execCmd.trim()
    const ids = [...selected]
    if (command === "" || ids.length === 0) return
    try {
      const r = await fetch("/api/exec", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ command, repoIds: ids, dryRun }) })
      if (!r.ok) throw new Error()
      addLog(true, t("msg.execLog", { mode: dryRun ? t("msg.execDry") : t("msg.execRun"), n: ids.length, cmd: command }))
    } catch {
      message.error(t("msg.execFail"))
    }
  }

  const openRepo = useCallback(async (id: string, target: "editor" | "terminal" | "explorer") => {
    try {
      const res = await fetch(`/api/repos/${id}/open`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ target }) })
      // 端点回传更新后的仓库（含新的 lastOpened），合并以便「最近打开」排序即时生效
      if (res.ok) {
        const updated = (await res.json()) as RepoStatus | { ok: true }
        if ("id" in updated) setRepos((rs) => mergeRepo(rs, updated))
      }
    } catch {
      // 打开是本机副作用，网络异常时静默
    }
  }, [])

  async function exportManifest() {
    try {
      const r = await fetch("/api/manifest")
      if (!r.ok) throw new Error()
      const data = (await r.json()) as { repos: unknown[] }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "repo-radar-manifest.json"
      a.click()
      URL.revokeObjectURL(url)
      addLog(true, t("msg.exportOk", { n: data.repos.length }))
      message.success(t("msg.exportOk", { n: data.repos.length }))
    } catch {
      message.error(t("msg.exportFail"))
    }
  }
  async function importManifestFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许再次选同一文件
    if (!file) return
    try {
      const manifest = JSON.parse(await file.text())
      const r = await fetch("/api/manifest/import", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ manifest }) })
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? `HTTP ${r.status}`) // catch 会拼进 msg.importFail 前缀，这里给中性技术兜底而非硬编码中文
      }
      const s = (await r.json()) as { added: number; alreadyTracked: number; missing: { name: string; remote: string | null }[] }
      message.success(
        t("msg.importOk", { added: s.added, tracked: s.alreadyTracked }) +
          (s.missing.length ? t("msg.importOffMachine", { n: s.missing.length }) : ""),
      )
      if (s.missing.length > 0) {
        modal.info({
          title: t("modal.importMissingTitle", { n: s.missing.length }),
          content: (
            <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
              <div style={{ color: "var(--dim)", fontSize: 12, marginBottom: 8 }}>{t("modal.importMissingHint")}</div>
              {s.missing.map((m) => (
                <div key={m.name} className="mono" style={{ fontSize: 12, padding: "2px 0" }}>
                  {m.name}
                  {m.remote ? <span style={{ color: "var(--sig)" }}> · {m.remote}</span> : <span style={{ color: "var(--dim)" }}> · {t("modal.noRemote")}</span>}
                </div>
              ))}
            </div>
          ),
        })
      }
      if (s.added > 0) rescan()
    } catch (err) {
      message.error(t("msg.importFail", { err: err instanceof Error ? err.message : "format error" }))
    }
  }

  const copyPath = useCallback(
    (path: string) => {
      navigator.clipboard?.writeText(path).then(
        () => message.success(t("msg.copied")),
        () => message.error(t("msg.copyFail")),
      )
    },
    [message, t],
  )

  const patchMeta = useCallback(
    async (id: string, patch: { favorite?: boolean; tags?: string[]; group?: string | null; note?: string | null; archived?: boolean }) => {
      try {
        const res = await fetch(`/api/repos/${id}/meta`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) })
        if (!res.ok) return
        const updated = (await res.json()) as RepoStatus
        setRepos((rs) => mergeRepo(rs, updated))
      } catch {
        // 静默：保持原状
      }
    },
    [],
  )
  // 卡片专用的稳定回调（配合 RepoCard 的 memo，避免每次渲染换新函数使 memo 失效）
  const toggleFavorite = useCallback((id: string, next: boolean) => patchMeta(id, { favorite: next }), [patchMeta])
  const quickFilter = useCallback((term: string) => setFilter((f) => ({ ...f, query: term })), [])
  const filterTag = useCallback(
    (tag: string) => setFilter((f) => ({ ...f, tags: (f.tags ?? []).includes(tag) ? f.tags : [...(f.tags ?? []), tag] })),
    [],
  )

  function openNewProject() {
    // 建议下一个 365 编号 + 沿用现有编号项目的父目录
    const numbered = repos.filter((r) => /^\d{3}-/.test(r.name))
    if (numbered.length > 0) {
      const max = Math.max(...numbered.map((r) => Number(r.name.slice(0, 3))))
      const sample = numbered[0]
      setNewParent(sample.path.slice(0, sample.path.length - sample.name.length - 1))
      setNewName(`${String(max + 1).padStart(3, "0")}-`)
    } else {
      setNewParent("")
      setNewName("")
    }
    setNewOpen(true)
  }

  async function submitNewProject() {
    if (!newParent.trim() || !newName.trim()) {
      message.warning(t("msg.fillParentName"))
      return
    }
    setCreating(true)
    try {
      const res = await fetch("/api/new-project", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ parent: newParent.trim(), name: newName.trim() }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        message.error(data.error ?? t("msg.createFail"))
        return
      }
      message.success(t("msg.createOk", { name: newName.trim() }))
      addLog(true, t("msg.createLog", { name: newName.trim() }))
      setNewOpen(false)
      await rescan()
    } catch (err) {
      message.error(`${t("msg.createFail")}: ${String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  function commonParent(): string {
    const numbered = repos.filter((r) => /^\d{3}-/.test(r.name))
    if (numbered.length === 0) return ""
    const s = numbered[0]
    return s.path.slice(0, s.path.length - s.name.length - 1)
  }
  function openClone() {
    setCloneParent(commonParent())
    setCloneUrl("")
    setCloneOpen(true)
  }
  async function submitClone() {
    if (!cloneUrl.trim() || !cloneParent.trim()) {
      message.warning(t("msg.fillUrlParent"))
      return
    }
    setCloning(true)
    try {
      const res = await fetch("/api/clone", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ url: cloneUrl.trim(), parent: cloneParent.trim() }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        message.error(data.error ?? t("msg.cloneFail"))
        return
      }
      message.success(t("msg.cloneOk"))
      addLog(true, t("msg.cloneLog", { url: cloneUrl.trim() }))
      setCloneOpen(false)
      await rescan()
    } catch (err) {
      message.error(`${t("msg.cloneFail")}: ${String(err)}`)
    } finally {
      setCloning(false)
    }
  }

  async function toggleNotify() {
    const next = !notify
    setNotify(next)
    notified.current = false
    if (next && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission()
    }
  }

  // 自动化开关状态存服务端 config（autoWatch 文件监听、autoFetchMinutes 定时拉取），均默认关闭
  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!c) return
        setAutoWatch(!!c.autoWatch)
        setAutoFetchMin(typeof c.autoFetchMinutes === "number" ? c.autoFetchMinutes : 0)
      })
      .catch(() => {})
  }, [])
  async function toggleWatch() {
    const next = !autoWatch
    setAutoWatch(next)
    try {
      const r = await fetch("/api/watch", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ enabled: next }) })
      if (!r.ok) throw new Error()
      message.success(next ? t("msg.watchOn") : t("msg.watchOff"))
    } catch {
      setAutoWatch(!next) // 失败回滚
      message.error(t("msg.watchFail"))
    }
  }
  async function changeAutoFetch(minutes: number) {
    const prev = autoFetchMin
    setAutoFetchMin(minutes)
    try {
      const r = await fetch("/api/auto-fetch", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes }) })
      if (!r.ok) throw new Error()
      message.success(minutes > 0 ? t("msg.fetchOn", { n: minutes }) : t("msg.fetchOff"))
    } catch {
      setAutoFetchMin(prev) // 失败回滚
      message.error(t("msg.fetchFail"))
    }
  }

  const toggleSelect = useCallback(
    (id: string) =>
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )

  const groups = useMemo(() => [...new Set(repos.map((r) => r.group))].sort(), [repos])
  const allTags = useMemo(() => [...new Set(repos.flatMap((r) => r.tags))].sort(), [repos])
  const active = useMemo(() => repos.filter((r) => !r.archived), [repos])

  // 搁置提醒：开启后，每次显式重扫若有未推送 / 改动搁置≥7天，弹一次桌面通知
  useEffect(() => {
    if (!notify || notified.current || active.length === 0) return
    if (!("Notification" in window) || Notification.permission !== "granted") return
    const unpushed = active.filter((r) => r.ahead > 0).length
    const staleDirty = active.filter((r) => {
      const changes = r.dirty.staged + r.dirty.unstaged + r.dirty.untracked
      if (changes === 0 || !r.lastCommit) return false
      return (Date.now() - new Date(r.lastCommit.date).getTime()) / 86_400_000 >= 7
    }).length
    if (unpushed === 0 && staleDirty === 0) return
    notified.current = true
    const parts: string[] = []
    if (unpushed) parts.push(t("notify.unpushed", { n: unpushed }))
    if (staleDirty) parts.push(t("notify.staleDirty", { n: staleDirty }))
    new Notification(t("notify.title"), { body: parts.join(" · "), icon: "/favicon.svg" })
  }, [notify, active, t])
  const counts = useMemo(() => {
    const crit = active.filter((r) => r.error !== null || r.health.some((h) => h.severity === "error")).length
    const warn = active.filter((r) => r.health.some((h) => h.severity === "warn")).length
    const attn = Object.fromEntries(ATTENTION.map((a) => [a.key, active.filter(a.test).length])) as Record<AttentionKey, number>
    return { fleet: active.length, crit, warn, clean: active.length - crit - warn, attn, archived: repos.length - active.length }
  }, [active, repos])
  const stashTotal = useMemo(() => active.reduce((s, r) => s + r.stashCount, 0), [active])

  const dismissKey = (q: { r: RepoStatus; kind: string }) => `${q.r.id}:${q.kind}`
  // ci 按「远程默认分支 oid」记（CI 红是远端条件，按本地 HEAD 记的话别人推新提交触发的新失败永远不重现）；
  // 缓存还没有 ciSha 时存哨兵 "0"——绝不落本地 hash：oid 下一轮到达时会和本地 hash 对不上，
  // 刚点的已处理会无故复活（迁移重现）。哨兵语义见 isDismissed。
  const dismissVal = (q: { r: RepoStatus; kind: string; n: number }) =>
    q.kind === "stash"
      ? String(Date.now())
      : q.kind === "ci"
        ? (q.r.githubInbox?.ciSha ?? "0")
        : COUNT_KINDS.has(q.kind)
          ? String(q.n)
          : (q.r.lastCommit?.hash ?? "0")
  const isDismissed = (q: { r: RepoStatus; kind: string; n: number }): boolean => {
    const stored = dismissed[dismissKey(q)]
    if (stored === undefined) return false
    if (q.kind === "stash") return Date.now() - Number(stored) < STASH_SNOOZE_MS
    // ci 的哨兵记录（点已处理时还没拿到 oid）：这轮红持续期间保持已处理，转绿由清理 effect 收走；
    // 只对存量哨兵如此——现在 oid 随轮询必达，新点的已处理都按 oid 记、新失败照常重现
    if (q.kind === "ci" && stored === "0") return true
    return COUNT_KINDS.has(q.kind) ? q.n <= Number(stored) : stored === dismissVal(q)
  }
  // 10 分钟心跳：stash 打盹到期等纯时间条件也能在长开的标签页里重评（否则没有 repo 更新就永远不重算）
  const [queueTick, setQueueTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setQueueTick((v) => v + 1), 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [])
  // 每分钟钟摆：传给 memo 化的卡片，让「5 分钟前」这类相对时间在长开页面里持续走动
  // （memo 后没有 repo:updated 的卡片不再随 App 重渲，时间标签会冻住）
  const [clockTick, setClockTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClockTick((v) => v + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  // 该你了：按紧迫度排的跨仓库行动队列。每个仓库列出全部问题、取「第一条没被已处理的」——
  // 不是取最紧迫那条再过滤：那样把 PR 点了已处理，会连带藏掉同仓库排位更低的冲突/落后等仍在的问题。
  // 「等我的」（CI 红 / PR / issue）> 「要丢的活」（冲突/落后/没提交/没推）>「该交付的」（该发版）>「快忘的」（stash 搁置）。
  const actionQueueVisible = useMemo(() => {
    return active
      .map((r) => {
        const dirty = r.dirty.staged + r.dirty.unstaged + r.dirty.untracked
        const age = days(r.lastCommit?.date)
        const gh = r.githubInbox
        const cands: QueueItem[] = []
        // 等我的（GitHub）
        if (gh?.ciFailed) cands.push({ r, sev: "crit", kind: "ci", n: 0, age, score: 20000 })
        if (gh && gh.prs > 0) cands.push({ r, sev: "warn", kind: "pr", n: gh.prs, age, score: 9000 })
        if (r.dirty.conflicted > 0) cands.push({ r, sev: "crit", kind: "conflict", n: r.dirty.conflicted, age, score: 8000 })
        if (gh && gh.issues > 0) cands.push({ r, sev: "warn", kind: "issue", n: gh.issues, age, score: 7000 })
        // 要丢的活（本地）
        if (r.behind > 0) cands.push({ r, sev: "warn", kind: "behind", n: r.behind, age, score: 5000 })
        if (dirty > 0) cands.push({ r, sev: "warn", kind: "dirty", n: dirty, age, score: 2000 + age })
        if (r.ahead > 0) cands.push({ r, sev: "warn", kind: "unpushed", n: r.ahead, age, score: 1000 + age })
        // 该发版了：有 tag 习惯的仓库，tag 之后堆了提交却一直不发（age = 距上个 tag 的天数）
        const rel = activeRelease(r)
        if (rel) {
          const d = days(rel.tagDate)
          cands.push({ r, sev: "warn", kind: "release", n: rel.ahead, age: d, score: 600 + Math.min(d, 300) })
        }
        // stash 搁着快忘了（age = 最老一条搁的天数）
        const stashDays = activeStashDays(r)
        if (stashDays !== null) cands.push({ r, sev: "warn", kind: "stash", n: r.stashCount, age: stashDays, score: 100 + Math.min(stashDays, 450) })
        return cands.find((q) => !isDismissed(q)) ?? null
      })
      .filter((x): x is QueueItem => x !== null)
      .sort((a, b) => b.score - a.score)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, dismissed, queueTick])
  const dismissItem = (q: { r: RepoStatus; kind: string; n: number }) => setDismissed((d) => ({ ...d, [dismissKey(q)]: dismissVal(q) }))

  // 默认只看未排除的；「已排除」开关切换为只看被排除的那些（便于管理 / 取消排除）
  const excluded = useMemo(() => repos.filter((r) => r.archived), [repos])
  const base = showArchived ? excluded : active
  const filtered = useMemo(() => applyFilter(base, filter), [base, filter])
  const visible = useMemo(() => {
    if (!attention) return filtered
    const test = ATTENTION.find((a) => a.key === attention)!.test
    return filtered.filter(test)
  }, [filtered, attention])
  const sections = useMemo(() => {
    if (groupMode === "none") return null // 不分组：所有仓库平铺一个网格
    const keyOf = groupMode === "language" ? (r: RepoStatus) => r.language ?? t("group.unidentified") : (r: RepoStatus) => r.group
    const byKey = new Map<string, RepoStatus[]>()
    for (const r of visible) {
      const k = keyOf(r)
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
    }
    return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [visible, groupMode])
  const failed = batch?.results.filter((r) => !r.ok) ?? []

  const renderCard = (r: RepoStatus) => (
    <RepoCard
      key={r.id}
      repo={r}
      selected={selected.has(r.id)}
      clock={clockTick}
      onToggleSelect={toggleSelect}
      onOpen={openRepo}
      onShowDetail={setDetailId}
      onToggleFavorite={toggleFavorite}
      onQuickFilter={quickFilter}
      onFilterTag={filterTag}
      onCopyPath={copyPath}
    />
  )

  return (
    <>
      <div className="rr-bar">
        <ScopeMark size={24} />
        <span className="rr-brand">
          repo<span className="d">·</span>radar
        </span>
        <span className="rr-sep" />
        <Segmented
          className="rr-nav"
          size="small"
          value={view}
          onChange={(v) => setView(v as "board" | "stats" | "log" | "worklog")}
          options={[
            { label: t("nav.board"), value: "board" },
            { label: t("nav.stats"), value: "stats" },
            { label: t("nav.worklog"), value: "worklog" },
            { label: t("nav.log"), value: "log" },
          ]}
        />
        {/* 看板专属控件（搜索/筛选/排序/视图）——只在看板页出现；切到统计/工作记录/日志时整栏清爽 */}
        {view === "board" && (
          <>
            <span className="rr-sep" />
            <Input
              allowClear
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              placeholder={`🔍 ${t("bar.search")}`}
              style={{ width: 260 }}
              size="small"
            />
            <Button size="small" type="text" onClick={() => setPaletteOpen(true)} title={t("bar.paletteTip")}>
              ⌘K
            </Button>
            <span className="rr-sep" />
            <Select
              size="small"
              value={filter.group ?? ""}
              style={{ width: 124 }}
              onChange={(v) => setFilter({ ...filter, group: v || null })}
              options={[{ label: t("bar.allGroups"), value: "" }, ...groups.map((g) => ({ label: g, value: g }))]}
            />
            {allTags.length > 0 && (
              <Select
                mode="multiple"
                size="small"
                allowClear
                maxTagCount="responsive"
                style={{ minWidth: 124, maxWidth: 240 }}
                placeholder={t("bar.tagFilter")}
                value={filter.tags ?? []}
                onChange={(vals) => setFilter((f) => ({ ...f, tags: vals }))}
                title={t("bar.tagFilterTip")}
                options={allTags.map((tag) => ({ label: `#${tag}`, value: tag }))}
              />
            )}
            <Select
              size="small"
              value={filter.sort}
              style={{ width: 124 }}
              onChange={(v) => setFilter({ ...filter, sort: v as FilterState["sort"] })}
              options={[
                { label: t("sort.opened"), value: "opened" },
                { label: t("sort.activity"), value: "activity" },
                { label: t("sort.name"), value: "name" },
              ]}
            />
            <Select
              size="small"
              value={groupMode}
              style={{ width: 108 }}
              onChange={(v) => setGroupMode(v)}
              options={[
                { label: t("group.folder"), value: "folder" },
                { label: t("group.language"), value: "language" },
                { label: t("group.none"), value: "none" },
              ]}
            />
            <span className="rr-sep" />
            {views.length > 0 && (
              <Select
                size="small"
                style={{ width: 118 }}
                placeholder={t("bar.view")}
                value={viewName ?? undefined}
                allowClear
                onClear={() => setViewName(null)}
                onChange={(n) => {
                  const v = views.find((x) => x.name === n)
                  if (v) applyView(v)
                }}
                options={views.map((v) => ({ label: v.name, value: v.name }))}
              />
            )}
            <Button
              size="small"
              type="text"
              onClick={() => {
                setNewViewName(viewName ?? "")
                setSaveViewOpen(true)
              }}
              title={t("bar.saveViewTip")}
            >
              {t("bar.saveView")}
            </Button>
          </>
        )}
        <span className="rr-readout">
          <span className="cell">
            <span className="v">{counts.fleet}</span>
            <span className="k">FLEET</span>
          </span>
          <span className="cell">
            <span className={`v${counts.crit > 0 ? " crit" : ""}`}>{counts.crit}</span>
            <span className="k">CRIT</span>
          </span>
          <span className="cell">
            <span className={`v${counts.warn > 0 ? " warn" : ""}`}>{counts.warn}</span>
            <span className="k">WARN</span>
          </span>
          <span className="cell">
            <span className="v ok">{counts.clean}</span>
            <span className="k">CLEAN</span>
          </span>
        </span>
        <Button size="small" loading={scanning} onClick={rescan}>
          {scanning ? (scanProgress ? t("bar.scanProgress", { done: scanProgress.scanned, total: scanProgress.total }) : t("bar.scanning")) : t("bar.rescan")}
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: "new", label: t("add.new") },
              { key: "clone", label: t("add.clone") },
              { type: "divider" },
              { key: "export", label: t("add.export") },
              { key: "import", label: t("add.import") },
            ],
            onClick: ({ key }) => {
              if (key === "new") openNewProject()
              else if (key === "clone") openClone()
              else if (key === "export") exportManifest()
              else if (key === "import") manifestFileRef.current?.click()
            },
          }}
        >
          <Button size="small" type="primary" ghost>
            {t("bar.add")} ▾
          </Button>
        </Dropdown>
        <input
          ref={manifestFileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={importManifestFile}
        />
        <Popover
          trigger="click"
          placement="bottomRight"
          rootClassName="rr-settings-pop"
          content={
            <div className="rr-settings">
              <div className="row">
                <span className="lb">Language</span>
                <Select
                  size="small"
                  value={lang}
                  style={{ width: 138 }}
                  onChange={(v) => setLang(v)}
                  showSearch
                  optionFilterProp="label"
                  options={LANGS.map((l) => ({ label: l.name, value: l.code }))}
                />
              </div>
              <div className="row">
                <span className="lb">{t("settings.theme")}</span>
                <Segmented
                  size="small"
                  value={themeMode}
                  onChange={(v) => v !== themeMode && onToggleTheme()}
                  options={[
                    { label: t("settings.dark"), value: "dark" },
                    { label: t("settings.light"), value: "light" },
                  ]}
                />
              </div>
              <div className="row">
                <span className="lb">
                  {t("settings.autoScan")}<span className="hint">{t("settings.autoScanHint")}</span>
                </span>
                <Switch size="small" checked={autoWatch} onChange={toggleWatch} />
              </div>
              <div className="row">
                <span className="lb">
                  {t("settings.autoFetch")}<span className="hint">{t("settings.autoFetchHint")}</span>
                </span>
                <Select
                  size="small"
                  value={autoFetchMin}
                  style={{ width: 96 }}
                  onChange={changeAutoFetch}
                  options={[
                    { label: t("fetch.off"), value: 0 },
                    { label: t("fetch.min", { n: 5 }), value: 5 },
                    { label: t("fetch.min", { n: 15 }), value: 15 },
                    { label: t("fetch.min", { n: 30 }), value: 30 },
                    { label: t("fetch.min", { n: 60 }), value: 60 },
                  ]}
                />
              </div>
              <div className="row">
                <span className="lb">
                  {t("settings.notify")}<span className="hint">{t("settings.notifyHint")}</span>
                </span>
                <Switch size="small" checked={notify} onChange={toggleNotify} />
              </div>
              <a className="rr-settings-gh" href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
                <span>GitHub</span>
                <span className="ext">↗</span>
              </a>
            </div>
          }
        >
          <Button
            size="small"
            className="rr-gear"
            type={autoWatch || autoFetchMin > 0 || notify ? "primary" : "default"}
            ghost={autoWatch || autoFetchMin > 0 || notify}
            title={t("settings.tip")}
          >
            ⚙
          </Button>
        </Popover>
      </div>

      {view === "board" && (
        <div className="rr-annun">
          {ATTENTION.map((a) => {
            const n = counts.attn[a.key]
            if (n === 0) return null
            return (
              <span
                key={a.key}
                className={`rr-lamp ${a.sev}${attention === a.key ? " on" : ""}`}
                onClick={() => setAttention(attention === a.key ? null : a.key)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setAttention(attention === a.key ? null : a.key)}
              >
                <span className="dotm" />
                <span className="lb">{t(a.labelKey)}</span>
                <span className="ct">{n}</span>
              </span>
            )
          })}
          <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {attention && LAMP_OP[attention] && visible.length > 0 && (
              <Button
                size="small"
                type="primary"
                ghost
                onClick={() => runBatch(LAMP_OP[attention]!, visible.map((r) => r.id))}
              >
                {t("annun.batchAll", { op: LAMP_OP[attention]!, n: visible.length })}
              </Button>
            )}
            {selected.size > 0 && (
              <>
                <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
                  {t("annun.selected", { n: selected.size })}
                </span>
                {(["fetch", "pull", "push"] as const).map((a) => (
                  <Button key={a} size="small" onClick={() => runBatch(a, [...selected])}>
                    {t("annun.batch", { action: a })}
                  </Button>
                ))}
                <Input
                  size="small"
                  style={{ width: 120 }}
                  placeholder={t("annun.tagPlaceholder")}
                  value={batchTag}
                  onChange={(e) => setBatchTag(e.target.value)}
                  onPressEnter={() => {
                    const tg = batchTag.trim()
                    if (!tg) return
                    for (const id of selected) {
                      const r = repos.find((x) => x.id === id)
                      if (r && !r.tags.includes(tg)) patchMeta(id, { tags: [...r.tags, tg] })
                    }
                    setBatchTag("")
                  }}
                />
                <Input
                  size="small"
                  style={{ width: 190 }}
                  placeholder={t("annun.execPlaceholder")}
                  value={execCmd}
                  onChange={(e) => setExecCmd(e.target.value)}
                  onPressEnter={() => runExec(false)}
                  title={t("annun.execTip")}
                />
                <Button size="small" onClick={() => runExec(false)} disabled={execCmd.trim() === ""}>
                  {t("annun.run")}
                </Button>
                <Button size="small" type="text" onClick={() => runExec(true)} disabled={execCmd.trim() === ""} title={t("annun.dryRunTip")}>
                  {t("annun.dryRun")}
                </Button>
                <Button size="small" type="text" onClick={() => setSelected(new Set())}>
                  {t("annun.clear")}
                </Button>
              </>
            )}
            {(stashTotal > 0 || showStash) && (
              <Button
                size="small"
                type={showStash ? "primary" : "text"}
                ghost={showStash}
                onClick={() =>
                  setShowStash((v) => {
                    if (!v) setShowArchived(false) // 两个子视图互斥
                    return !v
                  })
                }
                title={t("annun.stashViewTip")}
              >
                {showStash ? t("annun.backToRepos") : t("annun.stashView", { n: stashTotal })}
              </Button>
            )}
            {(counts.archived > 0 || showArchived) && (
              <Button
                size="small"
                type={showArchived ? "primary" : "text"}
                ghost={showArchived}
                onClick={() =>
                  setShowArchived((v) => {
                    if (!v) setShowStash(false)
                    return !v
                  })
                }
                title={t("annun.excludedViewTip")}
              >
                {showArchived ? t("annun.backToRepos") : t("annun.excludedView", { n: counts.archived })}
              </Button>
            )}
          </span>
        </div>
      )}

      {batch && (
        <div className="rr-annun" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: batch.finished ? (failed.length > 0 ? "var(--crit)" : "var(--ok)") : "var(--text)",
            }}
          >
            {batch.finished
              ? t("batch.done", { action: batch.action, ok: batch.results.length - failed.length }) +
                (failed.length > 0 ? t("batch.doneFail", { n: failed.length, names: failed.map((f) => f.name).join("、") }) : "")
              : t("batch.running", { action: batch.action, done: batch.done, total: batch.total }) + (batch.current ? ` · ${batch.current}` : "")}
          </span>
          {batch.finished && batch.results.some((r) => r.output !== undefined) && (
            <Button size="small" type="text" onClick={() => setExecResultOpen(true)}>
              {t("batch.viewOutput")}
            </Button>
          )}
          {batch.finished && (
            <Button size="small" type="text" onClick={() => setBatch(null)}>
              {t("batch.close")}
            </Button>
          )}
        </div>
      )}

      <Modal
        open={execResultOpen}
        onCancel={() => setExecResultOpen(false)}
        footer={null}
        width={760}
        title={<span className="mono" style={{ color: "var(--hi)" }}>{t("exec.outputTitle", { action: batch?.action ?? "" })}</span>}
        styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
      >
        {batch?.results.map((r) => (
          <div key={r.repoId} style={{ marginBottom: 14 }}>
            <div className="mono" style={{ fontSize: 12, color: r.ok ? "var(--ok)" : "var(--crit)" }}>
              {r.ok ? "✓" : "✗"} {r.name} · {r.code !== undefined ? t("exec.exit", { code: r.code ?? "—" }) : r.message}
            </div>
            {r.output !== undefined && r.output !== "" && (
              <pre className="rr-exec-out">{r.output}</pre>
            )}
          </div>
        ))}
      </Modal>

      {view === "worklog" ? (
        <WorklogView onOpenRepo={showRepoDetail} />
      ) : view === "stats" ? (
        <StatsView onOpenRepo={showRepoDetail} />
      ) : view === "log" ? (
        <div className="rr-stats">
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{t("log.title")}</h2>
            {log.length > 0 && (
              <Button size="small" type="text" style={{ marginLeft: "auto" }} onClick={() => setLog([])}>
                {t("log.clear")}
              </Button>
            )}
          </div>
          {log.length === 0 ? (
            <div className="rr-empty">{t("log.empty")}</div>
          ) : (
            <div className="rr-actlist">
              {log.map((e) => (
                <div className="r" key={e.t}>
                  <span style={{ color: e.ok ? "var(--ok)" : "var(--crit)", fontFamily: "var(--mono)" }}>
                    {e.ok ? "✓" : "✗"}
                  </span>
                  <span className="nm" style={{ color: "var(--text)" }}>
                    {e.text}
                  </span>
                  <span className="ago">{new Date(e.t).toLocaleString(lang, { hour12: false })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : showStash ? (
        <main className="rr-main">
          <StashView onLog={addLog} />
        </main>
      ) : (
        <main className="rr-main">
          {!filter.query && !attention && !showArchived && repos.length > 0 && (
            <CockpitHero
              queue={actionQueueVisible}
              onOpenRepo={showRepoDetail}
              onOpenStash={() => setShowStash(true)}
              onPush={(id) => runBatch("push", [id])}
              onDismiss={dismissItem}
              open={cockpitOpen}
              onToggle={() => setCockpitOpen((v) => !v)}
            />
          )}
          {(() => {
            const faves = active.filter((r) => r.favorite)
            const browsing = !filter.query && !attention && !showArchived
            if (faves.length === 0 || !browsing) return null
            const favSev = (r: RepoStatus) =>
              r.error || r.health.some((h) => h.severity === "error")
                ? "var(--crit)"
                : r.health.some((h) => h.severity === "warn")
                  ? "var(--warn)"
                  : "var(--ok)"
            return (
              <div className="rr-faves">
                <span className="hd">★ {t("fav.pinned")}</span>
                {faves.map((r) => (
                  <button key={r.id} className="rr-fave" title={t("fav.openTip", { name: r.name })} onClick={() => openRepo(r.id, "editor")}>
                    <span className="dot" style={{ background: favSev(r) }} />
                    {r.name}
                  </button>
                ))}
              </div>
            )
          })()}
          {sections === null ? (
            <div className={`rr-grid${bootAnim ? " boot" : ""}`} style={{ marginTop: 14 }}>
              {visible.map(renderCard)}
            </div>
          ) : (
            sections.map(([group, rs]) => (
              <section key={group}>
                <div className="rr-ghd">
                  <span className="nm">{group}</span>
                  <span className="ct">{t("board.count", { n: rs.length })}</span>
                  <span className="ln" />
                </div>
                <div className={`rr-grid${bootAnim ? " boot" : ""}`}>{rs.map(renderCard)}</div>
              </section>
            ))
          )}
          {loadError !== null && <div className="rr-empty err">{loadError}</div>}
          {loadError === null && visible.length === 0 && !scanning && (
            <div className="rr-empty">
              {showArchived
                ? t("empty.noExcluded")
                : attention || filter.query || filter.group || (filter.tags?.length ?? 0) > 0
                  ? t("empty.noMatch")
                  : t("empty.noRepos")}
            </div>
          )}
        </main>
      )}

      {detailRepo !== null && (
        <DetailPanel
          key={detailRepo.id} // 按仓库 id 重挂载：切换仓库拿全新实例，避免上一个仓库的 in-flight 详情回填串台
          repo={detailRepo}
          groups={groups}
          allTags={allTags}
          onPatchMeta={patchMeta}
          onOpen={openRepo}
          onCopyPath={copyPath}
          onSync={(action) => syncOne(detailRepo.id, action)}
          onLog={addLog}
          onClose={() => setDetailId(null)}
        />
      )}

      <CommandPalette open={paletteOpen} repos={active} onClose={() => setPaletteOpen(false)} onOpen={openRepo} onCopyPath={copyPath} />

      <Modal
        open={newOpen}
        title={t("add.new")}
        okText={t("modal.create")}
        cancelText={t("modal.cancel")}
        confirmLoading={creating}
        onOk={submitNewProject}
        onCancel={() => setNewOpen(false)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
            {t("new.parentLabel")}
            <Input value={newParent} onChange={(e) => setNewParent(e.target.value)} placeholder="D:\\...\\Projects\\365" />
          </label>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
            {t("new.nameLabel")}
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onPressEnter={submitNewProject}
              placeholder="028-my-thing"
            />
          </label>
          <span className="mono" style={{ fontSize: 11, color: "var(--dim2)" }}>
            {t("new.hint")}
          </span>
        </div>
      </Modal>

      <Modal
        open={cloneOpen}
        title={t("add.clone")}
        okText={t("modal.clone")}
        cancelText={t("modal.cancel")}
        confirmLoading={cloning}
        onOk={submitClone}
        onCancel={() => setCloneOpen(false)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
            {t("clone.urlLabel")}
            <Input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              autoFocus
            />
          </label>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
            {t("clone.parentLabel")}
            <Input value={cloneParent} onChange={(e) => setCloneParent(e.target.value)} placeholder="D:\\...\\Projects" />
          </label>
          <span className="mono" style={{ fontSize: 11, color: "var(--dim2)" }}>
            {t("clone.hint")}
          </span>
        </div>
      </Modal>

      <Modal
        open={saveViewOpen}
        title={t("saveview.title")}
        okText={t("modal.save")}
        cancelText={t("modal.cancel")}
        onOk={() => {
          const n = newViewName.trim()
          if (!n) {
            message.warning(t("msg.viewNameNeeded"))
            return
          }
          saveCurrentView(n)
          setSaveViewOpen(false)
        }}
        onCancel={() => setSaveViewOpen(false)}
      >
        <div style={{ marginTop: 12 }}>
          <Input
            value={newViewName}
            onChange={(e) => setNewViewName(e.target.value)}
            placeholder={t("saveview.placeholder")}
            autoFocus
          />
          <div className="mono" style={{ fontSize: 11, color: "var(--dim2)", marginTop: 8 }}>
            {t("saveview.hint")}
          </div>
          {viewName && (
            <Button
              danger
              type="text"
              size="small"
              style={{ marginTop: 8, paddingLeft: 0 }}
              onClick={() => {
                deleteView(viewName)
                setSaveViewOpen(false)
              }}
            >
              {t("saveview.delete", { name: viewName })}
            </Button>
          )}
        </div>
      </Modal>
    </>
  )
}
