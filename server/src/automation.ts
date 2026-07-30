import { statSync } from "node:fs"
import { type Config, loadConfig, MAX_INTERVAL_MINUTES, saveConfig } from "./config"
import type { RepoStatus } from "./types"
import { usesPerRepoWatching } from "./watch-strategy"
import type { RepoWatcher, WatchedRepo } from "./watcher"

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
  /** 「这条仓库路径已经确定不在磁盘上了」。默认按 ENOENT 判定（见 pathGone）。
   *  做成可注入的只有一个理由：测试里的仓库路径大多是假的（`/r/a`），用真实判定会把
   *  覆盖率分母整个抹平，那样测到的就不是这些用例想测的东西了 */
  pathGone?: (path: string) => boolean
  log?: (msg: string) => void
}

/**
 * 这条路径**确定**已经不在磁盘上了吗。
 *
 * 只有 ENOENT 算「没了」——EACCES / EPERM / EBUSY（杀软锁住、网络盘鉴权失败、目录被独占）
 * 一律当「还在」，与 `repo-identity.ts` 的 pathExists 同一取舍，理由在这里同样是不对称的：
 * 把一个还在磁盘上的仓库判成「没了」，它就被排除出覆盖率的分母，于是**真正的降级从此测不
 * 出来**（一个网络盘抖动的仓库会让「本该监听却没监听」永远显示为正常）；判成「还在」最多是
 * 多跑一次注定失败的重挂，下一轮自己会好。
 * `throwIfNoEntry: false` 正好把这两类分开：ENOENT 返回 undefined，其它错误照样抛。
 */
export function pathGone(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) === undefined
  } catch {
    return false // 非 ENOENT：无从判断，按「还在」处理（保守侧 = 仍然期待它有监听）
  }
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
  /** 重扫后调用：更新监听器的「路径 → id」映射。这是本任务的性能收益所在——普通重扫
   *  （周期定时器 / 手动点重扫）大概率什么都没变，拆几千个句柄再建一遍纯属浪费。
   *  唯一会碰句柄的情况是「有仓库本该被覆盖却没被覆盖」（新克隆的仓库、挂不上的 root），
   *  那时补一次 applyWatch——没有它，那些仓库到进程结束都拿不到监听句柄，见实现里的注释 */
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

/**
 * 本轮**真正要建立监听句柄**的仓库（入参已排除归档）。
 *
 * watchLimit 只对逐仓库策略（Linux）有意义：那里每个仓库要挂几个 inotify watch，需要一个
 * 用量阀门。递归策略下一个 scan root 一个句柄，仓库数再多也不会多开句柄，对着它截断没有
 * 任何东西可省，也就不做——见 watch-strategy.ts 的 usesPerRepoWatching。
 *
 * 抽出来是因为 applyRepos 判断「覆盖够不够」时必须用**同一个分母**：拿未截断的仓库总数当
 * 分母的话，Linux 上任何一个设了 watchLimit 的用户都会每轮重扫重挂一次监听——截断是预期内
 * 的短缺，不是需要补救的降级，那正好把本轮重构省下来的开销原样还回去
 */
function pickWatched(active: RepoStatus[], cfg: Config): RepoStatus[] {
  return usesPerRepoWatching() && cfg.watchLimit > 0 && active.length > cfg.watchLimit
    ? [...active].sort(byWatchPriority).slice(0, cfg.watchLimit)
    : active
}

/** 交给监听器的清单。归档仓库带着标记一起交出去——不建目标、但要认得，见 WatchedRepo.archived */
const toWatched = (repos: readonly RepoStatus[]): WatchedRepo[] =>
  repos.map((r) => ({ id: r.id, path: r.path, archived: r.archived }))

/** 一次重挂请求的指纹：roots + excludes + 真正要建目标的那批路径，也就是 setRoots 的三个入参。
 *  applyRepos 用它判断「这次要挂的和上次尝试过的是不是同一份」，见 lastHeal */
const mountKey = (roots: readonly string[], excludes: readonly string[], targets: readonly RepoStatus[]): string =>
  JSON.stringify([roots, excludes, targets.map((r) => r.path)])

/**
 * 同一份挂不上的名单，隔多久才允许再挂一次（毫秒）。
 *
 * 这道闸必须带时间维度，不能退回「同一份名单永不重试」的布尔闩：挂不上的原因**会消失**——
 * inotify 名额被别的程序吃光（ENOSPC）后用户把那个程序关掉 / 调大 max_user_watches，EMFILE
 * 更是本来就会自己好。而用户面对「监听没挂上」的自然动作就是点界面上的「重扫」，它走的正是
 * applyRepos；永久闩住的话名单一个字没变 → 直接 return，那批仓库到进程结束都不实时刷新，
 * 设置面板那行 warn「N 个中监听 M 个」也永远不恢复，只有重启应用才好。
 *
 * 1 分钟是唯一同时满足两端的量级：
 *  · 下限（挡住高频入口）：用户连点 ⭐ / 排除的间隔是秒级（每次 PATCH meta → syncRepos →
 *    applyRepos），1 分钟足以把一串点击压成最多一次重挂。一次重挂在 Linux 上是把唯一那个
 *    chokidar 实例整个 stop 再建、还要等 waitForReady（最长 10 秒），那段窗口里所有仓库都
 *    收不到任何文件事件，而且不补票；
 *  · 上限（放行重扫）：兜底重扫的最小生效间隔就是 1 分钟（intervalMs 的下限夹逼），手动
 *    「重扫」更是分钟级的人工动作。再长的冷却等于把用户「修好了再点一次重扫」的那次点击
 *    也吃掉，故障消失了却还要等——那正是这道闸要修的毛病本身
 */
const HEAL_RETRY_MS = 60_000

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
  const gone = deps.pathGone ?? pathGone
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
  // applyRepos 上一次自愈重挂**尝试**过的那份 setRoots 请求（mountKey）+ 尝试的时刻。同一份名单
  // 在 HEAL_RETRY_MS 的冷却期内不重试：「路径还在、但就是挂不上」的目标（inotify ENOSPC、
  // root/仓库 EACCES、网络盘鉴权失败——pathGone 只认 ENOENT，所以它们留在分母里）会把
  // watchDegraded 永久闩住，而 applyRepos 自从接上 PATCH meta 的 syncRepos 之后是个**高频**入口：
  // 用户每点一次 ⭐ / 排除都会走到这里。不挡的话每次点击都是 strategy.stop() + 重建。
  // 记时刻而不是只记名单：为什么必须给这道闸留一个出口，见 HEAL_RETRY_MS
  let lastHeal: { key: string; at: number } | null = null

  /**
   * 覆盖率的**分母**：这批仓库里，本该真的有监听的有几个。
   *
   * 路径已经失效的仓库要减掉。它们会一直留在仓库列表里（Task 9 有意为之：不能让卡片静默
   * 消失，要产出一张「路径已失效」的错误卡片），而任何策略都挂不上一个不存在的路径，于是
   * `coveredRepoCount()` 永远小于仓库数——`watchDegraded` 与 applyRepos 的补挂条件被**永久
   * 闩住**，每一轮重扫都触发一次注定失败的 applyWatch（拆了重建全部句柄），正好是本轮重构
   * 要消灭的那笔开销，只是换了个理由回来。一个死掉的 manualRepo 就够了。
   *
   * 只在快路径没命中之后才调用：它每个仓库要付一次 stat，而绝大多数轮次根本走不到这里
   */
  const expectedCoverage = (list: readonly RepoStatus[]): number => list.filter((r) => !gone(r.path)).length

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
    const list = repos ?? listRepos()
    // 不为「已归档」的仓库建立监听目标——它们从看板/统计/后台处理里都收起。
    // 但它们仍要出现在交给 watcher 的清单里（带 archived 标记），见下面 setRoots 那一行
    const all = list.filter((r) => !r.archived)
    if (!enabled) {
      // total 仍如实反映非归档仓库数：关掉监听不等于仓库消失，界面该说「0 个中的 N 个」
      // 而不是「0 个中的 0 个」——后者会让人以为压根没有仓库，无从判断是「关了」还是「没有」
      lastTotal = all.length
      watchDegraded = false // 关掉是用户的意图，不是失败，没有什么需要补救
      await watcher.close()
      return
    }
    const cfg = loadConfig(configFile)
    const chosen = pickWatched(all, cfg)
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
    // 归档仓库跟在 chosen 后面一起交出去：不建目标，但要进归属映射，否则它们的写入会被
    // 当成「目录结构变化」而触发一轮又一轮 force=true 的全量重扫（见 WatchedRepo.archived）。
    // excludes 也一并交出去：被排除的仓库不进 scan()、因而永远不在归属表里，watcher 不知道
    // 它就会把它的每一次写入当成结构变化——一个永不关闭的水龙头（见 watcher.ts 的 excludes）
    await watcher.setRoots(cfg.roots, toWatched([...chosen, ...list.filter((r) => r.archived)]), cfg.excludes)
    // 比对的是 chosen（截断之后的名单）里**路径还在**的那些，不是 all：watchLimit 造成的截断
    // 是预期内的短缺，路径失效同样是——两者都不该被当成「降级」反复触发重挂；真正的降级信号
    // 只能是「连本该建成的这些都没建全」
    watchDegraded = watcher.coveredRepoCount() < expectedCoverage(chosen)
  }

  /** 重扫后调用：只更新映射表，不建立/重建任何句柄。传入的是本次扫描到的全量仓库（含归档的、
   *  以及超出 watchLimit 名额、当前实际没有被句柄覆盖的那些）——即便如此也不会虚报覆盖：
   *  coverage() 改问 watcher 的真实计数，watcher 只按上一次真正建立的 okRoots 计 */
  function applyRepos(repos: RepoStatus[]): void {
    const all = repos.filter((r) => !r.archived)
    lastTotal = all.length
    watcher.setRepos(toWatched(repos))
    // 两道闸问的都是「**该覆盖的这批路径**是不是都真的被覆盖了」，不是「覆盖的数量够不够」。
    // 上一版只比数量，在名额被 watchLimit 截满时**必错**：Linux + 201 个仓库 + 上限 200 时，
    // 用户按面板承诺的「名额不够时收藏优先」给某个不刷新的仓库打 ⭐（或取消排除它），
    // pickWatched 的名单换了人、但长度仍是 200，`200 >= 200` 成立 → 直接 return。而 applyWatch
    // 是唯一会重算 pickWatched 的入口，于是那个仓库在这个进程余生一个监听目标都不会有，
    // 界面还零反馈（coverage 打 ⭐ 前后都一样）——收藏优先排序只在名额被截断时才有意义，
    // 只比数量等于让它在唯一有意义的场景里 100% 失效。别再改回数量比较
    //
    // 快路径：没降级、且每个仓库都已被覆盖。绝大多数周期重扫走这里，连配置文件都不必读——
    // 本任务省下来的那笔「每轮都重建几千个句柄」的开销不会因为下面的自愈又搭进去
    if (!watchDegraded && all.every((r) => watcher.isCovered(r.path))) return
    const cfg = loadConfig(configFile)
    // 尊重用户当下的开关：这期间可能已经手动关掉了监听，不擅自把它重新打开
    if (!cfg.autoWatch) return
    // 名单取 pickWatched 而不是 all，且路径已失效的算「不必覆盖」：watchLimit 截断与死掉的
    // manualRepo 都是预期内的短缺，不是需要补救的降级。拿 all 当名单的话，Linux 上任何设了
    // 上限的用户、以及任何有一个失效 manualRepo 的用户，都会每轮重扫重挂一次，等于本轮重构白改。
    // gone 只对**没被覆盖**的那些付 stat（`||` 短路），正常轮次一次 syscall 都不多
    const chosen = pickWatched(all, cfg)
    if (!watchDegraded && chosen.every((r) => watcher.isCovered(r.path) || gone(r.path))) return
    // 同一份 setRoots 请求在冷却期内不重试，见 lastHeal / HEAL_RETRY_MS：降级被闩住时 applyRepos
    // 是个高频入口，不挡的话用户每点一次 ⭐ / 排除都要把监听句柄整体拆建一遍；但冷却期一过就
    // 必须放行，否则用户修好 inotify 名额之后点「重扫」永远没有任何效果。真正需要救的场景
    //（新仓库出现 / 取消归档 / 名额换人 / root 回来了）名单一定变过，一次都不受这道闸影响
    const key = mountKey(cfg.roots, cfg.excludes, chosen)
    const now = Date.now()
    if (lastHeal !== null && lastHeal.key === key && now - lastHeal.at < HEAL_RETRY_MS) return
    lastHeal = { key, at: now }
    // 到这里只剩两种情况，都必须重挂——setRepos 只改映射表、从不触达 strategy，**没有任何
    // 其它代码路径**会为「上一次 applyWatch 之后才出现的仓库」建立句柄：
    //   ① 上一次 applyWatch 有目标没建成（EMFILE 一类瞬时故障；RecursiveRootStrategy 对单个
    //      root 的失败是内部吞掉的，只是不把它放进返回的 ok 列表）；
    //   ② 有仓库本该被覆盖却没被覆盖——用户 git clone 进扫描根、30 分钟后周期重扫发现了它，
    //      逐仓库策略下它不在 chokidar 的目标列表里（start 时一次性建好，此后没人调 add()），
    //      于是这个进程余生它都没有 inotify 监听：提交/切分支要等最长 30 分钟才显示，而其它
    //      卡片 1 秒内更新，autoScanMinutes=0 时永远不更新。网络盘 root 掉线时挂不上、盘回来
    //      之后重扫列出其下仓库，也落在这一条（那一刻 root 下还没有仓库，watchDegraded 恰好
    //      是 false，救不了）。递归策略下新仓库落在 root 句柄之下、本来就计入覆盖，不会进这里
    // 失败了只记日志，不抛出去打断这轮重扫。重试留给「名单变了」或「冷却期过后的下一次重扫」
    // ——同一份名单立刻再挂一遍只会得到同样的失败，而那批仓库的数据仍由兜底重扫按时刷新，
    // 不至于停在过期状态
    void applyWatch(true, repos).catch((err) => {
      log(`[repo-radar] 兜底重挂监听失败（有监听目标没建成或还没建）：${err instanceof Error ? err.message : String(err)}`)
    })
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
    // roots/manualRepos 变了 → 监听目标本身变了，只有重建能让新目标生效。
    // autoWatch 与 watchLimit 同样保留在触发条件里（未采用「只看 roots/manualRepos」的更窄
    // 写法）：这两个字段若经由整份 PUT /api/config 变化却不落实，得到的都是「配置说的和实际
    // 跑的不一样」，正是本任务最该防的那类「装作还在监听」——
    //   - autoWatch：配置说开着、实际监听没启动；
    //   - watchLimit：值落了盘、面板也显示了新上限，但 applyWatch 从不被调用，Linux 上超出
    //     旧上限的仓库直到进程结束都不被监听。它虽有专属的 setWatchLimit 端点，但那只覆盖
    //     web UI 恰好走的那条路；GET → 改一处 → PUT 整份回来是最常见的客户端写法，走的是这里
    // 代价只是一次少见路径上的重装，比「界面声称覆盖全部、实际没有」小得多
    async applyConfig(next, prev) {
      if (next.autoScanMinutes !== prev.autoScanMinutes) scanTimer.apply(next.autoScanMinutes)
      if (next.autoFetchMinutes !== prev.autoFetchMinutes) fetchTimer.apply(next.autoFetchMinutes)
      const rootsChanged = JSON.stringify(next.roots) !== JSON.stringify(prev.roots)
      const manualReposChanged = JSON.stringify(next.manualRepos) !== JSON.stringify(prev.manualRepos)
      // excludes 只在这条路上能进 watcher（setRoots 是它唯一的入口，见 watcher.setRoots 的
      // 注释）。不跟着重装的话，改完 excludes 得到的是两种静默错误之一：新加的排除项不生效
      // ——那棵子树继续按 60 秒冷却无限触发全量重扫；删掉的排除项也不生效——那棵子树里新
      // 出现的仓库要等最长 30 分钟的兜底重扫（`autoScanMinutes = 0` 时永不出现）
      const excludesChanged = JSON.stringify(next.excludes) !== JSON.stringify(prev.excludes)
      const watchChanged = next.autoWatch !== prev.autoWatch || next.watchLimit !== prev.watchLimit
      if (watchChanged || rootsChanged || manualReposChanged || excludesChanged) await applyWatch(next.autoWatch)
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
