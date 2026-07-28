import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface JsonStoreOptions<T> {
  file: string
  /** 逐条校验：坏条目单独丢弃而不是整份作废——老版本写入的部分字段变化时，好条目应当留下 */
  isValid: (v: unknown) => v is T
  /** 落盘防抖毫秒数；0（默认）= 每次 set/delete 立即写。
   *  轮询类使用者（一轮连着 set 几十次）给个 1000，避免频繁写盘 */
  debounceMs?: number
  /**
   * 文件存在但整份读不出/解析不了时调用（内容已按空处理）。
   *
   * 不给默认实现、也不在这里直接 console：底座不知道自己是哪个文件，日志里一句
   * 「JSON 坏了」对排查毫无用处。但**必须有人接**——对身份账本而言，这是
   * 「用户改过名的仓库标签全没了，但日志里有一行解释」和「用户数据丢失且零诊断面」
   * 之间的差别，而打包之后日志是唯一的诊断面。
   */
  onCorrupt?: (err: unknown) => void
  /**
   * 落盘失败时调用（内存里的内容仍然正确，本进程照常服务）。
   *
   * 与 onCorrupt 同等必要，而且更隐蔽。「缓存丢了只是慢一轮」这条策略是为
   * github-desc / github-inbox 写的，但这个底座现在还托着 `repo-identity.json`——
   * 那是**用户数据，不是缓存**。配置目录变只读 / 卷满 / 杀软锁住 `.tmp` 时的失效链是：
   * write 静默返回 → 账本整个会话都从内存里正确地服务 id，界面上零症状、日志里零字节 →
   * 用户在这个会话里改名/移动了几个仓库（账本存在的全部意义）→ 下次启动读到的是最后一次
   * 成功写入的版本或干脆没有 → 每个改过名的仓库按新路径铸造全新 id → 它的标签/收藏/
   * 归档/便签留在 config.json 里、挂在一个它已经不再拥有的 id 下。
   *
   * 也就是说：**用户看到的正是这个功能本该消灭的那个症状**。不报出来的话，用户和维护者
   * 都只能怀疑「应用把数据搞丢了」，而打包之后日志是唯一的诊断面。
   */
  onWriteError?: (err: unknown) => void
}

/**
 * 落盘 Map 的共用底座。github-desc / github-inbox / repo-cache / repo-identity 四个文件
 * 形状完全相同（load 时逐条校验、坏文件当空、写盘失败不中断），各写一遍必然逐渐走样。
 *
 * 失败一律不抛：这四个文件都是「丢了最多是慢一轮或退化成旧行为」的性质，让磁盘满/只读
 * 把整个应用带崩是不划算的。**但不抛 ≠ 不说**——读坏了走 onCorrupt，写失败走 onWriteError，
 * 两条路径都必须留下痕迹。
 */
export class JsonStore<T> {
  private map = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** 上一次落盘是不是失败的。用于「一段连续失败只报一行」，理由见 write() */
  private writeFailed = false
  private readonly file: string
  private readonly debounceMs: number
  private readonly onWriteError?: (err: unknown) => void

  constructor(opts: JsonStoreOptions<T>) {
    this.file = opts.file
    this.debounceMs = opts.debounceMs ?? 0
    this.onWriteError = opts.onWriteError
    this.load(opts.isValid, opts.onCorrupt)
  }

  private load(isValid: (v: unknown) => v is T, onCorrupt?: (err: unknown) => void): void {
    try {
      if (!existsSync(this.file)) return
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) if (isValid(v)) this.map.set(k, v)
    } catch (err) {
      // 坏文件当作空继续跑（缓存只是加速，账本坏了也只是退化成改造前行为），但必须留痕：
      // 静默吞掉的话，用户看到的是「所有改过名的仓库标签消失了」而日志里一个字都没有
      onCorrupt?.(err)
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      // 先写同目录的临时文件再 rename，不直接写目标文件：writeFileSync 是「先截断再写」，
      // 崩溃/断电正好落在这个窗口里就留下一个截断的文件，下次启动 load 会把它整份丢掉。
      // 对身份账本而言那意味着所有 id 按当前路径重新铸造——**用户改过名的每一个仓库**
      // 永久失去标签/收藏/归档/便签，而它 debounceMs 1000、每轮扫描都重写，
      // 这个窗口真实且反复出现。同目录 rename 在 NTFS 与 POSIX 上都是原子替换。
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8")
      renameSync(tmp, this.file)
      this.dirty = false
      this.writeFailed = false // 恢复了：下一段失败要重新报一行
    } catch (err) {
      // 不抛（磁盘满不该让应用挂掉），但必须报——理由见 onWriteError。
      // dirty 刻意留在 true：下一次 set/flush 会重试，一次瞬时失败不会永久丢掉这批写入。
      //
      // 一段连续失败只报第一行：repo-cache 在文件监听触发的刷新下最快每秒写一次，
      // 磁盘满时逐次记日志会把日志本身刷爆——而日志正是打包之后唯一的诊断面，
      // 把它淹掉等于又回到零诊断面。恢复之后再失败还会再报一行，够定位了
      if (!this.writeFailed) {
        this.writeFailed = true
        this.onWriteError?.(err)
      }
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
   * 用 >= 而非 >：maxAgeMs=0（调用方要「零宽限、立刻过筛」）时，刚 set() 的条目的
   * age 在同一毫秒内可能恰好是 0——严格 > 会让这类条目怎么剪都剪不掉，是个隐蔽的边界 bug。
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
      if (Number.isNaN(at) || now - at >= maxAgeMs) {
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
