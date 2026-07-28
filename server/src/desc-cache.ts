import { JsonStore } from "./json-store"

// GitHub 仓库描述缓存：键为 repoId，落盘到 config 同目录的 github-desc.json。
// 描述极少变，命中缓存就不再联网；超过 TTL 或 origin 变了才重拉。
export interface DescEntry {
  description: string | null // null = 确认过 GitHub 没有描述（也缓存，避免反复空拉）
  url: string // 拉取时的 origin url，变了说明换了远程，需重拉
  fetchedAt: string // ISO 8601
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天后视为过期，允许刷新

const isDescEntry = (v: unknown): v is DescEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as DescEntry).url === "string" && typeof (v as DescEntry).fetchedAt === "string"

export class DescCache {
  private store: JsonStore<DescEntry>

  constructor(file: string) {
    this.store = new JsonStore({ file, isValid: isDescEntry })
  }

  /**
   * 供 store 覆盖用：非空且 origin url 与当前一致的 GitHub 描述才返回，否则 null（回退本地描述）。
   * 带 url 校验是关键——换了 origin 后旧描述属于另一个仓库，缓存尚未刷新前不能拿旧的顶上去。
   */
  get(id: string, url: string | undefined): string | null {
    const e = this.store.get(id)
    if (!e || !e.description) return null
    if (url === undefined || e.url !== url) return null
    return e.description
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.store.get(id)
    if (!e) return true
    if (e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true // 时间戳损坏视为过期（否则 NaN>TTL 恒为 false，永不刷新）
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, description: string | null): void {
    this.store.set(id, { description, url, fetchedAt: new Date().toISOString() })
  }

  /** 扫描后调用。剪枝逻辑连同那条 30 天年龄护栏及其理由都在 JsonStore.pruneStale 里，
   *  这里只负责指出本缓存的时间戳字段——四个缓存各写一遍迟早走样 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.fetchedAt, maxAgeMs)
  }
}
