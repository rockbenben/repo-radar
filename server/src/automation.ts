import { type Config, loadConfig, MAX_INTERVAL_MINUTES, saveConfig } from "./config"
import type { RepoStatus } from "./types"
import { usesPerRepoWatching } from "./watch-strategy"
import type { RepoWatcher } from "./watcher"

/** 监听覆盖情况：total 是本该监听的仓库数（非归档），watched 取自 watcher 的真实覆盖数——
 *  不是配置算出来的应然值。某个 root 挂不上时，coverage 必须如实变低，不能装作全覆盖 */
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
  /** 建立/重建监听句柄：开关切换、启动、以及「结构变化/溢出」这类必须重建才能救回的场景走这里。
   *  代价是拆了重建一遍，改造前每轮兜底重扫都无条件走这里，是实测里最贵的一笔周期性开销——
   *  普通重扫已经改走 applyRepos，不要在新代码里对着「仅仅是重扫」的场景调它 */
  applyWatch(enabled: boolean, repos?: RepoStatus[]): Promise<void>
  /** 重扫后调用：只更新监听器的「路径 → id」映射，不碰任何句柄。这是本任务的性能收益所在——
   *  普通重扫（周期定时器 / 手动点重扫）大概率什么都没变，拆几千个句柄再建一遍纯属浪费 */
  applyRepos(repos: RepoStatus[]): void
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
  // 本该监听的仓库数（非归档），与 watcher 是否真的挂上无关——即便监听整个关着，
  // 界面也该如实说「0 个中的 N 个」而不是「0 个中的 0 个」，后者会让人以为压根没有仓库
  let lastTotal = 0
  // 上一次 applyWatch 是否有目标没建成（EMFILE 等瞬时故障——RecursiveRootStrategy.start
  // 对单个 root/仓库的失败是内部吞掉的，不向上抛，只是不把它放进返回的 ok 列表；coveredRepoCount
  // 比请求的名单短，是「有目标没建成」唯一测得到的信号）。applyWatchLogged 把这类错误咽掉时，
  // 原先靠的是「下一轮扫描的 applyWatch 会重试」——本任务把周期路径收窄成 applyRepos 之后，
  // 那句承诺不再自动成立，得由这个标志接手：periodic/手动重扫改走 applyRepos 了，但仍要有人
  // 在「真的降级了」时补一次重挂，否则「配置说开着、监听其实没挂上」会一直装作正常
  let watchDegraded = false

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
    // 不监听「已排除」的仓库——它们从看板/统计/后台处理里都收起
    const all = (repos ?? listRepos()).filter((r) => !r.archived)
    if (!enabled) {
      // total 仍如实反映非归档仓库数：关掉监听不等于仓库消失，界面该说「0 个中的 N 个」
      // 而不是「0 个中的 0 个」——后者会让人以为压根没有仓库，无从判断是「关了」还是「没有」
      lastTotal = all.length
      watchDegraded = false // 关掉是用户的意图，不是失败，没有什么需要补救
      await watcher.close()
      return
    }
    const cfg = loadConfig(configFile)
    // watchLimit 只对逐仓库策略（Linux）有意义：那里每个仓库要挂几个 inotify watch，
    // 需要一个用量阀门。递归策略下一个 scan root 一个句柄，仓库数再多也不会多开句柄，
    // 对着它截断没有任何东西可省，也就不做——见 watch-strategy.ts 的 usesPerRepoWatching
    const chosen =
      usesPerRepoWatching() && cfg.watchLimit > 0 && all.length > cfg.watchLimit
        ? [...all].sort(byWatchPriority).slice(0, cfg.watchLimit)
        : all
    lastTotal = all.length
    // 截断必须说出来。这条日志之外，界面的设置面板也会显示 coverage——只靠日志的话，
    // 常驻托盘的应用等于什么都没说，「为什么这个仓库不自动刷新」将无从回答
    if (chosen.length < all.length) {
      const scanMin = cfg.autoScanMinutes
      log(
        `[repo-radar] 仓库数 ${all.length} 超过监听上限 ${cfg.watchLimit}，只监听收藏和最近提交的 ${chosen.length} 个` +
          (scanMin > 0
            ? `，其余靠每 ${scanMin} 分钟的兜底重扫刷新 / watching ${chosen.length} of ${all.length} repos; the rest refresh via the ${scanMin}-min periodic rescan`
            : `。兜底重扫当前是关的：其余仓库不会自动刷新，请开启兜底重扫或调高监听上限 / watching ${chosen.length} of ${all.length} repos; periodic rescan is OFF, the rest will NOT refresh automatically`),
      )
    }
    await watcher.setRoots(cfg.roots, chosen.map((r) => ({ id: r.id, path: r.path })))
    // 比对的是 chosen（截断之后的名单），不是 all——watchLimit 造成的截断是预期内的短缺，
    // 不该被当成「降级」反复触发重挂；真正的降级信号只能是「连本该建成的这些都没建全」
    watchDegraded = watcher.coveredRepoCount() < chosen.length
  }

  /** 重扫后调用：只更新映射表，不建立/重建任何句柄。传入的是本次扫描到的全量仓库（含超出
   *  watchLimit 名额、当前实际没有被句柄覆盖的那些）——即便如此也不会虚报覆盖：coverage()
   *  改问 watcher 的真实计数，watcher 只按上一次真正建立的 okRoots 计，多传的那些不在里面 */
  function applyRepos(repos: RepoStatus[]): void {
    const all = repos.filter((r) => !r.archived)
    lastTotal = all.length
    watcher.setRepos(all.map((r) => ({ id: r.id, path: r.path })))
    // 便宜的自愈：只有「上一次 applyWatch 真的有目标没建成」时才补一次重挂，且尊重用户当下的
    // 开关状态（可能这期间已经手动关掉了监听）。绝大多数周期重扫这个分支根本不会进——
    // 本任务省下来的那笔「每轮都重建」的开销不会因为这个兜底又搭进去，只有真正需要救的那一轮
    // 才会付这笔重建的代价，且失败了也只是记日志、留到下一轮再试，不会抛出去打断这轮重扫
    if (watchDegraded && loadConfig(configFile).autoWatch) {
      void applyWatch(true, repos).catch((err) => {
        log(`[repo-radar] 兜底重挂监听失败（上一次有监听目标没建成）：${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  return {
    applyWatch,
    applyRepos,
    coverage: () => ({ watched: watcher.coveredRepoCount(), total: lastTotal }),

    // 先落盘、再装监听：落盘成功后 applyWatch 才抛错（chokidar EMFILE 等）的情况不能
    // 让整个请求 500——磁盘上确实是新值，500 会让客户端回滚 UI，从此界面显示的和盘上
    // 存的对不上。与 PUT /api/config 同一取舍：以磁盘为准，监听器错误记日志——不会静默不了了之：
    // applyWatch 内部会把「有目标没建成」记进 watchDegraded，下一轮重扫（周期定时器或手动点击，
    // 走的是 applyRepos）会看到这个标志补一次便宜的重挂，不需要再等一轮完整的 applyWatch
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
    // 还白白拆建几百个监听目标、丢掉重建窗口里的事件。
    // roots/manualRepos 变了 → 监听目标本身变了，只有重建能让新目标生效；watchLimit
    // 单独变化不再在这里触发重装——它已有专属的 setWatchLimit 端点保证立即生效，这里只剩
    // 「整份配置一次性 round-trip 回来、其中恰好带着与旧值不同的 watchLimit」这种少见路径，
    // 该字段的即时生效不靠这条通道也不影响正确性（coverage 仍如实反映，见 watcher.coveredRepoCount）
    async applyConfig(next, prev) {
      if (next.autoScanMinutes !== prev.autoScanMinutes) scanTimer.apply(next.autoScanMinutes)
      if (next.autoFetchMinutes !== prev.autoFetchMinutes) fetchTimer.apply(next.autoFetchMinutes)
      const rootsChanged = JSON.stringify(next.roots) !== JSON.stringify(prev.roots)
      const manualReposChanged = JSON.stringify(next.manualRepos) !== JSON.stringify(prev.manualRepos)
      // autoWatch 保留在这里（未采用「只看 roots/manualRepos」的更窄写法）：这个开关若经由整份
      // PUT /api/config 变化却不落实，会出现「配置说开着、实际监听没启动」——正是本任务最该防的
      // 那类「装作还在监听」，风险比少一次重装大得多，即便专属的 /api/watch 端点是常见入口
      if (next.autoWatch !== prev.autoWatch || rootsChanged || manualReposChanged) await applyWatch(next.autoWatch)
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
