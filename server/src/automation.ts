import { type Config, loadConfig, MAX_INTERVAL_MINUTES, saveConfig } from "./config"
import type { RepoStatus } from "./types"
import type { RepoWatcher } from "./watcher"

/** 监听覆盖情况：total 是本该监听的仓库数（非归档），watched 是名额内实际挂上的 */
export interface WatchCoverage {
  watched: number
  total: number
}

export interface AutomationDeps {
  configFile: string
  watcher: RepoWatcher
  listRepos: () => RepoStatus[]
  /** 兜底定时重扫要跑的动作；用调用方的重扫链，定时触发撞上手动重扫时不会叠成两轮 */
  rescan: () => Promise<unknown>
  /** 定时后台 fetch 要跑的动作 */
  fetchAll: () => Promise<void>
  log?: (msg: string) => void
}

/**
 * 后台自动化的装表台：文件监听 + 兜底重扫定时器 + 定时 fetch 定时器。
 *
 * 抽出来是因为这三件事共用一组容易写错的约束（间隔夹逼、只重装真变了的、上限截断要
 * 如实说出来），散在 createBackend 那个几百行的闭包里时，每加一处就得把这些约束重新
 * 想一遍——两轮评审里有一半的缺陷出在这。
 */
export interface Automation {
  /** 按 enabled 装/拆文件监听。repos 传入可省一次 store.list()（扫描后调用时用） */
  applyWatch(enabled: boolean, repos?: RepoStatus[]): Promise<void>
  setWatch(enabled: boolean): Promise<void>
  setAutoScan(minutes: number): Promise<void>
  setAutoFetch(minutes: number): Promise<void>
  setWatchLimit(limit: number): Promise<void>
  /** PUT /api/config 落盘后调用：逐字段与旧值比对，只重装真变了的 */
  applyConfig(next: Config, prev: Config): Promise<void>
  /** 启动时按配置装上两个定时器（监听由首轮扫描的 applyWatch 负责） */
  start(cfg: Config): void
  /** 退出时拆掉两个定时器（监听的关闭走 shutdown 的 closeWatcher） */
  stop(): void
  /** 最近一次 applyWatch 的覆盖情况，供界面如实显示「250 个中监听 200 个」 */
  coverage(): WatchCoverage
}

/** 分钟 → 毫秒，夹在 [1, MAX_INTERVAL_MINUTES]。手改配置文件绕得过 API 校验：
 *  上限防 setInterval 溢出 32 位被钳成 1ms；下限防写个 0.001 变成 60ms 的扫描死循环。
 *  只在 minutes > 0（功能开着）时调用，所以下限取 1 分钟不会把「关」变成「开」 */
export const intervalMs = (minutes: number): number => Math.min(Math.max(minutes, 1), MAX_INTERVAL_MINUTES) * 60_000

/** 最近提交的时间戳（毫秒）；没有提交/解析不了按最旧算。
 *  必须先解析成时间戳再比：lastCommit.date 是带各自时区偏移的 ISO（git %aI），
 *  字符串比较会按墙钟文本排错序（worklog.ts 里同一个坑有详注）——UTC 的新提交会输给
 *  +08:00 的旧提交 */
const commitTs = (r: RepoStatus): number => {
  const t = r.lastCommit?.date ? Date.parse(r.lastCommit.date) : Number.NaN
  return Number.isNaN(t) ? 0 : t
}

/** 监听名额不够时的取舍顺序：收藏优先，其次按最近提交。
 *  收藏是用户明确标记过「这个重要」的信号，不该输给一个刚好被人提交过的没标记仓库——
 *  只按提交时间排的话，一个 CI 机器人的提交就能把用户天天开的仓库挤出监听名额 */
const byWatchPriority = (a: RepoStatus, b: RepoStatus): number =>
  a.favorite !== b.favorite ? (a.favorite ? -1 : 1) : commitTs(b) - commitTs(a)

/** 周期定时器：装、拆、按新间隔重装都走这里。两个定时器逐行相同，只有要跑的动作不一样 */
function createTimer(run: () => void): { apply: (minutes: number) => void } {
  let handle: ReturnType<typeof setInterval> | null = null
  return {
    apply(minutes: number) {
      if (handle) {
        clearInterval(handle)
        handle = null
      }
      if (minutes > 0) handle = setInterval(run, intervalMs(minutes))
    },
  }
}

export function createAutomation(deps: AutomationDeps): Automation {
  const { configFile, watcher, listRepos, rescan, fetchAll } = deps
  const log = deps.log ?? ((m: string) => console.log(m))
  let coverage: WatchCoverage = { watched: 0, total: 0 }

  /** 读-改-存单个配置字段。三个开关都是这个形状，抽出来免得落盘口径各写一遍 */
  function persist<K extends keyof Config>(key: K, value: Config[K]): void {
    const cfg = loadConfig(configFile)
    cfg[key] = value
    saveConfig(configFile, cfg)
  }

  /** applyWatch 的吞错版：配置已落盘的路径用它——监听器失败不该推翻已保存的设置 */
  async function applyWatchLogged(enabled: boolean): Promise<void> {
    try {
      await applyWatch(enabled)
    } catch (err) {
      log(`[repo-radar] 配置已保存，但重装监听器失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const scanTimer = createTimer(() => {
    void rescan().catch((err) => {
      log(`[repo-radar] 兜底重扫失败：${err instanceof Error ? err.message : String(err)}`)
    })
  })
  const fetchTimer = createTimer(() => void fetchAll())

  async function applyWatch(enabled: boolean, repos?: RepoStatus[]): Promise<void> {
    if (!enabled) {
      coverage = { watched: 0, total: 0 }
      await watcher.close()
      return
    }
    // 不监听「已排除」的仓库——它们从看板/统计/后台处理里都收起
    const all = (repos ?? listRepos()).filter((r) => !r.archived)
    const limit = loadConfig(configFile).watchLimit
    const capped = limit > 0 && all.length > limit
    const chosen = capped ? [...all].sort(byWatchPriority).slice(0, limit) : all
    coverage = { watched: chosen.length, total: all.length }
    // 截断必须说出来。这条日志之外，界面的设置面板也会显示 coverage——只靠日志的话，
    // 常驻托盘的应用等于什么都没说，「为什么这个仓库不自动刷新」将无从回答
    if (capped) {
      const scanMin = loadConfig(configFile).autoScanMinutes
      log(
        `[repo-radar] 仓库数 ${all.length} 超过监听上限 ${limit}，只监听收藏和最近提交的 ${chosen.length} 个` +
          (scanMin > 0
            ? `，其余靠每 ${scanMin} 分钟的兜底重扫刷新 / watching ${chosen.length} of ${all.length} repos; the rest refresh via the ${scanMin}-min periodic rescan`
            : `。兜底重扫当前是关的：其余仓库不会自动刷新，请开启兜底重扫或调高监听上限 / watching ${chosen.length} of ${all.length} repos; periodic rescan is OFF, the rest will NOT refresh automatically`),
      )
    }
    await watcher.watch(chosen.map((r) => ({ id: r.id, path: r.path })))
  }

  return {
    applyWatch,
    coverage: () => coverage,

    // 先落盘、再装监听：落盘成功后 applyWatch 才抛错（chokidar EMFILE 等）的情况不能
    // 让整个请求 500——磁盘上确实是新值，500 会让客户端回滚 UI，从此界面显示的和盘上
    // 存的对不上，下轮重扫还会按盘上的值再试一次。与 PUT /api/config 同一取舍：
    // 以磁盘为准，监听器错误记日志（下轮扫描的 applyWatch 自带重试）
    async setWatch(enabled) {
      persist("autoWatch", enabled)
      await applyWatchLogged(enabled)
    },
    async setAutoScan(minutes) {
      persist("autoScanMinutes", minutes)
      scanTimer.apply(minutes)
    },
    async setAutoFetch(minutes) {
      persist("autoFetchMinutes", minutes)
      fetchTimer.apply(minutes)
    },
    async setWatchLimit(limit) {
      persist("watchLimit", limit)
      // 上限变了要立刻重挂监听：不重挂的话面板显示的覆盖数和真正挂着的监听对不上，
      // 而这个设置的全部意义就是让用户能看见并控制覆盖范围
      await applyWatchLogged(loadConfig(configFile).autoWatch)
    },

    // 逐字段比对，只重装真变了的：整份 GET→改一处→PUT 回来是最常见的客户端写法，
    // 无脑全量重装会让每次保存都重置兜底重扫的倒计时（周期性保存 = 兜底重扫永不触发），
    // 还白白拆建几百个监听目标、丢掉重建窗口里的事件
    async applyConfig(next, prev) {
      if (next.autoScanMinutes !== prev.autoScanMinutes) scanTimer.apply(next.autoScanMinutes)
      if (next.autoFetchMinutes !== prev.autoFetchMinutes) fetchTimer.apply(next.autoFetchMinutes)
      if (next.autoWatch !== prev.autoWatch || next.watchLimit !== prev.watchLimit) await applyWatch(next.autoWatch)
    },

    start(cfg) {
      scanTimer.apply(cfg.autoScanMinutes)
      fetchTimer.apply(cfg.autoFetchMinutes)
    },
    stop() {
      scanTimer.apply(0)
      fetchTimer.apply(0)
    },
  }
}
