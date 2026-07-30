import { JsonStore } from "./json-store"
import type { GithubInbox } from "./types"

// GitHub「等我的」（PR/issue/CI）缓存：键为 repoId，落盘到 config 同目录的 github-inbox.json。
// 落盘后重启即可秒显上次结果（get 不看 TTL，只校验 origin url），后台再按 TTL 刷新过期项（isStale）。
interface InboxEntry {
  inbox: GithubInbox
  url: string // 拉取时的 origin url，变了说明换了远程，缓存失效
  fetchedAt: string // ISO 8601
  // 累计「新到达」数（语义见 types.ts 的 GithubInbox.prsAdded）。刻意记在 entry 上而不是塞进
  // inbox：inbox 存的是 GitHub 原样返回的内容，通知那条链拿前后两轮的 inbox 做差
  // （backend.ts 的 inboxEqual / notify.ts 的 summarizeOne），掺进派生量迟早让「变了没」失真
  prsAdded?: number
  issuesAdded?: number
}

// 必须**严格小于** backend.ts 的 INBOX_REFRESH_MS（12 分钟），不能相等。定时器在 T、T+12m…
// 触发，而一轮里每个仓库的 gh 调用都在 tick 之后 d 秒才落 fetchedAt；两者相等时下一个 tick 的
// 已过时间是 12m − d，`> TTL_MS` 恒假，于是**整轮**没有一个仓库被判为过期、直接空转，实际刷新
// 间隔变成 24 分钟——正好是设计值的两倍，而托盘常驻、没有渲染进程的那个形态全靠这轮通知
const TTL_MS = 11 * 60 * 1000 // 比轮询周期少 1 分钟：留给一轮的执行时间（70 仓库并发 6 时尾部几十秒）

/**
 * 本轮比上一轮新到了几个（只数增量，减少一律按 0）。两条规矩与 desktop/src/notify.ts 逐字一致，
 * 因为通知与队列必须读同一条数据链——两边口径一旦不同，就会出现「队列冒出来了通知却没响」
 * 或者反过来的错配，而这正是这次要修的东西：
 *   - 首次拿到（没有上一轮）不算新到：否则缓存重建的那一轮会把历史积压整包当成新增
 *   - byViewer 口径不同（本轮 viewer 查询失败，计数从「已减自己」变成「含自己」）时差值是虚的
 */
function arrived(before: GithubInbox | undefined, after: GithubInbox, key: "prs" | "issues"): number {
  if (!before || before.byViewer !== after.byViewer) return 0
  return Math.max(0, after[key] - before[key])
}

const isInboxEntry = (v: unknown): v is InboxEntry =>
  typeof v === "object" && v !== null && !!(v as InboxEntry).inbox &&
  typeof (v as InboxEntry).url === "string" && typeof (v as InboxEntry).fetchedAt === "string"

export class InboxCache {
  private store: JsonStore<InboxEntry>

  constructor(file: string, onCorrupt?: (err: unknown) => void, onWriteError?: (err: unknown) => void) {
    // 防抖 1s：一整轮轮询会连着 set 几十次，攒起来写一次
    this.store = new JsonStore({ file, isValid: isInboxEntry, debounceMs: 1000, onCorrupt, onWriteError })
  }

  /** 立刻把待写的内容落盘。退出路径专用：防抖窗口是 1 秒，硬退会把最后一轮拉取结果丢掉 */
  flush(): void {
    this.store.flush()
  }

  /** origin url 一致才返回缓存（换了远程即失效）；不看 TTL——过期与否由 isStale 决定是否后台重拉。
   *  返回的是 GitHub 原样内容：通知那条链（backend.ts 取 before 做差）必须拿到不掺派生量的版本。 */
  get(id: string, url: string | undefined): GithubInbox | null {
    const e = this.store.get(id)
    return e && url !== undefined && e.url === url ? e.inbox : null
  }

  /** 给前端看的版本：额外带上累计新到达数。前端队列的「已处理」水位靠它判断
   *  「点了已处理之后到底有没有新东西进来」，而不是靠自己有没有看见计数下探（见 types.ts） */
  getWithArrivals(id: string, url: string | undefined): GithubInbox | null {
    const e = this.store.get(id)
    if (!e || url === undefined || e.url !== url) return null
    return { ...e.inbox, prsAdded: e.prsAdded ?? 0, issuesAdded: e.issuesAdded ?? 0 }
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
    const prev = this.store.get(id)
    // 换了远程等于换了仓库，累计从头记；否则接着上一轮往上加
    const carry = prev && prev.url === url ? prev : null
    this.store.set(id, {
      inbox,
      url,
      fetchedAt: new Date().toISOString(),
      prsAdded: (carry?.prsAdded ?? 0) + arrived(carry?.inbox, inbox, "prs"),
      issuesAdded: (carry?.issuesAdded ?? 0) + arrived(carry?.inbox, inbox, "issues"),
    })
  }

  /** 扫描后调用。剪枝逻辑连同那条 30 天年龄护栏及其理由都在 JsonStore.pruneStale 里，
   *  这里只负责指出本缓存的时间戳字段——四个缓存各写一遍迟早走样 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.fetchedAt, maxAgeMs)
  }
}
