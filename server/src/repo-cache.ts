import type { RepoHeavy } from "./git"
import { JsonStore } from "./json-store"

// 「重」字段（stash / tag / remote / 最近提交 / 已合并分支 / 语言 / 描述）的落盘缓存，
// 键为 repoId，落盘到 config 同目录的 repo-cache.json。
// 存在的意义：一轮全量重扫本来要为每个仓库 spawn 6.4 个 git 进程（实测 73 个仓库 7151ms），
// 而绝大多数仓库两轮之间根本没动过。按 .git 指纹命中缓存后只剩 status 一个进程（实测 1301ms）。
interface CacheEntry {
  fingerprint: string
  heavy: RepoHeavy
  seenAt: string // ISO 8601，prune 的年龄护栏用
}

const isCacheEntry = (v: unknown): v is CacheEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as CacheEntry).fingerprint === "string" &&
  typeof (v as CacheEntry).seenAt === "string" &&
  !!(v as CacheEntry).heavy

export class RepoCache {
  private store: JsonStore<CacheEntry>

  constructor(file: string) {
    // 防抖 1s：一轮全量扫描会连着 set 几十上百次
    this.store = new JsonStore({ file, isValid: isCacheEntry, debounceMs: 1000 })
  }

  /**
   * 指纹完全相等才命中。fingerprint 为 null（worktree/submodule 等 .git 非目录的情况）
   * 一律未命中——见 fingerprint.ts 里为什么不能给这类仓库一个恒定指纹。
   */
  get(id: string, fingerprint: string | null): RepoHeavy | null {
    if (fingerprint === null) return null
    const e = this.store.get(id)
    return e && e.fingerprint === fingerprint ? e.heavy : null
  }

  set(id: string, fingerprint: string, heavy: RepoHeavy): void {
    this.store.set(id, { fingerprint, heavy, seenAt: new Date().toISOString() })
  }

  /** 扫描后调用。年龄护栏及其理由在 JsonStore.pruneStale 里，这里只指定时间戳字段 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.seenAt, maxAgeMs)
  }

  flush(): void {
    this.store.flush()
  }
}
