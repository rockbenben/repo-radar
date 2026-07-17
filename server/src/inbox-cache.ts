import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { GithubInbox } from "./types"

// GitHub「等我的」（PR/issue/CI）缓存：键为 repoId，落盘到 config 同目录的 github-inbox.json。
// 落盘后重启即可秒显上次结果（get 不看 TTL，只校验 origin url），后台再按 TTL 刷新过期项（isStale）。
interface InboxEntry {
  inbox: GithubInbox
  url: string // 拉取时的 origin url，变了说明换了远程，缓存失效
  fetchedAt: string // ISO 8601
}

const TTL_MS = 12 * 60 * 1000 // 12 分钟后视为过期，允许刷新（PR/issue/CI 变得比描述频繁）

export class InboxCache {
  private map = new Map<string, InboxEntry>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, InboxEntry>
      for (const [k, v] of Object.entries(obj)) {
        if (v && v.inbox && typeof v.url === "string" && typeof v.fetchedAt === "string") this.map.set(k, v)
      }
    } catch {
      /* 坏缓存忽略，当作空 */
    }
  }

  // 防抖落盘：一整轮轮询会连着 set 几十次，攒到 1s 后写一次，避免频繁写盘
  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8")
      } catch {
        /* 写盘失败静默：缓存只是加速，不影响功能 */
      }
    }, 1000)
  }

  /** origin url 一致才返回缓存（换了远程即失效）；不看 TTL——过期与否由 isStale 决定是否后台重拉。 */
  get(id: string, url: string | undefined): GithubInbox | null {
    const e = this.map.get(id)
    return e && url !== undefined && e.url === url ? e.inbox : null
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.map.get(id)
    if (!e || e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, inbox: GithubInbox): void {
    this.map.set(id, { inbox, url, fetchedAt: new Date().toISOString() })
    this.scheduleSave()
  }

  /**
   * 扫描后调用：剪掉「不在本轮扫描里、且已 30 天没刷新」的条目，防缓存无界增长。
   * 必须带年龄护栏——网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，
   * 立即剪会把它们的落盘缓存永久抹掉；真删掉的仓库不再刷新，30 天后自然过筛。
   */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    let changed = false
    const now = Date.now()
    for (const [id, e] of this.map) {
      if (keepIds.has(id)) continue
      const at = new Date(e.fetchedAt).getTime()
      if (Number.isNaN(at) || now - at > maxAgeMs) {
        this.map.delete(id)
        changed = true
      }
    }
    if (changed) this.scheduleSave()
  }
}
