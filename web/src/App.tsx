import { App as AntdApp, Button, Dropdown, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Switch, Tooltip } from "antd"
import { type ChangeEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CockpitHero, GITHUB_KINDS, type QueueItem } from "./components/CockpitHero"
import { CommandPalette } from "./components/CommandPalette"
import { DetailPanel } from "./components/DetailPanel"
import { RepoCard } from "./components/RepoCard"
import { ScanConfigEditor } from "./components/ScanConfigEditor"
import { ScopeMark } from "./components/ScopeMark"
import { SelIcon } from "./components/SelIcon"
import { StashView } from "./components/StashView"
import { StatsView } from "./components/StatsView"
import { WorklogExportStatusPanel } from "./components/WorklogExportStatus"
import { WorklogView } from "./components/WorklogView"
import { LANGS, useI18n } from "./i18n"
import {
  ATTENTION,
  type AttentionKey,
  activeRelease,
  activeStashDays,
  COUNT_KINDS,
  days,
  dismissKey,
  dismissVal,
  formatMark,
  issueActive,
  kindArrivals,
  kindCount,
  LAMP_KEYS,
  LAMP_OP,
  parseMark,
  STASH_SNOOZE_MS,
} from "./lib/attention"
import { type HasRootsState, resolveEmptyArea } from "./lib/emptyState"
import { errText } from "./lib/errText"
import { applyFilter, type FilterState } from "./lib/filter"
import { visibleLamps } from "./lib/lamps"
import { isGithubUrl } from "./lib/meta"
import { type LogEntry, loadLog, loadViews, pref, type SavedView, savePref } from "./lib/prefs"
import { mergeRepo, parentOf } from "./lib/repos"
import { relativeTime } from "./lib/time"
import { connectEvents } from "./lib/ws"
import type { BatchProgress, BatchResultItem, RepoStatus, ScanStatus, ServerEvent, TaskStarted } from "./types"

const JSON_HEADERS = { "content-type": "application/json" }

// 是否已配置过扫描来源。挂载时和保存扫描目录后都要算一次，抽出来避免两处判断口径跑偏
const configHasRoots = (c: { roots?: unknown[]; manualRepos?: unknown[] }) =>
  (c.roots?.length ?? 0) > 0 || (c.manualRepos?.length ?? 0) > 0
const REPO_URL = "https://github.com/rockbenben/repo-radar" // 顶栏 GitHub 链接（与 package.json repository 一致）

// 本应用 Windows 优先，快捷键按钮不该对着一枚 Mac 键帽发呆（A-T1）：非 Mac 显示 Ctrl。
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
const KBD_MOD = IS_MAC ? "⌘" : "Ctrl"

// 批量/单仓库的 git 动作词。中文界面里把裸动词拼进句子会中英夹丝（「批量 push 完成」），
// 过一张 action.* 表；en 及其余语言的 action.* 就是原动词，等价于不转。exec 等未收录动作原样返回。
const ACTION_KEYS = new Set(["fetch", "pull", "push"])

type RepoLayout = "cards" | "list"

// 设置弹窗的两栏，按**交互模型**分：常规里点完即生效，扫描与打开方式要显式保存并重扫。
// 第二项复用已有的 scan.title，只有「常规」是新词
type SettingsTab = "general" | "scan"
const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "settings.tabGeneral" },
  { key: "scan", labelKey: "scan.title" },
]

export default function App({
  themeMode,
  onToggleTheme,
}: {
  themeMode: "dark" | "light"
  onToggleTheme: () => void
}) {
  const { message, modal } = AntdApp.useApp()
  const { t, lang, setLang } = useI18n()
  // t 由 I18nProvider 的 useMemo 在语言变化时重建（见 web/src/i18n/index.tsx）。
  // 下面挂载时建立 WebSocket 的那个 effect 依赖数组是空的（连接要活整个会话，不能因为
  // 别的东西变了就重连），它里面的事件处理器于是把 t 永久闭包在**挂载时**那个语言上：
  // 中文进页面、切成英文再点批量 push，活动日志写进去的是「批量 push 完成：1 成功」，
  // 而界面已全英文；日志还会落 localStorage 长期留着，此后每次批量操作再加一条。
  // 把 t 放进依赖数组不是选项——那会让 connectEvents 每切一次语言就断开重连 WebSocket。
  // 改用 ref 持有最新的 t，处理器内部读 ref（同 components/ScanConfigEditor.tsx 的做法）
  const tRef = useRef(t)
  tRef.current = t
  // 稳定 helper：把 git 动作词本地化（见 ACTION_KEYS）。t 走 ref，供 WS 闭包里安全调用
  const actionWord = useCallback((a: string) => (ACTION_KEYS.has(a) ? tRef.current(`action.${a}`) : a), [])
  // 横幅/输出面板标题里的动作名：预演（dry run）加一个**本地化**前缀。
  // 服务端过去直接拼中文「预演: 」，非中文界面里就会漏出中文（实测英文界面显示
  // “Batch 预演: echo hello … done: 1 ok”）。现在服务端只传命令原文 + dryRun 标记。
  const batchActionWord = useCallback(
    (a: string, dryRun?: boolean) => (dryRun ? tRef.current("batch.dryRunLabel", { action: a }) : actionWord(a)),
    [actionWord],
  )
  // 顶栏横幅的文案。单仓库动作（详情面板里点的 拉取/更新/推送）说「仓库 + 动作 + 结果」，
  // 不说「批量…完成」——用户点的是单个仓库，那句文案会让人以为触发了批量操作。
  // 横幅**照旧出现**：详情面板可能在同步完成前被关掉（或切到别的仓库重挂载），
  // 那一行内联结果就没了，这条横幅是唯一的当场反馈。
  const batchBannerText = (b: BatchProgress, failedItems: BatchResultItem[]): string => {
    const action = actionWord(b.action)
    if (!b.finished) {
      return (
        t("batch.running", { action: batchActionWord(b.action, b.dryRun), done: b.done, total: b.total }) +
        (b.current ? ` · ${b.current}` : "")
      )
    }
    if (b.scope === "single" && b.results.length === 1) {
      const r = b.results[0]
      return r.ok
        ? t("batch.doneOne", { name: r.name, action })
        : t("batch.doneOneFail", { name: r.name, action, err: errText(t, r.message) })
    }
    return (
      t("batch.done", { action: batchActionWord(b.action, b.dryRun), ok: b.results.length - failedItems.length }) +
      (failedItems.length > 0
        ? t("batch.doneFail", { n: failedItems.length, names: failedItems.map((f) => f.name).join("、") })
        : "")
    )
  }
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
  // 顶栏告警灯：默认全开，用户可在设置里关掉自己不关心的类型（比如一堆本地实验仓的「无远程」）。
  // 存的是关掉的那几盏，理由见 lib/lamps.ts——以后加新灯时老用户也得看得见
  const [lamps, setLamps] = useState<AttentionKey[]>(() => visibleLamps(pref("lampsOff", ""), LAMP_KEYS))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState<BatchProgress | null>(null)
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total: number } | null>(null)
  const [view, setView] = useState<"board" | "stats" | "log" | "worklog">(() => pref("view", "board") as "board" | "stats" | "log" | "worklog")
  const [log, setLog] = useState<LogEntry[]>(loadLog)
  const addLog = useCallback(
    (ok: boolean, text: string) => setLog((prev) => [{ t: Date.now(), ok, text }, ...prev].slice(0, 80)),
    [],
  )
  const [repoLayout, setRepoLayout] = useState<RepoLayout>(() => pref("repoLayout", "cards") === "list" ? "list" : "cards")
  const boardRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const layoutAnchor = useRef<{ id: string; top: number } | null>(null)
  const [groupMode, setGroupMode] = useState<"folder" | "language" | "none">(
    () => pref("group", "none") as "folder" | "language" | "none",
  )
  const [showArchived, setShowArchived] = useState(() => pref("arch", "0") === "1")
  const [showStash, setShowStash] = useState(false) // 跨仓库 stash 收纳箱子视图（不持久化，刷新即回看板）
  const [batchTag, setBatchTag] = useState("")
  const [execCmd, setExecCmd] = useState("")
  const [execResultOpen, setExecResultOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general")
  // antd 隐藏弹窗时会缓存子组件。每次打开都让扫描编辑器从已保存配置开始。
  const [scanSettingsSession, setScanSettingsSession] = useState(0)
  const openSettings = () => {
    setScanSettingsSession((session) => session + 1)
    setSettingsOpen(true)
  }
  // 看板和新增菜单的扫描入口直达扫描栏，齿轮保留当前栏。
  const openScanSettings = () => {
    setSettingsTab("scan")
    openSettings()
  }
  // 是否已配置过扫描来源（roots 或手动仓库）：null=config 还没拉到。首次引导欢迎页只在
  // 明确「没配置过」时出现——配置了但扫出 0 个仓库的用户应看到「未发现仓库」而不是被当成新用户
  const [hasRoots, setHasRoots] = useState<HasRootsState>(null)
  // 空看板要能说出「到底在哪些目录里没找到仓库」；只存布尔值的话，路径写错时用户只能猜
  const [scanRoots, setScanRoots] = useState<string[]>([])
  const [autostart, setAutostart] = useState<{ supported: boolean; enabled: boolean }>({ supported: false, enabled: false }) // 开机自启（OS 为事实源；仅 exe 模式 supported）
  // 本实例信息：版本号显示在设置里，供用户核对「我现在跑的是哪一版」——单实例不再自动替换旧版，
  // 升级要靠「退出 → 运行新版」，这个显示就是用户确认升级是否生效的唯一凭据。
  // canQuit 独立于 autostart：退出按钮只跟退出端点是否存在挂钩
  // port：后端实际绑定的端口。默认端口绑不上时会自动换一个，而端口是本页 origin 的一部分——
  // 显示出来用户才知道自己实际跑在哪（书签/脚本要用），也才解释得了换端口后 localStorage
  // 里的视图和活动日志为何像是"没了"
  const [instance, setInstance] = useState<{ version: string; canQuit: boolean; canPickDirectory: boolean; manualUpdates: boolean; port: number }>({
    version: "",
    canQuit: false,
    canPickDirectory: false,
    manualUpdates: false,
    port: 0,
  })
  // 自动化开关的占位值必须与服务端默认值一致：/api/config 拉到之前（以及拉失败时）显示的
  // 就是这几个值，对不上就等于在骗人说后台没在跑。configLoaded 为假时控件一律禁用——
  // 拉失败时我们并不知道服务端的真实状态，禁用比展示一个可能相反的开关诚实
  // 文件监听实时刷新（服务端持久化，**默认关**）。初值必须跟服务端默认一致：/api/config
  // 回来之前这一格是先画出来的，猜错的那一侧会闪一下相反的状态，还会连带闪出它的子行（监听上限）
  const [autoWatch, setAutoWatch] = useState(false)
  const [autoScanMin, setAutoScanMin] = useState(30) // 兜底全量重扫间隔（分钟，0=关；默认 30）
  const [configLoaded, setConfigLoaded] = useState(false)
  const [autoFetchMinutes, setAutoFetchMinutes] = useState(0)
  const [fetchMinutesInput, setFetchMinutesInput] = useState<number | null>(0)
  const [worklogExport, setWorklogExport] = useState<{ minutes: number | null; path: string }>({ minutes: 0, path: "" })
  const [invalidWorklogPath, setInvalidWorklogPath] = useState(false)
  const [savedWorklogPath, setSavedWorklogPath] = useState("")
  const [savingWorklogExport, setSavingWorklogExport] = useState(false)
  const [autoPull, setAutoPull] = useState(false)
  const [watchLimit, setWatchLimit] = useState(200) // 同时监听的仓库数上限（0=无上限；默认 200）
  // 实际挂上监听的仓库数 / 本该监听的总数。截断只写服务端日志的话，常驻托盘的应用
  // 等于什么都没说——用户没法回答「为什么这个仓库不自动刷新」，所以要在面板上如实显示
  const [watchCov, setWatchCov] = useState<{ watched: number; total: number }>({ watched: 0, total: 0 })
  const [lastScanAt, setLastScanAt] = useState<string | null>(null) // 最近一次全量扫描完成时刻（ISO）
  const [notifications, setNotifications] = useState(false) // 「等我的」新增时弹系统通知（服务端持久化，默认关）
  // 启动时检查一次新版本（服务端持久化，**默认关**）。初值必须与服务端默认一致：
  // /api/config 回来之前这一格是先画出来的，猜错的那一侧会闪一下相反的状态
  const [checkUpdates, setCheckUpdates] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false) // 手动检查进行中（原生对话框在主进程那边弹）
  const manifestFileRef = useRef<HTMLInputElement>(null)
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
        // 但压根没有 GitHub 远程的仓库 inbox 恒为 null——那是「确认不存在」不是「未知」，旧记录该清（防永久堆积）。
        // remotes 为空同样算「未知」：`git remote -v` 这一次 spawn 失败/被杀软锁住/在网络盘上超时时，
        // getRepoHeavy 会 degrade 成 []，而 error 仍是 null——只挡 error !== null 的话，一次瞬时抖动
        // 就把用户点过的 ✓ 从 localStorage 永久删掉，下一轮远程恢复、PR 一个没变，条目原样复活。
        // 不会因此无界堆积：:pr/:issue/:ci 这三个键只可能在 githubInbox 非空（即确实有 GitHub 远程）时被创建
        const unknown =
          r.error !== null ||
          (GITHUB_KINDS.has(kind) && r.githubInbox === null && (r.remotes.length === 0 || r.remotes.some((rm) => isGithubUrl(rm.url))))
        if (unknown) {
          next[k] = v
          continue
        }
        if (!issueActive(r, kind)) {
          changed = true // 确认已解决：清
          continue
        }
        // 计数类：数量掉下去后把水位跟着降——「3 个 PR」已处理、合掉 2 个只剩 1，之后来 1 个新的（2>1）
        // 必须能冒出来；不降水位的话要涨过旧高点 3 才重现，违背「来了新的就回来」。
        // 这条只在面板开着时才跑得到（pr/issue 另有服务端记账兜住关着的那段，见 parseMark），
        // 降档时必须原样保留基线那半截，否则记录会被降级回旧格式、服务端记账再也用不上
        const mark = COUNT_KINDS.has(kind) ? parseMark(v) : null
        const cur = mark ? kindCount(r, kind) : null
        if (cur !== null && mark !== null && cur < mark.n) {
          next[k] = formatMark(cur, mark.base)
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
    setShowStash(false)
    setDetailId(id)
  }

  // 扫描时刻 + 监听覆盖数。挂载、WebSocket 重连、以及改动监听设置之后各拉一次：
  // 断线期间跑过的兜底重扫其 scan:done 我们没收到，覆盖数也只有服务端算得出来
  const syncScanStatus = useCallback(() => {
    return fetch("/api/scan")
      .then((res) => (res.ok ? res.json() : null))
      .then((s: ScanStatus | null) => {
        if (!s) return
        if (s.lastScanAt) setLastScanAt(s.lastScanAt)
        if (s.watch) setWatchCov(s.watch)
      })
      .catch(() => {})
  }, [])

  // 一轮全量扫描的结果落到界面：整份替换（能表达「仓库没了」，mergeRepo 做不到），
  // 顺手把已经不存在的仓库从选中集里摘掉，免得批量操作打在幽灵 id 上
  const applyScanResult = useCallback((data: RepoStatus[]) => {
    // 整份快照到手 = 后端通了，之前那条「无法连接」已经过期。只在 rescan() 的成功分支里清是不够的：
    // 首发 /api/scan 失败（后端还在跑启动扫描、休眠唤醒后 socket 被重置）之后，数据是经 WS 的
    // scan:done / 重连补拉到齐的，红色错误条会整场会话钉在那儿；而 resolveEmptyArea 见
    // loadError !== null 就返回 "hidden"，「没有匹配的仓库」从此再不出现——筛空了就是一片空白
    setLoadError(null)
    setRepos(data)
    setSelected((s) => new Set([...s].filter((id) => data.some((r) => r.id === id))))
  }, [])

  // useCallback 而非函数声明：WS effect 把它列进依赖，身份必须稳定，否则每轮渲染重连
  const rescan = useCallback(async () => {
    setScanning(true)
    try {
      const res = await fetch("/api/scan", { method: "POST" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLoadError(null)
      const data = (await res.json()) as RepoStatus[]
      applyScanResult(data)
      // HTTP 与 WebSocket 用同一个扫描时刻，两个视图对同一轮只刷新一次。
      setLastScanAt(res.headers.get("X-Repo-Radar-Scan-At") ?? new Date().toISOString())
    } catch (err) {
      // tRef 而不是 t：稳定身份不能捕获当轮渲染的翻译闭包
      setLoadError(tRef.current("msg.loadError", { err: String(err) }))
      addLog(false, tRef.current("msg.scanFail", { err: String(err) }))
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [applyScanResult, addLog])

  useEffect(() => {
    rescan()
    const handler = (e: ServerEvent) => {
      if (e.type === "repo:updated") setRepos((rs) => mergeRepo(rs, e.payload.repo))
      else if (e.type === "batch:progress") {
        // 单仓库动作（详情面板里的 拉取/更新/推送）复用同一套任务机制，回执同样走 batch:progress。
        // 横幅照旧出（面板可能在完成前被关掉，那时它是唯一的当场反馈），但文案按 scope 走
        // 「仓库 + 动作」那一种，不写「批量…完成」。
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
          const action = actionWord(e.payload.action)
          // 单仓库动作（详情面板里的 拉取/更新/推送）：日志写「仓库 + 动作 + 结果」，
          // 别写「批量…完成」——用户点的是单个仓库，那句文案会让人以为触发了批量操作
          if (e.payload.scope === "single" && e.payload.results.length === 1) {
            const r = e.payload.results[0]
            if (r.ok) addLog(true, tRef.current("batch.doneOne", { name: r.name, action }))
            else addLog(false, tRef.current("batch.doneOneFail", { name: r.name, action, err: errText(tRef.current, r.message) }))
          } else {
            addLog(
              f.length === 0,
              tRef.current("batch.done", { action, ok: e.payload.results.length - f.length }) +
                (f.length ? tRef.current("batch.doneFail", { n: f.length, names: f.map((x) => x.name).join("、") }) : ""),
            )
          }
        }
      } else if (e.type === "scan:progress") setScanProgress(e.payload.scanned >= e.payload.total ? null : e.payload)
      else if (e.type === "scan:done") {
        // 定时兜底重扫没有任何 HTTP 响应可以承载结果——不在这里把仓库列表换掉，看板就会
        // 停在旧数据（删掉的仓库还在、新克隆的不出现），顶栏却已经写着「上次扫描 刚刚」
        setLastScanAt(e.payload.at)
        applyScanResult(e.payload.repos)
        // 监听覆盖数只有服务端算得出来，且每轮扫描的 applyWatch 都会更新它。挂载时拉到的
        // 是「启动扫描完成前」的 0/0——不在这里补拉，「250 个中监听 200 个」整个会话都不显示
        void syncScanStatus()
      }
    }
    return connectEvents(handler, () => {
      void fetch("/api/repos")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: RepoStatus[] | null) => {
          if (data) applyScanResult(data)
        })
        .catch(() => {})
      // 断线期间跑过的兜底重扫，其 scan:done 广播我们没收到——重连时补拉一次时刻，
      // 否则「上次扫描」会一直停在断线前的旧值，比不显示更误导
      void syncScanStatus()
    })
  }, [syncScanStatus, applyScanResult, rescan, addLog, actionWord])

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

  useLayoutEffect(() => {
    savePref("repoLayout", repoLayout)
    const anchor = layoutAnchor.current
    layoutAnchor.current = null
    if (!anchor) return
    const row = boardRef.current?.querySelector(`[data-repo-id="${CSS.escape(anchor.id)}"]`)
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - anchor.top)
  }, [repoLayout])

  const changeRepoLayout = (next: RepoLayout) => {
    const headerBottom = headerRef.current?.getBoundingClientRect().bottom ?? 0
    const rows = boardRef.current?.querySelectorAll<HTMLElement>("[data-repo-id]")
    // 换布局时保住当前正在看的仓库，列表开头仍保留原来的首屏。
    if (rows?.length && rows[0].getBoundingClientRect().top < headerBottom) {
      const firstVisible = Array.from(rows).find((row) => row.getBoundingClientRect().bottom > headerBottom)
      const id = firstVisible?.dataset.repoId
      if (id && firstVisible) layoutAnchor.current = { id, top: Math.max(headerBottom, firstVisible.getBoundingClientRect().top) }
    }
    setRepoLayout(next)
  }

  useEffect(() => savePref("sort", filter.sort), [filter.sort])
  useEffect(() => savePref("view", view), [view])
  useEffect(() => savePref("group", groupMode), [groupMode])
  useEffect(() => savePref("arch", showArchived ? "1" : "0"), [showArchived])
  useEffect(() => savePref("lampsOff", LAMP_KEYS.filter((k) => !lamps.includes(k)).join(",")), [lamps])
  useEffect(() => savePref("views", JSON.stringify(views)), [views])
  useEffect(() => savePref("log", JSON.stringify(log)), [log])

  const applyView = (v: SavedView) => {
    setFilter({ query: v.query, group: v.group, sort: v.sort, severity: null, tags: v.tags ?? [] })
    setGroupMode(v.groupMode)
    // 保存的视图来自 localStorage，里面的告警筛选可能已经不成立了：这盏灯被用户在设置里关掉、
    // 或干脆是旧版本才有的类型。照单全收会让看板停在一个没有开关可以退出的筛选里（灯不渲染，
    // 空结果页也没有清除筛选的入口），只能刷新页面；旧类型还会让下面 visible 里的查找落空
    setAttention(v.attention && lamps.includes(v.attention) ? v.attention : null)
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
    const { taskId } = (await res.json()) as TaskStarted
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
      if (!res.ok) {
        const error = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(error?.error ?? `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as RepoStatus | { ok: true }
      if ("id" in updated) setRepos((rs) => mergeRepo(rs, updated))
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }, [message])

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
      const s = (await r.json()) as {
        added: number
        alreadyTracked: number
        restored: number
        kept: number
        missing: { name: string; remote: string | null }[]
      }
      message.success(
        t("msg.importOk", { added: s.added, tracked: s.alreadyTracked }) +
          (s.restored > 0 ? t("msg.importRestored", { n: s.restored }) : "") +
          // 本机已有的标签没被清单覆盖（导入以本机数据优先），说清楚免得用户以为清单没生效
          (s.kept > 0 ? t("msg.importKept", { n: s.kept }) : "") +
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
    async (id: string, patch: { favorite?: boolean; tags?: string[]; group?: string | null; note?: string | null; archived?: boolean; autoPull?: boolean | null }) => {
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
  // 「疑似旧身份」·迁移：服务端验完四道前提后把这条卡路份交回老 id（新铸 id 出账）。
  // 必须整轮重扫而不是 mergeRepo——两张卡合成一张、id 也换了，增量合并表达不了
  const rebindSuspect = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/repos/${id}/rebind`, { method: "POST" })
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) {
          message.warning(t("msg.rebindFail", { err: String(body.error ?? res.status) }))
          return
        }
        message.success(t("msg.rebindOk"))
        await rescan()
      } catch (err) {
        message.warning(t("msg.rebindFail", { err: String(err) }))
      }
    },
    [message, t, rescan],
  )
  // ·忽略：只摘提示，服务端广播 repo:updated 让提示条就地消失，增量合并够用
  const dismissSuspect = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/repos/${id}/suspect-dismiss`, { method: "POST" })
        if (!res.ok) return
        const updated = (await res.json()) as RepoStatus
        setRepos((rs) => mergeRepo(rs, updated))
      } catch {
        // 静默：提示条留着，下一轮或再点一次都不伤数据
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
      setNewParent(parentOf(sample.path, sample.name))
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
        message.error(errText(t, data.error) || t("msg.createFail"))
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
    return parentOf(s.path, s.name)
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
        message.error(errText(t, data.error) || t("msg.cloneFail"))
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

  // 自动化开关状态存服务端 config：三个后台行为**一律默认关闭**——autoWatch 文件监听虽然纯
  // 本地、不走网络，但常驻成本与「看一眼各仓库状态」这个用途不成比例（几个项目同时在跑构建时
  // 内核缓冲区持续溢出，每次溢出都要补一轮全量重扫）；定时远程刷新走网络、
  // notifications 系统通知会打扰。默认路径是兜底定时重扫 + 手动重扫。
  // 抽成具名函数：挂载时调一次，配置错误态里的「重试」按钮也调它——一份逻辑，两处触发
  const loadConfigStatus = useCallback(() => {
    return fetch("/api/config")
      .then((r) => {
        // r.ok 为假时原先直接返回 null、外层 then 里 `if (!c) return` 悄悄跳过——
        // hasRoots 永远停在 null，等价于「一直在加载中」。这里改成抛错走 catch 统一处理
        if (!r.ok) throw new Error(`config fetch failed: ${r.status}`)
        return r.json()
      })
      .then((c) => {
        setAutoWatch(!!c.autoWatch)
        setAutoScanMin(typeof c.autoScanMinutes === "number" ? c.autoScanMinutes : 0)
        setWatchLimit(typeof c.watchLimit === "number" ? c.watchLimit : 0)
        const fetchMinutes = typeof c.autoFetchMinutes === "number" ? c.autoFetchMinutes : 0
        setAutoFetchMinutes(fetchMinutes)
        setFetchMinutesInput(fetchMinutes)
        const exportPath = typeof c.worklogExportPath === "string" ? c.worklogExportPath : ""
        setWorklogExport({ minutes: typeof c.worklogExportMinutes === "number" ? c.worklogExportMinutes : 0, path: exportPath })
        setSavedWorklogPath(exportPath)
        setAutoPull(c.autoPull === true)
        setNotifications(!!c.notifications)
        setCheckUpdates(!!c.checkUpdates)
        setHasRoots(configHasRoots(c))
        setScanRoots(
          [...(Array.isArray(c.roots) ? c.roots : []), ...(Array.isArray(c.manualRepos) ? c.manualRepos : [])].filter(
            (x): x is string => typeof x === "string",
          ),
        )
        setConfigLoaded(true)
      })
      .catch(() => {
        setConfigLoaded(false)
        // 请求真的失败了（后端还在跑启动扫描、休眠唤醒后 socket 被重置等）：hasRoots 置为
        // "unknown"，与「还没拉到结果」的 null 严格区分开——unknown 走明确的错误提示 + 重试
        // 入口，绝不能被当成「确知没配置过」去显示首次运行的欢迎文案
        setHasRoots("unknown")
      })
  }, [])
  const retryConfigStatus = useCallback(() => {
    setHasRoots(null) // 退回「加载中」，与挂载首帧同一个中性态，不是继续停在错误页干等
    void loadConfigStatus()
  }, [loadConfigStatus])
  useEffect(() => {
    void loadConfigStatus()
    fetch("/api/autostart")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) setAutostart(s as { supported: boolean; enabled: boolean })
      })
      .catch(() => {})
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (v) setInstance({ version: String(v.version ?? ""), canQuit: v.canQuit === true, canPickDirectory: v.canPickDirectory === true, manualUpdates: v.manualUpdates === true, port: Number(v.port) || 0 })
      })
      .catch(() => {})
    // loadConfigStatus 是 useCallback([]) 稳定引用，列进依赖数组不会多触发一次——只是照规则补齐
  }, [loadConfigStatus])
  async function toggleAutostart() {
    const next = !autostart.enabled
    setAutostart({ ...autostart, enabled: next })
    try {
      const r = await fetch("/api/autostart", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ enabled: next }) })
      if (!r.ok) throw new Error()
      setAutostart((await r.json()) as { supported: boolean; enabled: boolean }) // 以服务端读回的 OS 实际状态为准
    } catch {
      setAutostart({ ...autostart, enabled: !next }) // 失败回滚
      message.error(t("msg.autostartFail"))
    }
  }
  // 退出后台服务——设置里这个按钮只跟 /api/shutdown 端点是否存在挂钩（canQuit），与打包形态无关
  async function quitApp() {
    let ok = true
    try {
      const r = await fetch("/api/shutdown", { method: "POST", headers: { "x-repo-radar": "shutdown" } })
      ok = r.ok // 404/403（如后端已换成源码模式，端点不存在）不能谎报「已停止」
    } catch {
      // 请求抛错 ≠ 服务已停：可能是网络层瞬时错误（休眠恢复、socket 重置），也可能是响应
      // 在服务端已受理之后丢失。服务端收到退出请求后要留约 200ms 宽限期让响应送达，
      // 期间它仍然应答——所以必须给足时间轮询，只探一次会把「正在退出」误报成「退出失败」
      ok = !(await stillServing())
    }
    if (ok) message.success(t("msg.quitDone"), 8)
    else message.error(t("msg.quitFail"))
  }
  /** 轮询到连不上为止（≈已退出）；到期仍在应答才算真没退 */
  async function stillServing() {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const up = await fetch("/api/version").then(() => true).catch(() => false)
      if (!up) return false
    }
    return true
  }
  async function toggleWatch() {
    const next = !autoWatch
    setAutoWatch(next)
    try {
      const r = await fetch("/api/watch", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ enabled: next }) })
      if (!r.ok) throw new Error()
      void syncScanStatus() // 开/关监听会改变覆盖数，面板上的读数得跟着走
      message.success(next ? t("msg.watchOn") : t("msg.watchOff"))
    } catch {
      setAutoWatch(!next) // 失败回滚
      message.error(t("msg.watchFail"))
    }
  }
  // 通知开关只是个纯配置字段（主进程在事件发生时现读 config），不需要服务端立即起停任何东西，
  // 所以直接走通用的 PUT /api/config，重扫定时器和文件监听各走专用端点。
  async function toggleNotifications() {
    const next = !notifications
    setNotifications(next)
    try {
      const r = await fetch("/api/config", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ notifications: next }) })
      if (!r.ok) throw new Error()
      message.success(next ? t("msg.notifyOn") : t("msg.notifyOff"))
    } catch {
      setNotifications(!next) // 失败回滚：开关显示成开着却没生效，比直接报错更糟
      message.error(t("msg.saveFail"))
    }
  }
  // 启动时检查新版本的开关。**默认关**：会联网的开关一律 opt-in，
  // 而它只发一次请求、只回一句「有没有新版」，不下载也不安装
  async function toggleCheckUpdates() {
    const next = !checkUpdates
    setCheckUpdates(next)
    try {
      const r = await fetch("/api/config", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ checkUpdates: next }) })
      if (!r.ok) throw new Error()
      message.success(next ? t("msg.updateCheckOn") : t("msg.updateCheckOff"))
    } catch {
      setCheckUpdates(!next) // 失败回滚：开关显示成开着却没生效，比直接报错更糟
      message.error(t("msg.saveFail"))
    }
  }
  // 手动检查一次。真正的检查、对话框、下载与安装都在主进程里（原生对话框只能在那儿弹），
  // 这里只负责发起并等结果
  async function checkUpdateNow() {
    setCheckingUpdate(true)
    try {
      const r = await fetch("/api/update/check", {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-repo-radar": "update" },
        body: JSON.stringify({ lang }),
      })
      if (!r.ok) throw new Error()
    } catch {
      message.error(t("msg.updateCheckFail"))
    } finally {
      setCheckingUpdate(false)
    }
  }
  // 桌面端原生文件夹选择器：只在 /api/version 报 canPickDirectory 时由设置面板显示按钮
  async function pickDirectory(): Promise<string | null> {
    const r = await fetch("/api/pick-directory", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-repo-radar": "pick" },
      body: "{}",
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = (await r.json()) as { path?: unknown }
    return typeof body.path === "string" ? body.path : null
  }
  async function changeWatchLimit(limit: number) {
    const prev = watchLimit
    setWatchLimit(limit)
    try {
      const r = await fetch("/api/watch-limit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ limit }) })
      if (!r.ok) throw new Error()
      const { watch } = (await r.json()) as { watch: { watched: number; total: number } }
      setWatchCov(watch) // 服务端算完实际挂了多少，立刻显示出来
      message.success(limit > 0 ? t("msg.watchLimitOn", { n: limit }) : t("msg.watchLimitOff"))
    } catch {
      setWatchLimit(prev) // 失败回滚
      message.error(t("msg.saveFail"))
    }
  }
  async function changeAutoScan(minutes: number) {
    const prev = autoScanMin
    setAutoScanMin(minutes)
    try {
      const r = await fetch("/api/auto-scan", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ minutes }) })
      if (!r.ok) throw new Error()
      message.success(minutes > 0 ? t("msg.scanEveryOn", { n: minutes }) : t("msg.scanEveryOff"))
    } catch {
      setAutoScanMin(prev) // 失败回滚
      message.error(t("msg.scanEveryFail"))
    }
  }
  async function saveRemoteRefreshInterval() {
    const minutes = fetchMinutesInput
    if (minutes === null || minutes === autoFetchMinutes) {
      setFetchMinutesInput(autoFetchMinutes)
      return
    }
    try {
      const r = await fetch("/api/config", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ autoFetchMinutes: minutes }),
      })
      if (!r.ok) throw new Error()
      setAutoFetchMinutes(minutes)
    } catch {
      setFetchMinutesInput(autoFetchMinutes)
      message.error(t("msg.saveFail"))
    }
  }

  async function saveWorklogExport() {
    if (worklogExport.minutes === null || savingWorklogExport) return
    setSavingWorklogExport(true)
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          worklogExportMinutes: worklogExport.minutes,
          worklogExportPath: worklogExport.path.trim(),
        }),
      })
      if (!response.ok) {
        const problem = await response.json().catch(() => null)
        if (response.status === 400 && problem?.field === "worklogExportPath") {
          setInvalidWorklogPath(true)
          return
        }
        throw new Error(problem?.error || t("msg.saveFail"))
      }
      const saved = await response.json()
      setWorklogExport({ minutes: saved.worklogExportMinutes, path: saved.worklogExportPath })
      setSavedWorklogPath(saved.worklogExportPath)
      setInvalidWorklogPath(false)
      message.success(t("settings.worklogExportSaved"))
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("msg.saveFail"))
    } finally {
      setSavingWorklogExport(false)
    }
  }

  async function changeAutoPull(enabled: boolean) {
    try {
      const r = await fetch("/api/config", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ autoPull: enabled }),
      })
      if (!r.ok) throw new Error()
      setAutoPull(enabled)
    } catch {
      message.error(t("msg.saveFail"))
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

  const counts = useMemo(() => {
    // 按「最坏严重度」互斥分桶：一个仓库既有 error 级又有 warn 级健康项时只算 CRIT。
    // 两个桶各数各的会把它计两次，clean = fleet - crit - warn 直接变负数挂在顶栏上
    const isCrit = (r: RepoStatus) => r.error !== null || r.health.some((h) => h.severity === "error")
    const crit = active.filter(isCrit).length
    const warn = active.filter((r) => !isCrit(r) && r.health.some((h) => h.severity === "warn")).length
    return { fleet: active.length, crit, warn, clean: active.length - crit - warn, archived: repos.length - active.length }
  }, [active, repos])
  const stashTotal = useMemo(() => active.reduce((s, r) => s + r.stashCount, 0), [active])

  const isDismissed = useCallback(
    (q: { r: RepoStatus; kind: string; n: number }): boolean => {
      const stored = dismissed[dismissKey(q)]
      if (stored === undefined) return false
      if (q.kind === "stash") return Date.now() - Number(stored) < STASH_SNOOZE_MS
      // ci 的哨兵记录（点已处理时还没拿到 oid）：这轮红持续期间保持已处理，转绿由清理 effect 收走；
      // 只对存量哨兵如此——现在 oid 随轮询必达，新点的已处理都按 oid 记、新失败照常重现
      if (q.kind === "ci" && stored === "0") return true
      if (!COUNT_KINDS.has(q.kind)) return stored === dismissVal(q)
      const { n, base } = parseMark(stored)
      const arrivals = kindArrivals(q.r, q.kind)
      // 服务端记账说「点了已处理之后累计数变过」→ 立刻重现，与这边有没有看见计数下探无关。
      // 比的是 `!==` 而不是 `>`：累计数**变小**不代表「没有新到达」，只可能是服务端那个计数器
      // 被重置了（InboxCache 见 origin url 变了就从 0 重记——HTTPS 换 SSH、GitHub 上改仓库名后
      // 更新远程、加/去 .git 后缀都算；github-inbox.json 损坏或被剪枝同理），而基线存在
      // localStorage、键是 repoId，身份账本保证改远程不换 id，于是旧基线原地不动。
      // 当成「没有新到达」的话，这个功能要修的症状原样复现：通知弹了「PR +2」、用户点进来
      // 队列里却没有这条，而且要再攒够 base+1 次新到达才解除。计数器重置只能靠「对不上」认出来。
      // 保守侧的代价：重置之后这条会多冒一次，用户再点一次 ✓ 就重新对上表。
      // 没有基线（旧格式记录）或服务端没给记账时退回原来的纯水位比较
      if (base !== null && arrivals !== null && arrivals !== base) return false
      return q.n <= n
    },
    [dismissed],
  )
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
  // biome-ignore-start lint/correctness/useExhaustiveDependencies: queueTick 是 10 分钟心跳，本体不读它，
  // 只为让 stash 打盹等到纯时间条件在长开的标签页里被重评
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
  }, [active, isDismissed, queueTick])
  // biome-ignore-end lint/correctness/useExhaustiveDependencies: 心跳豁免块结束
  const dismissItem = (q: { r: RepoStatus; kind: string; n: number }) => setDismissed((d) => ({ ...d, [dismissKey(q)]: dismissVal(q) }))

  // 默认只看未排除的；「已排除」开关切换为只看被排除的那些（便于管理 / 取消排除）
  const excluded = useMemo(() => repos.filter((r) => r.archived), [repos])
  const base = showArchived ? excluded : active
  // 灯的计数必须和灯的筛选数同一批仓库。之前计数走 active、筛选走 base：在「已排除」视图里
  // 顶栏亮着「未提交改动 5」，点下去却是空的——那 5 个都不在这个视图的仓库集合里
  const attn = useMemo(
    () => Object.fromEntries(ATTENTION.map((a) => [a.key, base.filter(a.test).length])) as Record<AttentionKey, number>,
    [base],
  )
  const filtered = useMemo(() => applyFilter(base, filter), [base, filter])
  const visible = useMemo(() => {
    // 找不到就当没筛选：attention 可能来自旧版本存下的保存视图，那时的灯类型现在已经没了
    const rule = attention === null ? undefined : ATTENTION.find((a) => a.key === attention)
    return rule ? filtered.filter(rule.test) : filtered
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
    // t 必须在依赖里：「按语言」分组时它是没有 language 的仓库那一组的**组名**（keyOf 里的
    // t("group.unidentified")）。少了它，切换界面语言后这个组名会一直停在旧语言，与同屏
    // 其余文案对不上，且只有下次仓库更新（repo:updated / 重扫）才纠正——没有 git 活动就是永久错
  }, [visible, groupMode, t])
  const failed = batch?.results.filter((r) => !r.ok) ?? []

  const renderRepo = (r: RepoStatus) => (
    <RepoCard
      key={r.id}
      repo={r}
      compact={repoLayout === "list"}
      selected={selected.has(r.id)}
      clock={clockTick}
      onToggleSelect={toggleSelect}
      onOpen={openRepo}
      onShowDetail={setDetailId}
      onToggleFavorite={toggleFavorite}
      onQuickFilter={quickFilter}
      onFilterTag={filterTag}
      onCopyPath={copyPath}
      onRebindSuspect={rebindSuspect}
      onDismissSuspect={dismissSuspect}
    />
  )

  const hasFilters = Boolean(attention || filter.query || filter.group || filter.tags?.length || filter.severity)
  const clearFilters = () => {
    setFilter((f) => ({ ...f, query: "", group: null, severity: null, tags: [] }))
    setAttention(null)
    setViewName(null)
  }

  const showOverview = view === "board" && !showStash && !showArchived && active.length > 0
  const scanTime = lastScanAt && (
    <p className="rr-scan-time" title={new Date(lastScanAt).toLocaleString(lang, { hour12: false })}>
      {t("bar.lastScan", { t: relativeTime(lastScanAt) })}
    </p>
  )

  const stashLink = (stashTotal > 0 || showStash) && (
    <Tooltip title={showStash ? undefined : t("annun.stashViewTip")} trigger={["hover", "focus"]}>
      <Button
        onClick={() => {
          if (!showStash) setShowArchived(false)
          setShowStash(!showStash)
        }}
      >
        {showStash ? t("annun.backToRepos") : t("annun.stashView", { n: stashTotal })}
      </Button>
    </Tooltip>
  )
  const archiveLink = (counts.archived > 0 || showArchived) && (
    <Tooltip title={showArchived ? undefined : t("annun.archivedViewTip")} trigger={["hover", "focus"]}>
      <Button
        onClick={() => {
          if (!showArchived) setShowStash(false)
          setShowArchived(!showArchived)
        }}
      >
        {showArchived ? t("annun.backToRepos") : t("annun.archivedView", { n: counts.archived })}
      </Button>
    </Tooltip>
  )

  const brand = (
    <div className="rr-brand">
      <ScopeMark size={32} />
      <span>repo<span className="d">·</span>radar</span>
    </div>
  )

  return (
    <>
      <header className="rr-shell-header" ref={headerRef}>
        <div className="rr-window-bar">{brand}</div>
        <div className="rr-bar">
          {brand}
          <Segmented<typeof view>
            className="rr-nav"
            value={view}
            onChange={(next) => {
              setView(next)
              window.scrollTo(0, 0)
            }}
            options={[
              { label: t("nav.board"), value: "board" },
              { label: t("nav.stats"), value: "stats" },
              { label: t("nav.worklog"), value: "worklog" },
              { label: t("nav.log"), value: "log" },
            ]}
          />
          {view === "board" && !showStash && repos.length > 0 && (
            <Segmented<RepoLayout>
              className="rr-layout-switch"
              aria-label={t("board.layout")}
              size="small"
              value={repoLayout}
              onChange={changeRepoLayout}
              options={[
                { label: t("board.cards"), value: "cards" },
                { label: t("board.list"), value: "list" },
              ]}
            />
          )}
          <div className="rr-bar-status">
            {!showOverview && scanTime}
            <Button loading={scanning} onClick={rescan} disabled={!hasRoots} title={hasRoots ? undefined : t("empty.welcomeCta")}>
              {scanning ? (scanProgress ? t("bar.scanProgress", { done: scanProgress.scanned, total: scanProgress.total }) : t("bar.scanning")) : t("bar.rescan")}
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: "scan", label: t("empty.welcomeCta") },
                  { type: "divider" },
                  { key: "new", label: t("add.new") },
                  { key: "clone", label: t("add.clone") },
                  { type: "divider" },
                  { key: "export", label: t("add.export") },
                  { key: "import", label: t("add.import") },
                ],
                onClick: ({ key }) => {
                  if (key === "scan") openScanSettings()
                  else if (key === "new") openNewProject()
                  else if (key === "clone") openClone()
                  else if (key === "export") exportManifest()
                  else if (key === "import") manifestFileRef.current?.click()
                },
              }}
            >
              <Button type="primary">
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
            <Button
              className="rr-gear"
              aria-label={t("settings.title")}
              /* 高亮只标「用户自己额外开的后台行为」。文件监听改成默认关闭之后它也算一个——
                 而且是这一组里最贵的那个（常驻句柄 + 溢出补票的全量重扫）。此前它默认开着，
                 算进来会让齿轮永远亮着、信号归零，所以那时刻意排除在外 */
              type={autoWatch || autoFetchMinutes > 0 || notifications || (!instance.manualUpdates && checkUpdates) ? "primary" : "default"}
              ghost={autoWatch || autoFetchMinutes > 0 || notifications || (!instance.manualUpdates && checkUpdates)}
              /* 图标按钮没有可读文字，tooltip 就是它的名字，说清「点了会发生什么」即可。
                 原来那条是「设置：主题 · 自动扫描 · 定时拉取 · 提醒」——枚举了 4 项而设置里现在有十来项，
                 还把「GitHub 提醒」称作「提醒」，界面上同一个东西两个叫法 */
              title={t("settings.title")}
              onClick={openSettings}
            >
              ⚙
            </Button>
          </div>
        </div>
        <Modal
          open={settingsOpen}
          onCancel={() => setSettingsOpen(false)}
          title={t("settings.title")}
          width={740}
          centered
          classNames={{
            container: "rr-settings-container",
            body: "rr-settings-viewport",
            footer: "rr-settings-footer",
          }}
          footer={
            <div className="rr-settings-foot">
              {instance.version !== "" && (
                // 端口跟在版本号后面，不另起一行、也不新增文案键：数字本身就说明问题，
                // 而 18 份翻译为一个端口号加一条新字符串不值当
                <span className="rr-ver" title={t("settings.versionHint")}>
                  v{instance.version}
                  {instance.port > 0 && ` · 127.0.0.1:${instance.port}`}
                </span>
              )}
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
          <div className="rr-settings-body">
            <Segmented
              value={settingsTab}
              onChange={(v) => setSettingsTab(v as SettingsTab)}
              options={SETTINGS_TABS.map(({ key, labelKey }) => ({ label: t(labelKey), value: key }))}
            />
            {settingsTab === "general" && (
            <div className="rr-settings">
              {/* 显示：语言与主题——纯展示偏好放在最前 */}
              <div className="grp">{t("settings.grpDisplay")}</div>
              <div className="row">
                <span className="lb">{t("settings.language")}</span>
                <Select
                  size="small"
                  value={lang}
                  style={{ width: 138 }}
                  onChange={(v) => setLang(v)}
                  showSearch={{ optionFilterProp: "label" }}
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
              {/* 告警灯：直接把顶栏那排灯摆进来，亮=会显示、暗=已关掉，点一下切换。
                  原先是 antd 多选框，六盏灯被 maxTagCount 折叠成「+ 6 …」——这个控件唯一的
                  职责就是告诉你哪几盏开着，而它恰恰什么都没说，非得点开下拉才知道。
                  换成实物之后：状态零点击可读，改动一点击完成，颜色与顶栏同源（crit/warn），
                  所见即所得；顺带没了下拉搜索，也就没了「搜中文搜不到」那类问题 */}
              <div className="row stack">
                <span className="lb">
                  {t("settings.lamps")}<span className="hint">{t("settings.lampsHint")}</span>
                </span>
                <div className="rr-lamp-pick">
                  {ATTENTION.map((a) => {
                    const on = lamps.includes(a.key)
                    const button = (
                      <button
                        key={a.key}
                        type="button"
                        className={a.sev}
                        aria-pressed={on}
                        onClick={() => {
                          const next = on ? lamps.filter((k) => k !== a.key) : LAMP_KEYS.filter((k) => k === a.key || lamps.includes(k))
                          setLamps(next)
                          // 关掉的那盏灯正被当作筛选条件时，看板会卡在一个没有开关可以退出的筛选里
                          if (attention && !next.includes(attention)) setAttention(null)
                        }}
                      >
                        <span className="d" />
                        {t(a.labelKey)}
                      </button>
                    )
                    return a.tipKey ? (
                      <Tooltip key={a.key} title={t(a.tipKey)} trigger={["hover", "focus"]}>{button}</Tooltip>
                    ) : button
                  })}
                </div>
              </div>
              {/* 本地刷新 / 联网与提醒 分成两组：组标题本身承载产品的成本模型——本地、
                  不走网络的行为默认开；会发请求或打扰人的行为一律 opt-in。混在一个「自动化」
                  组里时这条界线是隐形的，用户分不清哪个开关有网络代价 */}
              <div className="grp">{t("settings.grpLocal")}</div>
              <div className="row">
                <span className="lb">
                  {t("settings.autoScan")}<span className="hint">{t("settings.autoScanHint")}</span>
                </span>
                <Switch size="small" aria-label={t("settings.autoScan")} checked={autoWatch} onChange={toggleWatch} disabled={!configLoaded} />
              </div>
              {/* 监听上限：真正的约束是文件句柄和 CPU（每个仓库 4 个监听目标），而这在
                  Linux（调大 inotify.max_user_watches 后能上几千）、Windows、网络盘之间
                  差一个数量级——没有哪个硬编码值对所有人都对，所以交给用户。
                  sub 缩进 + 连接线：它是上面开关的子参数，开关关掉整行收起。
                  hint 是实况读数而不是静态说明：正常时报「正在监听全部 N 个」，截断时换
                  琥珀色实数——只写服务端日志的话，常驻托盘的应用等于什么都没说，
                  用户没法回答「为什么这个仓库不自动刷新」。扫描还没跑完（0/0）才退回说明文案 */}
              {autoWatch && (
                <div className="row sub">
                  <span className="lb">
                    {t("settings.watchLimit")}
                    <span className={`hint${watchCov.total > watchCov.watched ? " warn" : ""}`}>
                      {watchCov.total > watchCov.watched
                        ? // "其余靠兜底重扫" 这句只有兜底重扫开着才成立——autoScanMinutes 为 0 时
                          // 没被监听覆盖的仓库根本没有任何自动刷新途径，说"靠重扫"是在撒谎
                          autoScanMin > 0
                          ? t("settings.watchLimitCapped", { watched: watchCov.watched, total: watchCov.total })
                          : t("settings.watchLimitCappedNoRescan", { watched: watchCov.watched, total: watchCov.total })
                        : watchCov.total > 0
                          ? t("settings.watchLive", { n: watchCov.total })
                          : t("settings.watchLimitHint")}
                    </span>
                  </span>
                  <Select
                    size="small"
                    value={watchLimit}
                    style={{ width: 96 }}
                    onChange={changeWatchLimit}
                    disabled={!configLoaded}
                    options={[
                      { label: t("watch.unlimited"), value: 0 },
                      { label: "100", value: 100 },
                      { label: "200", value: 200 },
                      { label: "500", value: 500 },
                      { label: "1000", value: 1000 },
                    ]}
                  />
                </div>
              )}
              {/* 兜底重扫独立于上面的开关：文件监听最不可靠的场合（网络盘、WSL、云同步目录、
                  机器休眠）恰恰就是最需要它的场合，把它挂在 autoWatch 下面反而会一起失效 */}
              <div className="row">
                <span className="lb">
                  {t("settings.scanEvery")}
                  {/* 自动扫描一关，这个定时器就是看板唯一的自动刷新途径——后果要在
                      做决定的现场说出来，而不是让用户以后纳闷看板为什么不动了 */}
                  <span className="hint">{autoWatch ? t("settings.scanEveryHint") : t("settings.scanEveryOnly")}</span>
                </span>
                <Select
                  size="small"
                  value={autoScanMin}
                  style={{ width: 96 }}
                  onChange={changeAutoScan}
                  disabled={!configLoaded}
                  options={[
                    { label: t("fetch.off"), value: 0 },
                    { label: t("fetch.min", { n: 10 }), value: 10 },
                    { label: t("fetch.min", { n: 30 }), value: 30 },
                    { label: t("fetch.min", { n: 60 }), value: 60 },
                    { label: t("fetch.min", { n: 180 }), value: 180 },
                  ]}
                />
              </div>
              <div className="grp">{t("settings.worklogExport")}</div>
              <form onSubmit={(event) => {
                event.preventDefault()
                void saveWorklogExport()
              }}>
                <div className="row">
                  <label className="lb" htmlFor="worklog-export-minutes">
                    {t("settings.worklogExportMinutes")}
                    <span className="hint">{t("settings.worklogExportMinutesHint")}</span>
                  </label>
                  <InputNumber
                    id="worklog-export-minutes"
                    size="small"
                    style={{ width: 96 }}
                    min={0}
                    precision={0}
                    value={worklogExport.minutes}
                    onChange={(minutes) => setWorklogExport((draft) => ({ ...draft, minutes }))}
                    disabled={!configLoaded || savingWorklogExport}
                  />
                </div>
                <div className="row stack">
                  <label className="lb" htmlFor="worklog-export-path">
                    {t("settings.worklogExportPath")}
                    <span className="hint">{t("settings.worklogExportPathHint")}</span>
                  </label>
                  <Input
                    id="worklog-export-path"
                    dir="ltr"
                    size="small"
                    placeholder="worklog.json"
                    value={worklogExport.path}
                    status={invalidWorklogPath ? "error" : undefined}
                    aria-invalid={invalidWorklogPath}
                    aria-describedby={invalidWorklogPath ? "worklog-export-path-error" : undefined}
                    onChange={(event) => {
                      const path = event.target.value
                      setInvalidWorklogPath(false)
                      setWorklogExport((draft) => ({ ...draft, path }))
                    }}
                    disabled={!configLoaded || savingWorklogExport}
                  />
                  {invalidWorklogPath && (
                    <span id="worklog-export-path-error" className="hint warn" role="alert">
                      {t("settings.worklogExportPathInvalid")}
                    </span>
                  )}
                  <Button
                    size="small"
                    htmlType="submit"
                    loading={savingWorklogExport}
                    disabled={!configLoaded || worklogExport.minutes === null}
                  >
                    {t("settings.worklogExportSave")}
                  </Button>
                </div>
              </form>
              {settingsOpen && configLoaded && (
                <WorklogExportStatusPanel
                  key={savedWorklogPath}
                  disabled={savingWorklogExport || worklogExport.path.trim() !== savedWorklogPath}
                />
              )}
              {/* 从这里开始的开关有网络代价或会打扰人——这正是它们默认关闭的原因，
                  组标题把这条线画给用户看。齿轮的高亮逻辑与本组一致：本组有开启项才点亮 */}
              <div className="grp">{t("settings.grpNetwork")}</div>
              <div className="row">
                <span className="lb">
                  {t("settings.remoteRefreshInterval")}<span className="hint">{t("settings.remoteRefreshHint")}</span>
                </span>
                <InputNumber
                  size="small"
                  aria-label={t("settings.remoteRefreshInterval")}
                  style={{ width: 96 }}
                  min={0}
                  precision={0}
                  value={fetchMinutesInput}
                  onChange={setFetchMinutesInput}
                  onBlur={() => void saveRemoteRefreshInterval()}
                  onPressEnter={(event) => event.currentTarget.blur()}
                  disabled={!configLoaded}
                />
              </div>
              <div className="row">
                <span className="lb">
                  {t("settings.autoPull")}<span className="hint">{t("settings.autoPullHint")}</span>
                </span>
                <Switch size="small" aria-label={t("settings.autoPull")} checked={autoPull} onChange={changeAutoPull} disabled={!configLoaded} />
              </div>
              <div className="row">
                <span className="lb">
                  {t("settings.notify")}<span className="hint">{t("settings.notifyHint")}</span>
                </span>
                <Switch size="small" aria-label={t("settings.notify")} checked={notifications} onChange={toggleNotifications} disabled={!configLoaded} />
              </div>
              {/* 更新检查：开关管的是「每次启动顺手问一句」，按钮管的是「现在问」。
                  两件事分开是因为它们回答的不是同一个问题——用户可能不想让应用
                  每次启动都联网，但此刻想知道有没有新版 */}
              {!instance.manualUpdates && (
                <div className="row">
                  <span className="lb">
                    {t("settings.checkUpdates")}<span className="hint">{t("settings.checkUpdatesHint")}</span>
                  </span>
                  <Switch size="small" aria-label={t("settings.checkUpdates")} checked={checkUpdates} onChange={toggleCheckUpdates} disabled={!configLoaded} />
                </div>
              )}
              <div className="row">
                <span className="lb">
                  {instance.manualUpdates ? t("settings.checkUpdates") : t("settings.checkUpdatesNow")}
                  {!instance.manualUpdates && <span className="hint">{t("settings.checkUpdatesNowHint")}</span>}
                </span>
                <Button size="small" loading={checkingUpdate} onClick={() => void checkUpdateNow()}>
                  {instance.manualUpdates ? t("update.openReleases") : t("settings.checkUpdatesNowBtn")}
                </Button>
              </div>
              {/* 系统：本机/本实例相关的两个动作。它们和上面的开关一样即时生效，
                  所以是「常规」里的一个分组，不值得单开一栏——版本和 GitHub 链接搬去页脚之后，
                  这一栏就只剩这两行了 */}
              <div className="grp">{t("settings.grpSystem")}</div>
              {autostart.supported && (
                <div className="row">
                  <span className="lb">
                    {t("settings.autostart")}<span className="hint">{t("settings.autostartHint")}</span>
                  </span>
                  <Switch size="small" aria-label={t("settings.autostart")} checked={autostart.enabled} onChange={() => void toggleAutostart()} />
                </div>
              )}
              {instance.canQuit && (
                <div className="row">
                  <span className="lb">
                    {t("settings.quit")}<span className="hint">{t("settings.quitHint")}</span>
                  </span>
                  <Popconfirm
                    title={t("settings.quitConfirm")}
                    description={t("settings.quitHint")}
                    okText={t("settings.quitBtn")}
                    cancelText={t("modal.cancel")}
                    onConfirm={() => void quitApp()}
                  >
                    <Button size="small" danger>
                      {t("settings.quitBtn")}
                    </Button>
                  </Popconfirm>
                </div>
              )}
            </div>
            )}
            {/* 扫描与打开方式独立成栏。open 只跟弹窗开合走、不跟分栏走：切到别的栏只是把它藏起来，
                这样敲了一半还没保存的路径不会因为切栏被抹掉（代价是弹窗一开就拉一次 /api/config，
                本机一个 GET，换不丢用户输入很划算） */}
            <ScanConfigEditor
              key={scanSettingsSession}
              open={settingsOpen}
              hidden={settingsTab !== "scan"}
              onClose={() => setSettingsOpen(false)}
              pickDirectory={instance.canPickDirectory ? pickDirectory : undefined}
              onSaved={() => {
                void rescan()
                // 保存后同步「是否已配置扫描来源」，欢迎页/空状态的分流才不会用旧值；
                // 复用 loadConfigStatus 而不是另抄一份 fetch——两处对 hasRoots 的写入必须走同一套判定
                void loadConfigStatus()
              }}
            />
          </div>
        </Modal>
      </header>

      {batch && (
        <div className="rr-annun" role="status">
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: batch.finished ? (failed.length > 0 ? "var(--crit)" : "var(--ok)") : "var(--text)",
            }}
          >
            {batchBannerText(batch, failed)}
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
        title={
          <span className="mono" style={{ color: "var(--hi)" }}>
            {t("exec.outputTitle", { action: batchActionWord(batch?.action ?? "", batch?.dryRun) })}
          </span>
        }
        styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
      >
        {batch?.results.map((r) => (
          <div key={r.repoId} style={{ marginBottom: 14 }}>
            <div className="mono" style={{ fontSize: 12, color: r.ok ? "var(--ok)" : "var(--crit)" }}>
              {r.ok ? "✓" : "✗"} {r.name}
              {/* 退出码与错误说明分两段：退出码是数字（本地化的 exec.exit），
                  错误说明是服务端给的**错误码**（本地化由 errText 负责，细节原样附后） */}
              {typeof r.code === "number" && ` · ${t("exec.exit", { code: r.code })}`}
              {r.message !== "" && ` · ${errText(t, r.message)}`}
            </div>
            {r.output !== undefined && r.output !== "" && (
              <pre className="rr-exec-out">{r.output}</pre>
            )}
          </div>
        ))}
      </Modal>

      {view === "worklog" ? (
        <WorklogView lastScanAt={lastScanAt} onOpenRepo={showRepoDetail} />
      ) : view === "stats" ? (
        <StatsView lastScanAt={lastScanAt} onOpenRepo={showRepoDetail} />
      ) : view === "log" ? (
        <main className="rr-main rr-secondary">
          <div className="rr-board-head">
            <h1>{t("log.title")}</h1>
            {log.length > 0 && (
              <Button onClick={() => setLog([])}>
                {t("log.clear")}
              </Button>
            )}
          </div>
          {log.length === 0 ? (
            <div className="rr-empty">{t("log.empty")}</div>
          ) : (
            <div className="rr-actlist rr-log-list">
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
        </main>
      ) : showStash ? (
        <main className="rr-main rr-secondary">
          <div className="rr-board-head">
            <h1>{t("annun.stashView", { n: stashTotal })}</h1>
            <div className="rr-board-links">
              {archiveLink}
              {stashLink}
            </div>
          </div>
          <StashView onLog={addLog} />
        </main>
      ) : (
        <main className="rr-main" ref={boardRef}>
          {showOverview && (
            <div className="rr-overview">
              <section className="rr-health">
                <div className="rr-health-head">
                  <h2>{t("board.health")}</h2>
                  <strong title={t("stats.totalRepos")}>{counts.fleet}</strong>
                </div>
                <div className="rr-health-bar" aria-hidden="true">
                  {counts.crit > 0 && <span className="crit" style={{ flexGrow: counts.crit }} />}
                  {counts.warn > 0 && <span className="warn" style={{ flexGrow: counts.warn }} />}
                  {counts.clean > 0 && <span className="ok" style={{ flexGrow: counts.clean }} />}
                </div>
                <dl className="rr-health-legend">
                  <div className="crit"><dt>{t("board.critical")}</dt><dd>{counts.crit}</dd></div>
                  <div className="warn"><dt>{t("board.warning")}</dt><dd>{counts.warn}</dd></div>
                  <div className="ok"><dt>{t("board.healthy")}</dt><dd>{counts.clean}</dd></div>
                </dl>
                {scanTime}
              </section>
              <CockpitHero
                queue={actionQueueVisible}
                onOpenRepo={showRepoDetail}
                onOpenStash={() => setShowStash(true)}
                onPush={(id) => runBatch("push", [id])}
                onDismiss={dismissItem}
                open={cockpitOpen}
                onToggle={() => setCockpitOpen((v) => !v)}
              />
            </div>
          )}
          <div className="rr-board-head">
            <h1>
              {showArchived ? t("annun.archivedView", { n: visible.length }) : t("board.repositories")}
              {!showArchived && repos.length > 0 && <span aria-live="polite">{t("board.count", { n: visible.length })}</span>}
            </h1>
            <div className="rr-board-links">
              {stashLink}
              {archiveLink}
            </div>
          </div>
          {repos.length > 0 && (
            <div className="rr-board-tools">
              <div className="rr-search-group">
                <Input
                  allowClear
                  value={filter.query}
                  onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                  prefix={
                    <svg className="rr-search-ic" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <circle cx="7" cy="7" r="4.6" />
                      <path d="M10.4 10.4 L14 14" strokeLinecap="round" />
                    </svg>
                  }
                  placeholder={t("bar.search")}
                  className="rr-search"
                  aria-label={t("bar.search")}
                />
                <Button size="small" type="text" className="rr-kbd" onClick={() => setPaletteOpen(true)} aria-label={t("bar.paletteTip")} title={t("bar.paletteTip")}>
                  {KBD_MOD} K
                </Button>
              </div>
              <div className="rr-list-controls">
                <Select
                  value={filter.group ?? ""}
                  className="rr-bar-sel"
                  prefix={<SelIcon kind="filter" />}
                  aria-label={t("bar.groupFilterTip")}
                  title={t("bar.groupFilterTip")}
                  onChange={(v) => setFilter({ ...filter, group: v || null })}
                  options={[{ label: t("bar.allGroups"), value: "" }, ...groups.map((g) => ({ label: g, value: g }))]}
                />
                {allTags.length > 0 && (
                  <Select
                    mode="multiple"
                    allowClear
                    maxTagCount="responsive"
                    className="rr-bar-sel tags"
                    placeholder={t("bar.tagFilter")}
                    value={filter.tags ?? []}
                    onChange={(vals) => setFilter((f) => ({ ...f, tags: vals }))}
                    aria-label={t("bar.tagFilter")}
                    title={t("bar.tagFilterTip")}
                    options={allTags.map((tag) => ({ label: `#${tag}`, value: tag }))}
                  />
                )}
                <Select
                  value={filter.sort}
                  className="rr-bar-sel wide"
                  prefix={<SelIcon kind="sort" />}
                  aria-label={t("bar.sortTip")}
                  title={t("bar.sortTip")}
                  onChange={(v) => setFilter({ ...filter, sort: v as FilterState["sort"] })}
                  options={[
                    { label: t("sort.activity"), value: "activity" },
                    { label: t("sort.commit"), value: "commit" },
                    { label: t("sort.name"), value: "name" },
                    { label: t("sort.opened"), value: "opened" },
                  ]}
                />
                <Select
                  value={groupMode}
                  className="rr-bar-sel narrow"
                  prefix={<SelIcon kind="group" />}
                  aria-label={t("bar.groupModeTip")}
                  title={t("bar.groupModeTip")}
                  onChange={(v) => setGroupMode(v)}
                  options={[
                    { label: t("group.folder"), value: "folder" },
                    { label: t("group.language"), value: "language" },
                    { label: t("group.none"), value: "none" },
                  ]}
                />
                {views.length > 0 && (
                  <Select
                    className="rr-bar-sel"
                    placeholder={t("bar.view")}
                    aria-label={t("bar.view")}
                    title={t("bar.viewTip")}
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
              </div>
            </div>
          )}
          {repos.length > 0 && (hasFilters || ATTENTION.some((a) => attn[a.key] > 0 && lamps.includes(a.key))) && (
            <div className="rr-state-filters">
              {ATTENTION.map((a) => {
                const n = attn[a.key]
                if (attention !== a.key && (n === 0 || !lamps.includes(a.key))) return null
                const button = (
                  <button
                    key={a.key}
                    type="button"
                    className={`rr-lamp ${a.sev}${attention === a.key ? " on" : ""}`}
                    onClick={() => setAttention(attention === a.key ? null : a.key)}
                    aria-pressed={attention === a.key}
                  >
                    <span className="dotm" />
                    <span className="lb">{t(a.labelKey)}</span>
                    <span className="ct">{n}</span>
                  </button>
                )
                return a.tipKey ? (
                  <Tooltip key={a.key} title={t(a.tipKey)} trigger={["hover", "focus"]}>{button}</Tooltip>
                ) : button
              })}
              {hasFilters && <Button type="text" onClick={clearFilters}>{t("board.clearFilters")}</Button>}
            </div>
          )}
          {((attention && LAMP_OP[attention] && visible.length > 0) || selected.size > 0) && (
            <div className="rr-batch-tools">
              {attention && LAMP_OP[attention] && visible.length > 0 && (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={() => runBatch(LAMP_OP[attention]!, visible.map((r) => r.id))}
                >
                  {t("annun.batchAll", { op: actionWord(LAMP_OP[attention]!), n: visible.length })}
                </Button>
              )}
              {selected.size > 0 && (
                <>
                  <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
                    {t("annun.selected", { n: selected.size })}
                  </span>
                  {(["fetch", "pull", "push"] as const).map((a) => (
                    <Button key={a} size="small" onClick={() => runBatch(a, [...selected])}>
                      {t("annun.batch", { action: actionWord(a) })}
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
            </div>
          )}
          {(() => {
            const faves = active.filter((r) => r.favorite)
            const browsing = !hasFilters && !showArchived
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
                  <button type="button" key={r.id} className="rr-fave" title={t("fav.openTip", { name: r.name })} onClick={() => openRepo(r.id, "editor")}>
                    <span className="dot" style={{ background: favSev(r) }} />
                    {r.name}
                  </button>
                ))}
              </div>
            )
          })()}
          {sections === null ? (
            <div className={repoLayout === "list" ? "rr-repo-list" : "rr-grid"}>
              {visible.map(renderRepo)}
            </div>
          ) : (
            sections.map(([group, rs]) => (
              <section key={group}>
                <div className="rr-ghd">
                  <span className="nm">{group}</span>
                  <span className="ct">{t("board.count", { n: rs.length })}</span>
                  <span className="ln" />
                </div>
                <div className={repoLayout === "list" ? "rr-repo-list" : "rr-grid"}>{rs.map(renderRepo)}</div>
              </section>
            ))
          )}
          {loadError !== null && <div className="rr-empty err">{loadError}</div>}
          {/* 空状态：三态分流交给 resolveEmptyArea 纯函数（好单测）。要点是永远不能把
              「不知道」显示成「首次运行」——loading（配置请求还没回来）和 configError（请求确实
              失败了）都要有各自明确的展示，只有确知 hasRoots===false 才走欢迎页；任何一种都不能
              导致主区域什么都不渲染 */}
          {(() => {
            const area = resolveEmptyArea({ loadError, scanning, hasRoots, reposCount: repos.length })
            if (area === "hidden") return null
            if (area === "loading") {
              // 中性加载态：既不是欢迎页也不是空白，避免被误当成「你还没配置过」
              return <div className="rr-empty">{t("common.loading")}</div>
            }
            if (area === "configError") {
              return (
                <div className="rr-welcome">
                  <div className="tt">{t("empty.configErrorTitle")}</div>
                  <div className="ht">{t("empty.configErrorHint")}</div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                    <Button onClick={retryConfigStatus}>{t("common.retry")}</Button>
                    <Button type="primary" ghost onClick={openScanSettings}>
                      {t("empty.welcomeCta")}
                    </Button>
                  </div>
                </div>
              )
            }
            if (area === "welcome") {
              // 首次使用：明确还没配置任何扫描来源——引导用户添加扫描目录；
              // 已配置但扫出 0 个仓库的场景走下面的「未发现仓库」，不能假装人家没配置过
              return (
                <div className="rr-welcome">
                  <div className="tt">{t("empty.welcomeTitle")}</div>
                  <div className="ht">{t("empty.welcomeHint")}</div>
                  <Button type="primary" onClick={openScanSettings}>
                    {t("empty.welcomeCta")}
                  </Button>
                </div>
              )
            }
            // area === "list"：已有卡片时这里什么都不必加；已知配置过但扫出 0 个/筛掉全部时给出对应文案
            return (
              visible.length === 0 && (
                <div className="rr-empty">
                  {showArchived
                    ? t("empty.noArchived")
                    : hasFilters
                      ? t("empty.noMatch")
                      : t("empty.noRepos", { roots: scanRoots.join(" · ") })}
                  {!showArchived && !hasFilters && repos.length === 0 && (
                    <div>
                      <Button type="link" onClick={openScanSettings}>{t("empty.editScanRoots")}</Button>
                    </div>
                  )}
                </div>
              )
            )
          })()}
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
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }} htmlFor="rr-new-parent">
            {t("new.parentLabel")}
            <Input id="rr-new-parent" value={newParent} onChange={(e) => setNewParent(e.target.value)} placeholder="D:\\...\\Projects\\365" />
          </label>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }} htmlFor="rr-new-name">
            {t("new.nameLabel")}
            <Input
              id="rr-new-name"
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
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }} htmlFor="rr-clone-url">
            {t("clone.urlLabel")}
            <Input
              id="rr-clone-url"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              autoFocus
            />
          </label>
          <label className="mono" style={{ fontSize: 12, color: "var(--dim)" }} htmlFor="rr-clone-parent">
            {t("clone.parentLabel")}
            <Input id="rr-clone-parent" value={cloneParent} onChange={(e) => setCloneParent(e.target.value)} placeholder="D:\\...\\Projects" />
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
