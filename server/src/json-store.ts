import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface JsonStoreOptions<T> {
  file: string
  /** 逐条校验：坏条目单独丢弃而不是整份作废——老版本写入的部分字段变化时，好条目应当留下 */
  isValid: (v: unknown) => v is T
  /** 落盘防抖毫秒数；0（默认）= 每次 set/delete 立即写。
   *  轮询类使用者（一轮连着 set 几十次）给个 1000，避免频繁写盘 */
  debounceMs?: number
}

/**
 * 落盘 Map 的共用底座。github-desc / github-inbox / repo-cache / repo-identity 四个文件
 * 形状完全相同（load 时逐条校验、写盘失败静默、坏文件当空），各写一遍必然逐渐走样。
 *
 * 落盘失败一律静默：这四个文件都是「丢了最多是慢一轮或退化成旧行为」的性质，
 * 让磁盘满/只读把整个应用带崩是不划算的。真正需要知道文件坏了的场景由调用方记日志。
 */
export class JsonStore<T> {
  private map = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private readonly file: string
  private readonly debounceMs: number

  constructor(opts: JsonStoreOptions<T>) {
    this.file = opts.file
    this.debounceMs = opts.debounceMs ?? 0
    this.load(opts.isValid)
  }

  private load(isValid: (v: unknown) => v is T): void {
    try {
      if (!existsSync(this.file)) return
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) if (isValid(v)) this.map.set(k, v)
    } catch {
      /* 坏文件忽略，当作空 */
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8")
      this.dirty = false
    } catch {
      /* 写盘失败静默 */
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.debounceMs === 0) {
      this.write()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, this.debounceMs)
  }

  get(key: string): T | undefined {
    return this.map.get(key)
  }

  set(key: string, value: T): void {
    this.map.set(key, value)
    this.schedule()
  }

  delete(key: string): boolean {
    if (!this.map.delete(key)) return false
    this.schedule()
    return true
  }

  entries(): [string, T][] {
    return [...this.map]
  }

  /**
   * 扫描后剪枝：剪掉「不在 keepIds 里、且已超过 maxAgeMs 没被刷新」的条目，防无界增长。
   *
   * 年龄护栏不是可选的。网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，
   * 立即剪会把它们的落盘数据永久抹掉——对身份账本尤其致命：条目一剪，那批仓库回来时
   * 会被当成全新仓库，标签/收藏/归档全丢，正是本轮要消灭的行为。真删掉的仓库不再刷新，
   * 30 天后自然过筛。
   *
   * timestampOf 让各使用者指定自己的时间戳字段（fetchedAt / seenAt）。非法时间戳按已过期
   * 处理——否则 NaN 比较恒为 false，坏条目会永久赖着不走。
   *
   * 不逐条调用公开的 delete()：debounceMs === 0（如 DescCache）时 delete() 会同步落盘一次，
   * 逐条调用就是剪 N 条条目做 N 次全量 JSON.stringify + writeFileSync。而剪枝恰好在
   * 「网络盘根目录瞬时掉线、一整批条目同时过期」时删得最多——那正是磁盘最慢、最不该做
   * 一串同步全量写的时刻。这里直接改 map，循环结束后最多只落盘一次。
   */
  pruneStale(keepIds: Set<string>, timestampOf: (v: T) => string, maxAgeMs = 30 * 86_400_000): void {
    const now = Date.now()
    let changed = false
    for (const [key, v] of this.map) {
      if (keepIds.has(key)) continue
      const at = new Date(timestampOf(v)).getTime()
      if (Number.isNaN(at) || now - at > maxAgeMs) {
        this.map.delete(key)
        changed = true
      }
    }
    if (changed) this.schedule()
  }

  /** 立刻把待写内容落盘。退出路径专用——防抖窗口内硬退会丢掉最后一批写入 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.write()
  }
}
