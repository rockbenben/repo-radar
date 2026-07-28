import type { RepoHeavy } from "./git"
import { JsonStore } from "./json-store"

// 「重」字段（stash / tag / remote / 最近提交 / 已合并分支）的落盘缓存，
// 键为 repoId，落盘到 config 同目录的 repo-cache.json。
// 语言与描述**不在**这里：它们来自工作区而不是 .git，被一个由 .git 算出来的指纹缓存住的话
// 永远等不到失效信号，现在由 composeStatus 每次现算（见 git.ts 的 RepoHeavy 注释）。
// 存在的意义：一轮全量重扫本来要为每个仓库 spawn 6.4 个 git 进程（实测 73 个仓库 7151ms），
// 而绝大多数仓库两轮之间根本没动过。按 .git 指纹命中缓存后只剩 status 一个进程（实测 1301ms）。
/**
 * repo-cache.json 的 schema 版本。**RepoHeavy 的形状一变就必须 +1。**
 *
 * 逐字段校验 heavy 在这里是行不通的（它有六个字段、还嵌着 release/remotes/lastCommit
 * 三个对象），而不校验的后果是致命的：这个文件已经在用户磁盘上了，形状必然会变，
 * 而旧条目只要通过校验，composeStatus 就会把缺掉的字段原样复制成 undefined，
 * 前端一句 `repo.mergedBranches.length` 当场抛 TypeError —— 整块白板，服务端零报错，
 * 用户只能靠自己找到并删掉一个他根本不知道存在的文件。
 *
 * 版本号把这件事退化成文档里写明的那个预期失效模式：版本一升，旧条目全部不认，
 * 代价是一轮全价重扫（约 7 秒），之后自动恢复。
 */
const CACHE_VERSION = 1

interface CacheEntry {
  v: number
  fingerprint: string
  heavy: RepoHeavy
  seenAt: string // ISO 8601，prune 的年龄护栏用
}

const isCacheEntry = (v: unknown): v is CacheEntry =>
  typeof v === "object" && v !== null &&
  (v as CacheEntry).v === CACHE_VERSION &&
  typeof (v as CacheEntry).fingerprint === "string" &&
  typeof (v as CacheEntry).seenAt === "string" &&
  !!(v as CacheEntry).heavy

export class RepoCache {
  private store: JsonStore<CacheEntry>

  constructor(file: string, onCorrupt?: (err: unknown) => void, onWriteError?: (err: unknown) => void) {
    // 防抖 1s：一轮全量扫描会连着 set 几十上百次
    this.store = new JsonStore({ file, isValid: isCacheEntry, debounceMs: 1000, onCorrupt, onWriteError })
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
    this.store.set(id, { v: CACHE_VERSION, fingerprint, heavy, seenAt: new Date().toISOString() })
  }

  /** 扫描后调用。年龄护栏及其理由在 JsonStore.pruneStale 里，这里只指定时间戳字段 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.seenAt, maxAgeMs)
  }

  flush(): void {
    this.store.flush()
  }
}
