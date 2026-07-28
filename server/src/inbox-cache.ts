import { JsonStore } from "./json-store"
import type { GithubInbox } from "./types"

// GitHub「等我的」（PR/issue/CI）缓存：键为 repoId，落盘到 config 同目录的 github-inbox.json。
// 落盘后重启即可秒显上次结果（get 不看 TTL，只校验 origin url），后台再按 TTL 刷新过期项（isStale）。
interface InboxEntry {
  inbox: GithubInbox
  url: string // 拉取时的 origin url，变了说明换了远程，缓存失效
  fetchedAt: string // ISO 8601
}

const TTL_MS = 12 * 60 * 1000 // 12 分钟（PR/issue/CI 变得比描述频繁）

const isInboxEntry = (v: unknown): v is InboxEntry =>
  typeof v === "object" && v !== null && !!(v as InboxEntry).inbox &&
  typeof (v as InboxEntry).url === "string" && typeof (v as InboxEntry).fetchedAt === "string"

export class InboxCache {
  private store: JsonStore<InboxEntry>

  constructor(file: string) {
    // 防抖 1s：一整轮轮询会连着 set 几十次，攒起来写一次
    this.store = new JsonStore({ file, isValid: isInboxEntry, debounceMs: 1000 })
  }

  /** 立刻把待写的内容落盘。退出路径专用：防抖窗口是 1 秒，硬退会把最后一轮拉取结果丢掉 */
  flush(): void {
    this.store.flush()
  }

  /** origin url 一致才返回缓存（换了远程即失效）；不看 TTL——过期与否由 isStale 决定是否后台重拉。 */
  get(id: string, url: string | undefined): GithubInbox | null {
    const e = this.store.get(id)
    return e && url !== undefined && e.url === url ? e.inbox : null
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.store.get(id)
    if (!e || e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, inbox: GithubInbox): void {
    this.store.set(id, { inbox, url, fetchedAt: new Date().toISOString() })
  }

  /** 扫描后调用。剪枝逻辑连同那条 30 天年龄护栏及其理由都在 JsonStore.pruneStale 里，
   *  这里只负责指出本缓存的时间戳字段——四个缓存各写一遍迟早走样 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.fetchedAt, maxAgeMs)
  }
}
