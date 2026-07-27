import { watch, type FSWatcher } from "chokidar"
import { realpathSync } from "node:fs"
import { join } from "node:path"

interface WatchedRepo {
  id: string
  path: string
}

/**
 * 监听时整段跳过的目录名。除了 node_modules，主要是各语言的构建产物目录：内容由构建工具
 * 高频重写，Windows 上这些临时文件还常带独占锁——chokidar 一去 watch 就是 EBUSY，日志被刷满
 * 跟仓库状态毫无关系的错误（实测 MSBuild 的 app\obj\*_wpftmp.csproj.nuget.g.props）。
 * 它们基本都在 .gitignore 里，变化本来就不进 git status，少监听不会漏掉任何看板上的变化。
 *
 * 代价：仓库里如果有同名的**受版本控制**的目录（比如手写的 dist/），改动不会即时触发刷新，
 * 要等兜底重扫。相比日志被噪音淹没、以及 EBUSY 可能连带拖垮整个监听实例，这个代价值得。
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  "obj",
  "bin",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
])

/**
 * 按**路径段**判断，不做子串匹配：`p.includes("node_modules")` 会让「仓库恰好放在名字含
 * node_modules 的目录下」时整个仓库被静默忽略——看板永远不刷新，且没有任何提示。
 *
 * 只看仓库根目录**以下**的段。仓库自己或它的上级目录叫 build/vendor/dist 完全合法
 * （`D:\vendor\myrepo`、`D:\projects\build`），拿绝对路径整条去匹配的话这些仓库会被整个
 * 忽略掉——同样是「静默不刷新」，比噪音严重得多。roots 为空时退化成整条路径匹配。
 */
export function shouldIgnorePath(p: string, roots: readonly string[] = []): boolean {
  // 前缀必须停在分隔符上：裸 startsWith 会让根 `D:\repo` 认领 `D:\repo-other\...`，
  // 那个仓库的 build/ 判断就跑到别人的坐标系里去了
  const root = roots.find((r) => p === r || (p.startsWith(r) && /[\\/]/.test(p[r.length] ?? "")))
  const rest = root === undefined ? p : p.slice(root.length)
  return rest.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))
}

/**
 * 监听期错误分级。EBUSY/EPERM（文件被独占锁着）、ENOENT（readdir 到 watch 之间文件没了）
 * 出现在**监听目标底下的某个文件**上时是本地开发的日常噪音，对仓库状态零信息量。
 *
 * 但同样这三个码出现在**监听目标本身**上时是完全另一回事：网络共享上的仓库、被杀软锁住的
 * 目录、被删掉或改名的仓库，chokidar 报的就是这几个码，而后果是那个仓库**从此不再刷新**——
 * 界面上它会永远停在一个过期状态，其它仓库照常更新。打包后日志是唯一的诊断面，这种情况
 * 必须留下痕迹，否则用户和维护者都无从判断。
 *
 * 因此按「出事的路径是不是监听目标本身」分级；路径不明时一律报出来（宁可多一条日志，
 * 也不要把一个说不清影响面的错误咽掉）。其余错误码（EMFILE 句柄耗尽、ENOSPC inotify 上限）
 * 永远是真问题。
 */
export function watcherErrorIsNoise(err: NodeJS.ErrnoException, targets: readonly string[] = []): boolean {
  if (err.code !== "EBUSY" && err.code !== "EPERM" && err.code !== "ENOENT") return false
  const failed = err.path
  if (typeof failed !== "string") return false
  return !targets.some((t) => samePath(t, failed))
}

/** Windows 路径大小写不敏感，且同一目录可能以不同大小写回报；比较前统一 */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 文件监听：仓库有变化时通知刷新。两段窗口，任何真实变更都不会被丢弃：
 * - 非冷却期：防抖 debounceMs，合并连发事件后触发一次
 * - 冷却期内（触发后 cooldownMs）：真实变更延迟到冷却结束统一补一次（合并，不丢弃）
 *
 * 不再需要 echo 窗口来抑制自反馈——getRepoStatus 用 `git --no-optional-locks status`
 * 读状态，不会写 .git/index，因此刷新本身不产生文件事件，也就不会自我循环。
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private repos: WatchedRepo[] = []
  private watchTargets: string[] = [] // 本轮交给 chokidar 的监听目标，error 分级要用
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private cooldownUntil = new Map<string, number>()
  // watch()/close() 的串行链。两个 watch() 交错时（定时重扫撞上 PUT /api/config 的重装），
  // 后到者的 closeChokidar 会在先到者刚赋完 this.watcher 之后把引用置 null——那个实例
  // 从此没人能关，一直发事件：关掉自动扫描后看板还在刷新，句柄攒到 EMFILE。
  // await 点两侧的「读-改-写」没有原子性可言，唯一稳的办法是让这两个操作排队
  private ops: Promise<void> = Promise.resolve()

  private serialize(op: () => Promise<void>): Promise<void> {
    const run = this.ops.then(op)
    this.ops = run.catch(() => {}) // 一次失败不能把链卡死
    return run
  }

  constructor(
    private readonly onRepoChanged: (repoId: string) => void,
    private readonly debounceMs = 500,
    private readonly cooldownMs = 60_000,
  ) {}

  watch(repos: WatchedRepo[]): Promise<void> {
    return this.serialize(() => this.doWatch(repos))
  }

  private async doWatch(repos: WatchedRepo[]): Promise<void> {
    // 只关掉 chokidar 实例，不碰防抖/补票定时器：它们只是 setTimeout 句柄，跟哪个 chokidar
    // 实例在跑毫无关系。整轮 close() 会把「已经收下、还没触发」的变更连同定时器一起丢掉，
    // 而兜底重扫每 30 分钟就要重建一次监听——那等于按这个节奏周期性吞事件，直接违背上面
    // 「任何真实变更都不会被丢弃」的承诺。仍在监听列表里的仓库，定时器一律留着
    await this.closeChokidar()
    // Windows 上 8.3 短名路径（如 CI runner 的 C:\Users\RUNNER~1\...）会触发 libuv fs-event 的
    // 断言崩溃（src\win\fs-event.c 的 _wcsnicmp，整个进程 abort、无法 try/catch）——监听前把每个
    // 仓库路径解析成规范长名，既规避该崩溃，也保证 chokidar 回报的事件路径与下面 handle 里的
    // 归属前缀（file.startsWith(r.path)）用同一种形式。realpath 需要路径存在；极少数暂不可解析
    // 的情况退回原值，至少不崩。
    const resolved = repos.map((r) => {
      try {
        return { ...r, path: realpathSync.native(r.path) }
      } catch {
        return r
      }
    })
    this.repos = [...resolved].sort((a, b) => b.path.length - a.path.length) // 最长前缀优先，嵌套路径归属正确
    this.forgetExcept(new Set(resolved.map((r) => r.id))) // 已经不监听的仓库，别留着定时器空跑
    const targets = resolved.flatMap((r) => [
      join(r.path, ".git", "HEAD"),
      join(r.path, ".git", "index"),
      join(r.path, ".git", "refs"),
      r.path,
    ])
    // 留给 error 处理器判分级用：出事的是这些目标之一，就意味着某个仓库整体失去监听，
    // 不是可以咽掉的单文件噪音（见 watcherErrorIsNoise）
    this.watchTargets = targets
    this.watcher = watch(targets, {
      ignoreInitial: true,
      depth: 2,
      // this.repos 已按 path 长度倒序，find 拿到的就是最长匹配根——嵌套仓库下归属正确
      ignored: (p) => shouldIgnorePath(p, this.repos.map((r) => r.path)),
    })
    this.watcher.on("all", (_event, file) => this.handle(file))
    this.watcher.on("error", (err) => {
      if (watcherErrorIsNoise(err as NodeJS.ErrnoException, this.watchTargets)) return
      console.error(`[repo-radar] 监听器错误：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private handle(file: string): void {
    const repo = this.repos.find((r) => file.startsWith(r.path))
    if (!repo) return
    const now = Date.now()
    const cooldownEnd = this.cooldownUntil.get(repo.id) ?? 0
    if (now < cooldownEnd) {
      // 冷却期内的变更：延迟到冷却结束统一补一次（不丢弃）
      if (!this.pendingTimers.has(repo.id)) {
        this.pendingTimers.set(
          repo.id,
          setTimeout(() => {
            this.pendingTimers.delete(repo.id)
            this.fire(repo.id)
          }, cooldownEnd - now),
        )
      }
      return
    }
    clearTimeout(this.debounceTimers.get(repo.id))
    this.debounceTimers.set(
      repo.id,
      setTimeout(() => {
        this.debounceTimers.delete(repo.id)
        this.fire(repo.id)
      }, this.debounceMs),
    )
  }

  private fire(repoId: string): void {
    this.cooldownUntil.set(repoId, Date.now() + this.cooldownMs)
    this.onRepoChanged(repoId)
  }

  /** 彻底停止：定时器一并丢弃。用于用户关掉自动扫描和进程退出——这两种情况下
   *  「还没触发的刷新」本来就不该再发生，与 watch() 里的重建是两回事 */
  close(): Promise<void> {
    return this.serialize(async () => {
      for (const t of this.debounceTimers.values()) clearTimeout(t)
      for (const t of this.pendingTimers.values()) clearTimeout(t)
      this.debounceTimers.clear()
      this.pendingTimers.clear()
      this.cooldownUntil.clear()
      await this.closeChokidar()
    })
  }

  private async closeChokidar(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
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
