import { watch as chokidarWatch, type FSWatcher } from "chokidar"
import { existsSync, realpathSync, watch as fsWatch, type FSWatcher as NodeWatcher } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { isUnderPath, pathKey, shouldIgnorePath, watchTargetLost, watcherErrorIsNoise } from "./watch-filter"

export interface WatchedRepo {
  id: string
  path: string
  /**
   * 已归档：**不为它建立任何监听目标，但仍要进 RepoWatcher 的归属映射**。两件事缺一不可。
   *
   * 不建目标：归档仓库不上看板、不参与后台处理，为它挂句柄纯属浪费。
   * 仍要认得它：递归 root 句柄照样看得见它的写入，而**未归属**的事件会被当成「目录结构变化」，
   * 触发一轮 force=true 的全量重扫（store.refreshAll + 全部监听句柄拆了重建），并按 60 秒冷却
   * 持续重复。把归档仓库从映射表里删掉的净效果是荒谬的：归档一个你正在用的仓库，会让应用
   * 比不归档时做多得多的后台工作——反复的 CPU 尖峰、每分钟重新出现的扫描进度条。
   */
  archived?: boolean
}

export interface StrategyHandlers {
  /** 事件路径一律给绝对路径，归属判断由 RepoWatcher 统一做 */
  onEvent(absPath: string): void
  /**
   * 「事件已经丢了」的信号，调用方应当触发一轮全量重扫补票。
   *
   * `rebuild` 区分的是两件后果完全不同的事，此前它们共用一个信号、都按「重建」处理：
   *  · false = 内核缓冲区溢出（`name === null`）。**句柄是好的**，只是这一批通知装不下。
   *    一棵正忙的树上这会持续发生（作者机器实测：74 个仓库、每 62 秒一次，永不停），
   *    而每次都拆建整套监听纯属白干，还会在拆建窗口里真的丢事件——反过来又给下一轮
   *    重扫提供理由。
   *  · true = 监听目标本身没了（root 被删/改名、网络盘掉线）。**句柄已经死了**，
   *    这棵树从此不会再有任何事件，不重建就永久静默。
   */
  onOverflow(reason: string, rebuild: boolean): void
  onError(err: NodeJS.ErrnoException, targets: readonly string[]): void
}

export interface WatchStrategy {
  /** 建立监听，返回**实际成功建立监听**的路径列表（coverage 要如实反映，不能装作全覆盖） */
  start(roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]>
  stop(): Promise<void>
}

/**
 * win32 / darwin：每个 scan root 一个 `fs.watch(root, { recursive: true })`。
 *
 * Windows 的 ReadDirectoryChangesW 子树模式与 macOS 的 FSEvents 都是内核级递归，
 * 一个句柄覆盖整棵树，建立时不需要遍历目录。实测 73 个仓库：逐仓库方案要挂 2311 个
 * 目录句柄、建立时 2238 次 readdir + 32780 次 stat；这里是 1 个句柄、2ms。
 *
 * 代价是内核不再帮我们过滤 node_modules —— 构建期这些事件会送到 JS 里做字符串判断。
 * 实测后台构建约 100 事件/秒，量级上无关紧要。真正要防的是缓冲区溢出丢事件，
 * 由 onOverflow + 兜底重扫覆盖。
 */
export class RecursiveRootStrategy implements WatchStrategy {
  private watchers: NodeWatcher[] = []

  async start(roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]> {
    const ok: string[] = []
    // roots 之外的 manualRepos 也要各挂一个（数量本就很少）。归档仓库不建目标（见 WatchedRepo.archived）
    const outside = repos
      .filter((r) => !r.archived)
      .map((r) => r.path)
      .filter((p) => !roots.some((root) => isUnderPath(p, root)))
    // 按归一化口径去重，不是裸字符串：两个只差 Windows 大小写（`D:\code` 与 `d:\Code`）或
    // 分隔符风格（`D:/code`）的 root 会各挂一个递归句柄监听**同一棵树**——句柄、内核缓冲区、
    // 以及每条事件的 JS 处理成本全部翻倍，而多出来的那一份一条新信息都不带（防抖会把重复
    // 事件合并掉，所以没有任何症状会把它暴露出来）。
    // 保留**第一次出现**的原始形式：事件要按调用方给的形式报回去，见 reportedPath
    const targets: string[] = []
    const seenTargets = new Set<string>()
    for (const t of [...roots, ...outside]) {
      const key = pathKey(t)
      if (seenTargets.has(key)) continue
      seenTargets.add(key)
      targets.push(t)
    }
    // 交给 watcherErrorIsNoise 分级用的目标列表：两种形式都要在里面。它靠「出事的路径是不是
    // 监听目标本身」判断能不能咽掉，而 realpath 失败时错误带的是原始路径、监听建立后内核报的
    // 是 realpath——少一种形式，「整个 root 从此没有事件」就会被当成单文件噪音咽掉，
    // 那棵树下的仓库全部静默停止刷新，日志里一个字都没有
    const graded: string[] = [...targets]
    for (const target of targets) {
      try {
        // Windows 8.3 短名路径会触发 libuv fs-event 的断言崩溃（整个进程 abort、无法 try/catch），
        // 监听前统一解析成规范长名。注意事件要按 target 的形式报回去，见 reportedPath
        const real = realpathSync.native(target)
        graded.push(real)
        const w = fsWatch(real, { recursive: true }, (_event, name) => {
          // name 为 null = 内核缓冲区溢出，这一批事件已经丢了，必须靠重扫补票
          if (name === null) {
            h.onOverflow(`recursive watch overflow at ${target}`, false) // 缓冲区溢出：句柄仍在，别拆建
            return
          }
          h.onEvent(reportedPath(target, real, name.toString()))
        })
        w.on("error", (err) => {
          const e = err as NodeJS.ErrnoException
          // 溢出在部分平台走 error 通道，root 被删/改名/网络盘掉线也走这里。不按错误码白名单
          // 分流：Node 在 emit error 之前就把句柄关了，无论什么码，这棵树从此不再有任何事件，
          // 必须靠重扫补票 + 重建（见 watchTargetLost）。目标底下单个文件的错误不算失守
          if (watchTargetLost(e, [target, real])) {
            h.onOverflow(`recursive watch lost at ${target}: ${e.code ?? e.message}`, true) // 句柄已死，必须重建
          }
          h.onError(e, graded)
        })
        this.watchers.push(w)
        ok.push(target)
      } catch (err) {
        // 单个 root 挂不上不该拖垮其它 root。它不在返回列表里 → coverage 会如实变低
        h.onError(err as NodeJS.ErrnoException, graded)
      }
    }
    return ok
  }

  async stop(): Promise<void> {
    for (const w of this.watchers.splice(0)) {
      try {
        w.close()
      } catch {
        // 已经因错误自行关停过的实例再 close 一次可能抛。不接住的话后面几个 root 的句柄
        // 就全不关了——正是「关掉自动扫描后看板还在刷新、句柄攒到 EMFILE」那条老路
      }
    }
  }
}

/**
 * linux：保留改造前的逐仓库方案。
 *
 * 不换成递归的原因：Node 在 Linux 上的 `recursive: true` 是**用户态实现**——它自己递归遍历
 * 并为每个目录加 inotify watch，且不接受 ignore 列表，于是每个 node_modules 都会被挂上，
 * 比现状更糟并可能撞上 fs.inotify.max_user_watches。Linux 上目录也不会被句柄锁住，
 * 逐仓库方案本来就工作良好。
 *
 * 代价是所有仓库共用**一个** FSWatcher：它一死，全部仓库一起停止刷新。因此错误分流
 * （watchTargetLost → onOverflow）和「只把真正挂上的仓库算进 coverage」这两件事在这条腿上
 * 比递归策略更要紧，见 start 里的两处注释。
 */
export class PerRepoStrategy implements WatchStrategy {
  private watcher: FSWatcher | null = null

  /** readyTimeoutMs：等 chokidar 首轮遍历（`ready`）的上限，见 start 里的注释。
   *  10 秒是「慢盘上也该走完」与「退出/重扫不能被它拖住」之间的取舍 */
  constructor(private readonly readyTimeoutMs = 10_000) {}

  async start(_roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]> {
    // realpath 的理由同递归策略（8.3 断言崩溃）。原始形式必须留住：事件要按它报回去。
    // 归档仓库不进 chokidar 的目标列表（见 WatchedRepo.archived）——这条腿上每个仓库要挂
    // 好几个 inotify watch，为不上看板的仓库挂等于白占 max_user_watches 的名额
    const resolved = repos.filter((r) => !r.archived).map((r) => {
      try {
        return { orig: r.path, real: realpathSync.native(r.path) }
      } catch {
        return { orig: r.path, real: r.path } // realpath 要求路径存在；解析不了退回原值，至少不崩
      }
    })
    // 只把真实存在的仓库交给 chokidar，也只有它们能进返回值。原先无条件返回全部，于是
    // 被删掉/网络盘掉线的仓库照样计进 coveredRepoCount——设置面板说「全部实时监听中」，
    // 而那些仓库其实一个事件都收不到，用户看到它们不刷新时无从判断是哪一环坏了。
    // 这条正是 WatchStrategy.start 自己在接口注释里立下的契约
    const live = resolved.filter((r) => existsSync(r.real))
    const targets = live.flatMap((r) => [
      join(r.real, ".git", "HEAD"),
      join(r.real, ".git", "index"),
      join(r.real, ".git", "refs"),
      r.real,
    ])
    if (targets.length === 0) return []
    const roots = live.map((r) => r.real) // chokidar 回报的是 real 形式，ignore 判断要同一坐标系
    // 两种形式完全一致时（Linux 上的常态）跳过整个改写，热路径上省掉一次线性查找
    const needsRemap = live.some((r) => r.real !== r.orig)
    // 建立期收下的失守记录。原先 start 无条件返回全部仓库，与 chokidar 是否真的挂上无关：
    // inotify 耗尽（ENOSPC，73+ 仓库时是真实场景）或 EMFILE 时所有仓库停止刷新，而设置面板
    // 显示**全覆盖**——用户看到卡片不动时，唯一能看的那个诊断面在说「一切正常」。
    // 只收非噪音的错误（见 watcherErrorIsNoise）：首轮遍历撞上一个刚被删掉的临时文件是
    // EBUSY/EPERM/ENOENT，那不该让整个仓库掉出覆盖
    const lostPaths: string[] = []
    let allLost = false // 路径不明的失守：说不清打掉了谁，只能按整个实例算
    const w = chokidarWatch(targets, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p) => shouldIgnorePath(p, roots),
    })
    this.watcher = w
    w.on("all", (_event, file) => h.onEvent(needsRemap ? toOriginal(live, file) : file))
    w.on("error", (err) => {
      const e = err as NodeJS.ErrnoException
      if (!watcherErrorIsNoise(e, targets)) {
        if (typeof e.path === "string") lostPaths.push(e.path)
        else allLost = true
      }
      // 与递归策略同一条分流（watchTargetLost：出事的是监听目标本身、或路径不明，就算失守）。
      // 这里**一个** FSWatcher 管着所有仓库，所以 ENOSPC（inotify 上限，73+ 仓库时是真实
      // 场景）和 EMFILE 打掉的是整个实例：所有仓库一起停止刷新，日志一行，无人重建。
      // 只调 onError 不调 onOverflow 的话，Task 7 为 win/mac 建的自愈链在 Linux 上就是断的
      if (watchTargetLost(e, targets)) {
        h.onOverflow(`per-repo watch lost at ${e.path ?? "?"}: ${e.code ?? e.message}`, true) // 同上
      }
      h.onError(e, targets)
    })
    // 等首轮遍历结束再算覆盖。chokidar 的挂载是异步的：不等就返回，等于替一个还没开始工作的
    // 实例背书，`WatchStrategy.start` 写在接口上的契约（「返回**实际成功建立监听**的路径列表，
    // coverage 要如实反映」）在这条腿上从来没有被兑现过
    await waitForReady(w, this.readyTimeoutMs)
    // 等待期间被 stop() 掉了（并发的 setRoots/close）：这批句柄已经关了，不能拿它报覆盖
    if (this.watcher !== w) return []
    if (allLost) return []
    return live.filter((r) => !lostPaths.some((p) => isUnderPath(p, r.real))).map((r) => r.orig)
  }

  async stop(): Promise<void> {
    // 先摘引用再关：close() 抛出时若引用还挂着，下一轮 start 会把它覆盖掉，
    // 那个实例从此没人能关，一直发事件
    const w = this.watcher
    this.watcher = null
    await w?.close()
  }
}

/**
 * 等 chokidar 的首轮遍历（`ready`）跑完；超时返回 false。
 *
 * **超时兜底不是保险起见**：`ready` 要等所有目标的首轮 readdir 结束，网络盘 / 巨大仓库上
 * 可能很久甚至走不完，而这条 promise 挂在 `RepoWatcher.setRoots` 里——没有上限的话，一次
 * 慢盘就能让整轮重扫、以及退出流程里的 drainRescans 永远挂住（托盘退出/关机路径上直接表现
 * 为「点了退出没反应」）。
 *
 * 超时之后按「不知道谁没挂上」处理，由调用方返回**乐观**名单而不是空名单：报 0 覆盖会让
 * automation 每一轮重扫都补一次注定同样超时的 applyWatch，那是把一个诊断面缺口换成一个
 * 新的水龙头。定时器 unref：它不该在别的什么都做完之后还吊着事件循环
 */
export function waitForReady(w: { once(event: "ready", listener: () => void): unknown }, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    w.once("ready", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 事件路径回到**调用方给的坐标系**。监听必须挂在 realpath 上（见上面的 8.3 断言崩溃），
 * 但归属表里的仓库路径是 scanner 从配置里的 root 一层层 join 出来的原始形式，两者在
 * Windows 的 8.3 短名（tmpdir 常见：`C:\Users\RUNNER~1\...`）和 macOS 的 /var → /private/var
 * 软链上并不相等。直接报 realpath 的后果是每条事件都找不到归属：所有仓库静默停止刷新，
 * 而且每条事件都被当成「目录结构变化」，兜底重扫被无休止地触发。
 *
 * 导出只为单测：它的两个坐标系只有在 `target !== real` 时才分得开，而那要么靠 Windows 的
 * 8.3 短名、要么靠软链——两者都不是能在两条 CI 腿上稳定造出来的条件（`/tmp` 下没有软链，
 * 于是端到端用例在 Linux 上是空跑）。直接喂两个不同的形式进来才钉得住。
 */
export function reportedPath(target: string, real: string, name: string): string {
  // Linux 的 recursive 是用户态实现，历史上回报过绝对路径；两种形式都接住
  const abs = isAbsolute(name) ? name : join(real, name)
  const rel = relative(real, abs)
  if (rel === "") return target
  // 判「不在 real 之下」必须连分隔符一起看：裸 `startsWith("..")` 会把仓库根下一个名叫
  // `..foo` 的文件当成「跑到 real 外面去了」，于是报 realpath 形式而不是调用方的形式——
  // 那条路径在归属表里对不上，这次写入被当成目录结构变化，白跑一轮 force=true 的全量重扫
  if (rel === ".." || rel.startsWith(`..${sep}`)) return abs // 形式说不清，原样交出去，别硬拼一个假路径
  return join(target, rel)
}

/** chokidar 的事件路径（real 形式）换回仓库列表里的原始形式，理由同 reportedPath */
function toOriginal(pairs: readonly { orig: string; real: string }[], file: string): string {
  const hit = pairs.find((p) => isUnderPath(file, p.real))
  if (hit === undefined) return file
  const rel = relative(hit.real, file)
  return rel === "" ? hit.orig : join(hit.orig, rel)
}

/** Linux 是否走逐仓库策略（chokidar，每仓库几个 inotify watch）。
 *  automation.ts 的 watchLimit 截断只在这条腿上有意义——递归策略下一个 scan root 一个句柄，
 *  仓库数再多也不会多开一个句柄，对着它做「监听数量上限」截断没有任何东西可省 */
export function usesPerRepoWatching(): boolean {
  return !(process.platform === "win32" || process.platform === "darwin")
}

export function defaultStrategy(): WatchStrategy {
  return usesPerRepoWatching() ? new PerRepoStrategy() : new RecursiveRootStrategy()
}
