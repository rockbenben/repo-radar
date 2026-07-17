import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// GitHub 仓库描述缓存：键为 repoId，落盘到 config 同目录的 github-desc.json。
// 描述极少变，命中缓存就不再联网；超过 TTL 或 origin 变了才重拉。
export interface DescEntry {
  description: string | null // GitHub 上的描述；null = 确认过 GitHub 没有描述（也缓存，避免反复空拉）
  url: string // 拉取时的 origin url，变了说明换了远程，需重拉
  fetchedAt: string // ISO 8601
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天后视为过期，允许刷新

export class DescCache {
  private map = new Map<string, DescEntry>()

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, DescEntry>
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v.url === "string" && typeof v.fetchedAt === "string") this.map.set(k, v)
      }
    } catch {
      /* 坏缓存忽略，当作空 */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8")
    } catch {
      /* 写盘失败静默：缓存只是加速，不影响功能 */
    }
  }

  /**
   * 供 store 覆盖用：非空且 origin url 与当前一致的 GitHub 描述才返回，否则 null（回退本地描述）。
   * 带 url 校验是关键——换了 origin 后旧描述属于另一个仓库，缓存尚未刷新前不能拿旧的顶上去。
   */
  get(id: string, url: string | undefined): string | null {
    const e = this.map.get(id)
    if (!e || !e.description) return null
    if (url === undefined || e.url !== url) return null // origin 缺失或已变：不用旧缓存，等后台按新 url 重拉
    return e.description
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.map.get(id)
    if (!e) return true
    if (e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true // 时间戳损坏视为过期，允许重拉（否则 NaN>TTL 恒为 false，永不刷新）
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, description: string | null): void {
    this.map.set(id, { description, url, fetchedAt: new Date().toISOString() })
    this.save()
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
    if (changed) this.save()
  }
}
