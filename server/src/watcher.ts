import { resolve } from "node:path"
import { isStructuralSignal, isUnderPath, pathKey, shouldIgnorePath, watcherErrorIsNoise } from "./watch-filter"
import { defaultStrategy, type WatchStrategy, type WatchedRepo } from "./watch-strategy"

export { isExcludedPath, isStructuralPath, isStructuralSignal, shouldIgnorePath, watcherErrorIsNoise } from "./watch-filter"
export type { WatchedRepo }

/**
 * 文件监听：仓库有变化时通知刷新。两段窗口，任何真实变更都不会被丢弃：
 * - 非冷却期：防抖 debounceMs，合并连发事件后触发一次
 * - 冷却期内（触发后 cooldownMs）：真实变更延迟到冷却结束统一补一次（合并，不丢弃）
 *
 * 不再需要 echo 窗口来抑制自反馈——getRepoStatus 用 `git --no-optional-locks status`
 * 读状态，不会写 .git/index，因此刷新本身不产生文件事件，也就不会自我循环。
 *
 * 「监听什么」与「有哪些仓库」是分开的：setRoots 才建立监听（罕见），setRepos 只更新
 * 归属映射（纯 JS、零 syscall）。改造前每轮兜底重扫都要把几千个句柄拆了重建，
 * 那是实测里最贵的一笔开销。
 */
export class RepoWatcher {
  private repos: WatchedRepo[] = []
  private byKey = new Map<string, string>() // 归一化仓库路径 → id
  // 归档仓库的 id。它们照样在 byKey 里（事件必须能被归属），只是归属之后就地丢弃，
  // 理由见 WatchedRepo.archived：删出映射表 = 每一次保存都报一次「目录结构变化」
  private mutedIds = new Set<string>()
  private roots: string[] = []
  // config.excludes（按目录名）。watcher 必须知道它：被排除的仓库不进 scan()、因而永远不在
  // byKey 里，它的每一次写入都走「未归属 → 结构变化」分支。不知道的话那就是一个永不关闭的
  // 水龙头，60 秒冷却只是给它限了速。见 watch-filter 的 isStructuralSignal
  private excludes: ReadonlySet<string> = new Set()
  private okRoots: string[] = []
  private started = false
  private disposed = false
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private cooldownUntil = new Map<string, number>()
  // start()/stop() 的串行链。两者交错时（定时重扫撞上 PUT /api/config 的重装），
  // 后到者会在先到者刚赋完引用之后把它置空——那个实例从此没人能关，一直发事件：
  // 关掉自动扫描后看板还在刷新，句柄攒到 EMFILE。
  // await 点两侧的「读-改-写」没有原子性可言，唯一稳的办法是让这两个操作排队
  private ops: Promise<void> = Promise.resolve()

  constructor(
    private readonly onRepoChanged: (repoId: string) => void,
    /** 目录结构变化（新仓库出现 / 老仓库消失或改名 / 监听溢出）。调用方应防抖后触发一轮重扫 */
    /** rebuild=true 表示监听句柄本身已死（root 被删/改名、网络盘掉线），那一轮必须重建监听；
     *  缓冲区溢出只是通知装不下、句柄仍在，重建纯属白干（见 StrategyHandlers.onOverflow） */
    private readonly onStructureChanged: (reason: string, rebuild: boolean) => void,
    private readonly debounceMs = 500,
    private readonly cooldownMs = 60_000,
    private readonly strategy: WatchStrategy = defaultStrategy(),
  ) {}

  private serialize(op: () => Promise<void>): Promise<void> {
    const run = this.ops.then(op)
    this.ops = run.catch(() => {}) // 一次失败不能把链卡死
    return run
  }

  /** 建立/重建监听。只在 roots、manualRepos 或 excludes 真的变化时调用。
   *  excludes 跟着走这条（重建）路而不是 setRepos（每轮重扫都跑的便宜路）：applyRepos 的
   *  快路径刻意连配置文件都不读，为了一个极少变的字段把 loadConfig 加回热路径不划算 */
  setRoots(roots: string[], repos: WatchedRepo[], excludes: readonly string[] = []): Promise<void> {
    if (this.disposed) return Promise.resolve() // 见 dispose()：退出之后一律不再建句柄
    return this.serialize(async () => {
      await this.strategy.stop()
      // 归一化后再存：下面 handle 里拿事件路径（同样 resolve 过）与它比前缀，
      // 两边形式不一致的话「这条路径该不该忽略」会算在错误的坐标系里
      this.roots = roots.map((r) => resolve(r))
      this.excludes = new Set(excludes)
      this.indexRepos(repos)
      // 这一批之外的仓库（被删、被排除、被监听上限挤出去）不该再有待触发的刷新：留着
      // 就是对着一个已经不监听、甚至已经不存在的仓库跑 refreshOne，几个 Map 也只增不减。
      // 仍在列表里的仓库定时器一律留着（见 setRepos 的注释）
      this.forgetExcept(new Set(repos.map((r) => r.id)))
      this.okRoots = await this.strategy.start(roots, repos, {
        onEvent: (p) => this.handle(p),
        onOverflow: (reason, rebuild) => this.onStructureChanged(reason, rebuild),
        onError: (err, targets) => {
          if (watcherErrorIsNoise(err, targets)) return
          console.error(`[repo-radar] 监听器错误：${err.message}`)
        },
      })
      this.started = true
    })
  }

  /** 仓库列表变化：纯 JS 改映射表，不碰任何句柄。定时器一律留着——它们只是 setTimeout
   *  句柄，跟监听实例无关；整轮丢弃会把「已经收下、还没触发」的变更连同定时器一起吞掉 */
  setRepos(repos: WatchedRepo[]): void {
    this.indexRepos(repos)
    this.forgetExcept(new Set(repos.map((r) => r.id)))
  }

  private indexRepos(repos: WatchedRepo[]): void {
    this.repos = [...repos]
    this.byKey = new Map(this.repos.map((r) => [pathKey(r.path), r.id]))
    this.mutedIds = new Set(this.repos.filter((r) => r.archived).map((r) => r.id))
  }

  /**
   * **这一条**仓库路径当前真的落在某个建成的监听目标之下吗。
   *
   * 与 coveredRepoCount 分开导出，是因为「数量够不够」回答不了 automation 真正要问的问题：
   * 名额被 watchLimit 截满时，换一批被监听的仓库（用户打 ⭐、取消归档）总数一点都不变，
   * 只比数量的闸门会直接放行，新入选的那个仓库从此一个句柄都拿不到（见 automation.applyRepos）。
   * 判「某个具体路径有没有被覆盖」才问得出「该覆盖的这批是不是都覆盖了」
   */
  isCovered(path: string): boolean {
    return this.started && this.okRoots.some((root) => isUnderPath(path, root))
  }

  /** 实际被监听覆盖的仓库数——某个 root 挂不上时必须如实变低，不能装作全覆盖。
   *  前缀停在分隔符上（见 isUnderPath）：虚高的覆盖数等于界面在说「这个仓库有人看着」，
   *  而用户看到它不刷新时无从判断是哪一环坏了。
   *  归档仓库不计入：它们进这张表只是为了让事件有归属可认（见 WatchedRepo.archived），
   *  本来就不建目标，算进来会让覆盖数虚高，也会让 automation 的「覆盖够不够」判断跟着错 */
  coveredRepoCount(): number {
    return this.repos.filter((r) => !r.archived && this.isCovered(r.path)).length
  }

  watchedRoots(): string[] {
    return [...this.okRoots]
  }

  /** 测试专用入口：绕过真实文件系统直接投喂一个事件路径 */
  handleEventForTest(absPath: string): void {
    this.handle(absPath)
  }

  private handle(file: string): void {
    const abs = resolve(file)
    const owner = this.findOwner(abs)
    if (owner === undefined) {
      // 事件落在所有已知仓库之外：可能是新克隆的仓库、被改名的仓库、或刚删掉的仓库。
      // 改造前这类变化要等最长 30 分钟的兜底重扫才被发现。
      // isStructuralSignal 再筛一道：root 下的草稿目录/非 git 项目/被 excludes 排除的仓库
      // 也在这条分支上，它们的深层写入不可能改变仓库集合，却会把结构重扫（force=true，
      // 拆了重建全部句柄）变成一个持续水龙头。判据的顺序见它自己的注释
      if (isStructuralSignal(abs, this.roots, this.excludes)) {
        this.onStructureChanged(`unowned path: ${abs}`, false) // 只是看见了不认识的路径，句柄没问题
      }
      return
    }
    // 归档仓库的事件到此为止：既不刷新它（它不上看板），也不报结构变化（仓库集合并没有变）。
    // 这一步是「让 watcher 认得归档仓库」的另一半——只认不丢的话，归档仓库里的每一次保存
    // 都会走上面那条未归属分支去触发全量重扫，见 WatchedRepo.archived
    if (this.mutedIds.has(owner.id)) return
    // 用查表时匹配上的那个祖先目录当仓库根，而不是仓库表里的原始字符串：前者一定是 abs 的
    // 字符前缀，后者可能只差大小写或分隔符。shouldIgnorePath 现在靠 isUnderPath 找根，两种
    // 形式都认得（这一条不再是正确性依赖，但仍是最省的那种写法：owner.root 是现成的）。
    //
    // 这条分支**刻意不查 excludes**。已归属 = 这个仓库真的在仓库列表里，而被 excludes 排除的
    // 仓库根本进不了列表；能同时满足两者的只有一种情况——用户把它显式写进了 manualRepos，
    // 那是「我就是要看这个」的明确表态。按 excludes 把它静音掉的话，它会不刷新、不报错、
    // 界面上停在过期状态，而用户以为自己已经把它加回来了
    if (shouldIgnorePath(abs, [owner.root])) return
    const now = Date.now()
    const cooldownEnd = this.cooldownUntil.get(owner.id) ?? 0
    if (now < cooldownEnd) {
      // 冷却期内的变更：延迟到冷却结束统一补一次（不丢弃）
      if (!this.pendingTimers.has(owner.id)) {
        this.pendingTimers.set(
          owner.id,
          setTimeout(() => {
            this.pendingTimers.delete(owner.id)
            this.fire(owner.id)
          }, cooldownEnd - now),
        )
      }
      return
    }
    clearTimeout(this.debounceTimers.get(owner.id))
    this.debounceTimers.set(
      owner.id,
      setTimeout(() => {
        this.debounceTimers.delete(owner.id)
        this.fire(owner.id)
      }, this.debounceMs),
    )
  }

  /**
   * 事件路径 → 所属仓库（连同匹配上的那段祖先路径）。逐段向上查表，O(≤路径深度) 次哈希查找，
   * 且天然是最深匹配优先——嵌套仓库（外层仓库的 vendor/ 下又是个仓库）归属到里层那个。
   * 改造前是对仓库数组做 startsWith 线性扫描——递归监听的事件量大得多，这条热路径必须便宜。
   */
  private findOwner(abs: string): { id: string; root: string } | undefined {
    let cur = abs
    for (;;) {
      const id = this.byKey.get(pathKey(cur))
      if (id !== undefined) return { id, root: cur }
      const parent = resolve(cur, "..")
      if (parent === cur) return undefined
      cur = parent
    }
  }

  private fire(repoId: string): void {
    this.cooldownUntil.set(repoId, Date.now() + this.cooldownMs)
    this.onRepoChanged(repoId)
  }

  /** 彻底停止：定时器一并丢弃。用于用户关掉自动扫描和进程退出——这两种情况下
   *  「还没触发的刷新」本来就不该再发生，与 setRoots 里的重建是两回事 */
  close(): Promise<void> {
    return this.serialize(async () => {
      for (const t of this.debounceTimers.values()) clearTimeout(t)
      for (const t of this.pendingTimers.values()) clearTimeout(t)
      this.debounceTimers.clear()
      this.pendingTimers.clear()
      this.cooldownUntil.clear()
      this.okRoots = []
      this.started = false
      await this.strategy.stop()
    })
  }

  /**
   * 退出时的终态关闭：关掉之后不再接受任何「重新建立监听」的请求。
   *
   * 与 close() 分开是因为 close() 还有一个日常用途——用户关掉自动监听开关（applyWatch(false)），
   * 之后再打开必须还能建起来，所以这个标志不能塞进 close()。
   *
   * 为什么还需要它：退出流程已经会先把重扫链排空再关监听（shutdown.ts 的 drainRescans），但那只
   * 覆盖走重扫调度器的轮次。还有两条不被任何人等待的路能在关闭之后再调一次 setRoots——
   * 退出瞬间仍在跑的 HTTP 处理器（POST /api/clone 落盘之后才调 rescanFresh；stopListening 的
   * server.close() 只是不再接新连接，不会打断已经在跑的请求），以及 automation.applyRepos 里
   * 那次「上一轮有监听目标没建成」的降级重挂（void applyWatch，刻意不阻塞重扫）。
   * 少了这道门闩：重建出来的句柄没有任何人会再去关，Windows 上递归 fs.watch 会一直握着
   * scan root 的目录句柄，那个目录在进程退出前谁也删不掉（EPERM）
   */
  dispose(): Promise<void> {
    this.disposed = true
    return this.close()
  }

  /** 丢掉已不在监听列表里的仓库的定时器/冷却记录（仓库被删或被排除后不再需要，
   *  留着既会对着不存在的仓库触发刷新，也会让这几个 Map 只增不减） */
  private forgetExcept(keep: Set<string>): void {
    for (const [id, t] of this.debounceTimers) {
      if (keep.has(id)) continue
      clearTimeout(t)
      this.debounceTimers.delete(id)
    }
    for (const [id, t] of this.pendingTimers) {
      if (keep.has(id)) continue
      clearTimeout(t)
      this.pendingTimers.delete(id)
    }
    for (const id of [...this.cooldownUntil.keys()]) if (!keep.has(id)) this.cooldownUntil.delete(id)
  }
}
