import { basename, relative, sep } from "node:path"
import type { Config } from "./config"
import { checkHealth } from "./health"
import { composeStatus, getRepoCore, getRepoHeavy, repoId } from "./git"
import { gitFingerprint } from "./fingerprint"
import type { RepoCache } from "./repo-cache"
import { githubRemoteUrl } from "./github"
import { scan } from "./scanner"
import type { GithubInbox, RepoStatus } from "./types"

const CONCURRENCY = 8

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export function deriveGroup(repoPath: string, roots: string[]): string {
  for (const root of roots) {
    const rel = relative(root, repoPath)
    if (rel === "") return "(root)"
    if (!rel.startsWith("..") && !rel.includes(":")) {
      const parts = rel.split(sep)
      return parts.length > 1 ? parts[0] : "(root)"
    }
  }
  return "(manual)"
}

export class RepoStore {
  private repos = new Map<string, RepoStatus>()
  private inFlight: Promise<RepoStatus[]> | null = null
  // 全量扫描进行中被 refreshOne 刷新过的仓库（id → 新状态）：收尾合并时以这些为准，
  // 防止整份快照把更新的状态打回扫描时的旧值
  private freshened = new Map<string, RepoStatus>()
  // 每个仓库的本地描述（getRepoStatus 得来，未被 GitHub 覆盖前）；GitHub 描述被清空时据此回退，
  // 避免 redecorate 复用已覆盖对象导致旧描述残留
  private baseDesc = new Map<string, string | null>()

  constructor(
    private readonly getConfig: () => Config,
    // 可选：返回某仓库缓存的 GitHub 描述（非空且 origin url 一致才覆盖本地描述）；后台补全写缓存后再 redecorate 生效
    private readonly getGithubDesc?: (id: string, url: string | undefined) => string | null,
    // 可选：返回某仓库缓存的 GitHub「等我的」（PR/issue/CI）；同样按 origin url 校验，后台轮询写缓存后 redecorate 生效
    private readonly getGithubInbox?: (id: string, url: string | undefined) => GithubInbox | null,
    // 可选：heavy 字段的指纹缓存。不传时完全退化成「每轮全价刷新」（旧行为），
    // 测试与嵌入式用法据此免去落盘依赖
    private readonly cache?: RepoCache,
  ) {}

  refreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefreshAll(onProgress).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * 一个仓库的完整刷新，但 heavy 那 6 个 git 进程按 `.git` 指纹跳过。
   *
   * 顺序很关键：先跑 core 拿到 oid，再算指纹。oid 是 status 顺带给的（不额外 spawn），
   * 而它能识别出「mtime 因触碰而变、内容其实没变」以及反过来的情况。
   */
  private async refreshRepo(path: string, id: string): Promise<RepoStatus> {
    const core = await getRepoCore(path)
    const fp = gitFingerprint(path, core.oid)
    const cached = this.cache?.get(id, fp) ?? null
    if (cached) return composeStatus(path, id, core, cached)
    const heavy = await getRepoHeavy(path, core.branch)
    if (fp !== null) this.cache?.set(id, fp, heavy)
    return composeStatus(path, id, core, heavy)
  }

  private async doRefreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    this.freshened.clear() // 上一轮若中途抛错可能有残留，本轮只认本轮的
    const cfg = this.getConfig()
    const paths = [...new Set([...scan(cfg.roots, cfg.excludes), ...cfg.manualRepos])]
    let scanned = 0
    const statuses = await mapLimit(paths, CONCURRENCY, async (p) => {
      let status: RepoStatus
      try {
        const fresh = await this.refreshRepo(p, repoId(p))
        this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
        status = this.decorate(fresh, cfg)
      } catch (err) {
        status = this.errorStatus(p, cfg, err)
      }
      scanned++
      onProgress?.(scanned, paths.length)
      return status
    })
    // 收尾前用「现在」的配置把所有状态重新装饰一遍：扫描期间用户可能改了收藏/标签/
    // 备注/归档（redecorate 已广播新状态），而上面的 statuses 是用开跑时的 cfg 快照装饰的——
    // 不重新装饰就整份装进去，会把用户刚打的 ⭐ 打回旧值，且要错到下一轮 redecorate 或
    // 兜底重扫（默认 30 分钟）才恢复。decorate 只查配置和缓存、不碰 git，全量重跑很便宜
    const cfgNow = this.getConfig()
    const next = new Map(statuses.map((s) => [s.id, this.decorate(s, cfgNow)]))
    // 全量扫描是逐仓库增量读的：仓库 X 扫完之后、整轮收尾之前，用户可能已经在 X 里
    // commit/push，refreshOne（文件监听触发）拿到的才是新状态。这里若直接用本轮快照
    // 整份覆盖，X 会被打回扫描时的旧状态，且 watcher 正处冷却期、没有补救事件——
    // 看板凭空「回退」，错误状态能停到下一轮兜底重扫。凡是扫描期间被 refreshOne
    // 刷过的仓库，一律以 refreshOne 的结果为准（仓库已被本轮移除的除外）
    for (const [id, s] of this.freshened) if (next.has(id)) next.set(id, s)
    this.freshened.clear()
    this.repos = next
    // 剪掉本轮扫描已不存在的仓库，避免 baseDesc 随仓库增删/根目录变更无界增长
    for (const id of this.baseDesc.keys()) if (!this.repos.has(id)) this.baseDesc.delete(id)
    return this.list()
  }

  async refreshOne(id: string): Promise<RepoStatus | undefined> {
    const existing = this.repos.get(id)
    if (!existing) return undefined
    const cfg = this.getConfig()
    let next: RepoStatus
    try {
      const fresh = await this.refreshRepo(existing.path, id)
      this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
      next = this.decorate(fresh, cfg)
    } catch (err) {
      next = this.errorStatus(existing.path, cfg, err)
    }
    if (!this.repos.has(id)) return undefined // 全量扫描已移除该仓库，勿复活
    this.repos.set(id, next)
    if (this.inFlight) this.freshened.set(id, next) // 全量扫描进行中：记下来，收尾合并时以这份为准
    return next
  }

  list(): RepoStatus[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): RepoStatus | undefined {
    return this.repos.get(id)
  }

  redecorate(id: string): RepoStatus | undefined {
    const existing = this.repos.get(id)
    if (!existing) return undefined
    const next = this.decorate(existing, this.getConfig())
    this.repos.set(id, next)
    return next
  }

  private decorate(status: RepoStatus, cfg: Config): RepoStatus {
    status.group = cfg.groupOverrides[status.id] ?? deriveGroup(status.path, cfg.roots)
    status.tags = cfg.tags[status.id] ?? []
    status.favorite = cfg.favorites.includes(status.id)
    status.archived = cfg.archived.includes(status.id)
    status.note = cfg.notes[status.id] ?? null
    status.lastOpened = cfg.lastOpened[status.id] ?? null
    // GitHub 描述优先于本地；缓存为空则回退到记住的本地描述（本地描述本身可能就是 null）。
    // 不能用 `?? status.description` 兜底——decorate 会原地改写 status.description，redecorate 复用旧对象时
    // 那就是上一轮已覆盖的 GitHub 描述，导致「GitHub 上清空后本地仍残留旧描述」。故用 baseDesc.has 取本地值。
    // 传当前 origin url，让缓存自行校验 origin 是否还一致（换了远程就别用旧描述）
    const ghUrl = githubRemoteUrl(status.remotes) // 主机名精确匹配 + origin 优先，与后台补全/前端跳转同一挑选逻辑
    status.githubInbox = this.getGithubInbox?.(status.id, ghUrl) ?? null
    const gd = this.getGithubDesc?.(status.id, ghUrl)
    if (status.error === null) {
      const local = this.baseDesc.has(status.id) ? (this.baseDesc.get(status.id) ?? null) : status.description
      status.description = gd ?? local
    }
    status.health = checkHealth(status, cfg)
    return status
  }

  private errorStatus(path: string, cfg: Config, err: unknown): RepoStatus {
    return this.decorate(
      {
        id: repoId(path),
        path,
        name: basename(path),
        displayName: null,
        description: null,
        language: null,
        group: "",
        tags: [],
        favorite: false,
        archived: false,
        note: null,
        lastOpened: null,
        mergedBranches: [],
        branch: null,
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        ahead: -1,
        behind: -1,
        stashCount: 0,
        stashOldest: null,
        release: null,
        remotes: [],
        lastCommit: null,
        health: [],
        githubInbox: null,
        error: err instanceof Error ? err.message : String(err),
        scannedAt: new Date().toISOString(),
      },
      cfg,
    )
  }
}
