import { watch as chokidarWatch, type FSWatcher } from "chokidar"
import { realpathSync, watch as fsWatch, type FSWatcher as NodeWatcher } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { isUnderPath, shouldIgnorePath } from "./watch-filter"

export interface WatchedRepo {
  id: string
  path: string
}

export interface StrategyHandlers {
  /** 事件路径一律给绝对路径，归属判断由 RepoWatcher 统一做 */
  onEvent(absPath: string): void
  /** 内核缓冲区溢出等「事件已经丢了」的信号。调用方应当触发一轮全量重扫补票 */
  onOverflow(reason: string): void
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
    // roots 之外的 manualRepos 也要各挂一个（数量本就很少）
    const targets = [
      ...new Set([...roots, ...repos.map((r) => r.path).filter((p) => !roots.some((root) => isUnderPath(p, root)))]),
    ]
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
            h.onOverflow(`recursive watch overflow at ${target}`)
            return
          }
          h.onEvent(reportedPath(target, real, name.toString()))
        })
        w.on("error", (err) => {
          const e = err as NodeJS.ErrnoException
          // 溢出在部分平台走 error 通道。这两个码也可能是「root 被删/改名/网络盘掉线」——
          // 那意味着这棵树从此不再有事件，同样必须靠重扫补票，两种情况处理方式一致
          if (e.code === "EPERM" || e.code === "ENOENT") h.onOverflow(`recursive watch lost at ${target}: ${e.code}`)
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
 */
export class PerRepoStrategy implements WatchStrategy {
  private watcher: FSWatcher | null = null

  async start(_roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]> {
    // realpath 的理由同递归策略（8.3 断言崩溃）。原始形式必须留住：事件要按它报回去
    const resolved = repos.map((r) => {
      try {
        return { orig: r.path, real: realpathSync.native(r.path) }
      } catch {
        return { orig: r.path, real: r.path } // realpath 要求路径存在；解析不了退回原值，至少不崩
      }
    })
    const targets = resolved.flatMap((r) => [
      join(r.real, ".git", "HEAD"),
      join(r.real, ".git", "index"),
      join(r.real, ".git", "refs"),
      r.real,
    ])
    if (targets.length === 0) return []
    const roots = resolved.map((r) => r.real) // chokidar 回报的是 real 形式，ignore 判断要同一坐标系
    // 两种形式完全一致时（Linux 上的常态）跳过整个改写，热路径上省掉一次线性查找
    const needsRemap = resolved.some((r) => r.real !== r.orig)
    this.watcher = chokidarWatch(targets, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p) => shouldIgnorePath(p, roots),
    })
    this.watcher.on("all", (_event, file) => h.onEvent(needsRemap ? toOriginal(resolved, file) : file))
    this.watcher.on("error", (err) => h.onError(err as NodeJS.ErrnoException, targets))
    return resolved.map((r) => r.orig)
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
 * 事件路径回到**调用方给的坐标系**。监听必须挂在 realpath 上（见上面的 8.3 断言崩溃），
 * 但归属表里的仓库路径是 scanner 从配置里的 root 一层层 join 出来的原始形式，两者在
 * Windows 的 8.3 短名（tmpdir 常见：`C:\Users\RUNNER~1\...`）和 macOS 的 /var → /private/var
 * 软链上并不相等。直接报 realpath 的后果是每条事件都找不到归属：所有仓库静默停止刷新，
 * 而且每条事件都被当成「目录结构变化」，兜底重扫被无休止地触发。
 */
function reportedPath(target: string, real: string, name: string): string {
  // Linux 的 recursive 是用户态实现，历史上回报过绝对路径；两种形式都接住
  const abs = isAbsolute(name) ? name : join(real, name)
  const rel = relative(real, abs)
  if (rel === "") return target
  if (rel.startsWith("..")) return abs // 不在 real 之下：形式说不清，原样交出去，别硬拼一个假路径
  return join(target, rel)
}

/** chokidar 的事件路径（real 形式）换回仓库列表里的原始形式，理由同 reportedPath */
function toOriginal(pairs: readonly { orig: string; real: string }[], file: string): string {
  const hit = pairs.find((p) => isUnderPath(file, p.real))
  if (hit === undefined) return file
  const rel = relative(hit.real, file)
  return rel === "" ? hit.orig : join(hit.orig, rel)
}

export function defaultStrategy(): WatchStrategy {
  return process.platform === "win32" || process.platform === "darwin"
    ? new RecursiveRootStrategy()
    : new PerRepoStrategy()
}
