import { watch, type FSWatcher } from "chokidar"
import { join } from "node:path"

interface WatchedRepo {
  id: string
  path: string
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
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private cooldownUntil = new Map<string, number>()

  constructor(
    private readonly onRepoChanged: (repoId: string) => void,
    private readonly debounceMs = 500,
    private readonly cooldownMs = 60_000,
  ) {}

  async watch(repos: WatchedRepo[]): Promise<void> {
    await this.close()
    this.repos = [...repos].sort((a, b) => b.path.length - a.path.length) // 最长前缀优先，嵌套路径归属正确
    const targets = repos.flatMap((r) => [
      join(r.path, ".git", "HEAD"),
      join(r.path, ".git", "index"),
      join(r.path, ".git", "refs"),
      r.path,
    ])
    this.watcher = watch(targets, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p) => p.includes("node_modules"),
    })
    this.watcher.on("all", (_event, file) => this.handle(file))
    this.watcher.on("error", (err) => {
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

  async close(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    for (const t of this.pendingTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.pendingTimers.clear()
    this.cooldownUntil.clear()
    await this.watcher?.close()
    this.watcher = null
  }
}
