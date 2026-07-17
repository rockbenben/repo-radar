import { basename, relative, sep } from "node:path"
import type { Config } from "./config"
import { checkHealth } from "./health"
import { getRepoStatus, repoId } from "./git"
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
  // 每个仓库的本地描述（getRepoStatus 得来，未被 GitHub 覆盖前）；GitHub 描述被清空时据此回退，
  // 避免 redecorate 复用已覆盖对象导致旧描述残留
  private baseDesc = new Map<string, string | null>()

  constructor(
    private readonly getConfig: () => Config,
    // 可选：返回某仓库缓存的 GitHub 描述（非空且 origin url 一致才覆盖本地描述）；后台补全写缓存后再 redecorate 生效
    private readonly getGithubDesc?: (id: string, url: string | undefined) => string | null,
    // 可选：返回某仓库缓存的 GitHub「等我的」（PR/issue/CI）；同样按 origin url 校验，后台轮询写缓存后 redecorate 生效
    private readonly getGithubInbox?: (id: string, url: string | undefined) => GithubInbox | null,
  ) {}

  refreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefreshAll(onProgress).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doRefreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    const cfg = this.getConfig()
    const paths = [...new Set([...scan(cfg.roots, cfg.excludes), ...cfg.manualRepos])]
    let scanned = 0
    const statuses = await mapLimit(paths, CONCURRENCY, async (p) => {
      let status: RepoStatus
      try {
        const fresh = await getRepoStatus(p)
        this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
        status = this.decorate(fresh, cfg)
      } catch (err) {
        status = this.errorStatus(p, cfg, err)
      }
      scanned++
      onProgress?.(scanned, paths.length)
      return status
    })
    this.repos = new Map(statuses.map((s) => [s.id, s]))
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
      const fresh = await getRepoStatus(existing.path)
      this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
      next = this.decorate(fresh, cfg)
    } catch (err) {
      next = this.errorStatus(existing.path, cfg, err)
    }
    if (!this.repos.has(id)) return undefined // 全量扫描已移除该仓库，勿复活
    this.repos.set(id, next)
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
