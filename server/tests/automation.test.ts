import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAutomation, intervalMs, pathGone } from "../src/automation"
import { DEFAULT_CONFIG, loadConfig, MAX_INTERVAL_MINUTES, saveConfig, type Config } from "../src/config"
import type { RepoStatus } from "../src/types"
import type { RepoWatcher, WatchedRepo } from "../src/watcher"

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function configFile(patch: Partial<Config> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-auto-"))
  dirs.push(dir)
  const file = join(dir, "config.json")
  saveConfig(file, { ...structuredClone(DEFAULT_CONFIG), ...patch })
  return file
}

/**
 * 覆盖率分母里的「路径失效」判定的测试替身：一律当成还在磁盘上。
 *
 * 这批用例的仓库路径都是假的（`/r/a`、`/r/b`），磁盘上并不存在。用真实判定（ENOENT）的话
 * 它们会被全部判成「已失效」，覆盖率分母被整个抹平，于是降级/补挂的判断永远不成立——
 * 所有关于 watchLimit 截断、watchDegraded 自愈、新仓库补挂的断言测到的都不再是它们想测的
 * 东西（会「因为另一个原因」通过或失败）。真实判定由下面「路径失效的仓库不进覆盖率分母」
 * 那一组用例单独钉住，它们用的是真实临时目录
 */
const allPathsAlive = (): boolean => false

const repo = (id: string, opts: { favorite?: boolean; date?: string; archived?: boolean } = {}): RepoStatus =>
  ({
    id,
    path: `/r/${id}`,
    name: id,
    favorite: opts.favorite ?? false,
    archived: opts.archived ?? false,
    lastCommit: opts.date ? { date: opts.date } : null,
  }) as unknown as RepoStatus

/** 临时改写 process.platform 探测平台分叉；finally 还原，不污染其它用例。
 *  与 watch-strategy.test.ts 的同名 helper 同一手法，但这里包的是 async 调用（applyWatch）——
 *  必须等 fn() 的 promise 真正 settle 之后再还原平台，而不是 fn() 一返回 pending promise
 *  就立刻还原：applyWatch 内部虽然是在第一个 await 之前就读的 process.platform（usesPerRepoWatching
 *  的判断先于 watcher.setRoots 的 await），但同步-签名的 withPlatform 依赖这个实现细节，
 *  一旦 applyWatch 内部顺序变化就会静默失效——用 async 版本不依赖这个假设，更稳 */
async function withPlatform<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...desc, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, "platform", desc)
  }
}

/** 记录 setRoots/setRepos/close 调用的假 watcher。coveredRepoCount 从「最近一次 setRoots
 *  建立的名单」派生（started 时按名单数，close 之后为 0）——与真实 RepoWatcher 同一形状：
 *  它只按上一次真正建立的 okRoots 计数，setRepos 更新的映射表不影响这个数。这样一来，
 *  已有的 watchLimit 截断类断言（coverage 应等于 chosen.length）不用改写。
 *
 *  `roots` 参数也如实记下来（评审 I3）：只数 setRoots 被调用了几次，抓不住「roots 传的是不是
 *  空数组」这类退化——把 automation.ts 里 `watcher.setRoots(cfg.roots, …)` 悄悄改回 Task 7
 *  遗留的占位 `watcher.setRoots([], …)`，call 数不变、这里所有原本只查 watched/closes 的用例
 *  仍然全绿，但 Windows/macOS 上会变成一个 scan root 都没被监听——必须有用例去查 setRoots
 *  实际收到的 roots 内容，不能只数它被调用的次数 */
function fakeWatcher() {
  const watched: string[][] = []
  const entries: WatchedRepo[][] = []
  const rootsCalls: string[][] = []
  const excludesCalls: (readonly string[])[] = []
  let closes = 0
  let started = false
  let current: WatchedRepo[] = []
  const w = {
    setRoots: async (roots: string[], list: WatchedRepo[], excludes: readonly string[] = []) => {
      rootsCalls.push([...roots])
      excludesCalls.push([...excludes])
      current = list
      entries.push(list)
      watched.push(list.map((r) => r.id))
      started = true
    },
    setRepos: (_list: WatchedRepo[]) => {
      // 只更新映射表：真实 watcher 里 coveredRepoCount 仍按上一次 setRoots 的 okRoots 计，
      // 这里不需要跟着变——这正是 applyRepos 不该被当成能扩大覆盖范围的动作的体现
    },
    close: async () => {
      closes++
      started = false
      current = []
    },
    // 归档仓库不计入，与真实 watcher 一致：它们进这份名单只是为了让事件有归属可认，
    // 本来就不建目标（见 WatchedRepo.archived），算进覆盖数会让 coverage 虚高
    coveredRepoCount: () => (started ? current.filter((r) => !r.archived).length : 0),
    isCovered: (p: string) => started && current.some((r) => r.path === p && r.archived !== true),
    watchedRoots: () => (started ? ["/fake-root"] : []),
  }
  return { watcher: w as unknown as RepoWatcher, watched, entries, rootsCalls, excludesCalls, closes: () => closes }
}

/**
 * 更接近真实 RepoWatcher 的假 watcher：`coveredRepoCount` 按「**当前映射表**里的仓库有多少
 * 落在**上一次 setRoots 真正建成的目标**之下」算，而不是简单返回名单长度。G1 的整条推理都活在
 * 这个差别里——`setRepos` 只改映射表、从不触达策略，于是「上一次 applyWatch 之后才出现的仓库」
 * 在递归策略下已被 root 句柄覆盖（不必重挂），在逐仓库策略下一个句柄都没有（必须重挂）。
 *
 * `mode` 决定覆盖语义，与 `process.platform` 无关：两条腿在两个 CI 平台上都要真跑。
 * `failFirst` 模拟「第一次挂 root 时网络盘离线」。
 */
function coverageWatcher(mode: "recursive" | "per-repo", opts: { failFirst?: boolean } = {}) {
  let ok: string[] = []
  let mapped: WatchedRepo[] = []
  let started = false
  let attempts = 0
  const rootCalls: WatchedRepo[][] = []
  const covered = (p: string): boolean => ok.some((o) => p === o || p.startsWith(`${o}/`))
  const w = {
    setRoots: async (roots: string[], list: WatchedRepo[]) => {
      attempts++
      rootCalls.push(list)
      mapped = list
      const offline = opts.failFirst === true && attempts === 1
      ok = offline ? [] : mode === "recursive" ? [...roots] : list.filter((r) => !r.archived).map((r) => r.path)
      started = true
    },
    setRepos: (list: WatchedRepo[]) => void (mapped = list),
    close: async () => {
      ok = []
      started = false
    },
    coveredRepoCount: () => (started ? mapped.filter((r) => !r.archived && covered(r.path)).length : 0),
    isCovered: (p: string) => started && covered(p),
    watchedRoots: () => [...ok],
  }
  return { watcher: w as unknown as RepoWatcher, rootCalls, calls: () => attempts }
}

function make(file: string, repos: RepoStatus[], extra: { rescan?: () => Promise<unknown>; fetchAll?: () => Promise<void> } = {}) {
  const fw = fakeWatcher()
  const logs: string[] = []
  const automation = createAutomation({
    configFile: file,
    watcher: fw.watcher,
    listRepos: () => repos,
    rescan: extra.rescan ?? (async () => {}),
    fetchAll: extra.fetchAll ?? (async () => {}),
    pathGone: allPathsAlive,
    log: (m) => void logs.push(m),
  })
  return { automation, ...fw, logs }
}

describe("intervalMs", () => {
  it("夹在 [1 分钟, 溢出线]：手改配置绕过 API 校验时也不能变成 60ms 死循环或溢出成 1ms", () => {
    expect(intervalMs(30)).toBe(30 * 60_000)
    expect(intervalMs(0.001)).toBe(60_000) // 下限：亚分钟 → 1 分钟
    expect(intervalMs(MAX_INTERVAL_MINUTES + 10_000)).toBe(MAX_INTERVAL_MINUTES * 60_000)
    expect(intervalMs(MAX_INTERVAL_MINUTES)).toBeLessThanOrEqual(2 ** 31 - 1)
  })
})

describe("applyWatch 的上限与取舍", () => {
  it("未超上限时全部监听，覆盖数如实反映", async () => {
    const file = configFile({ watchLimit: 200 })
    const { automation, watched } = make(file, [repo("a"), repo("b")])
    await automation.applyWatch(true)
    expect(watched[0]).toEqual(["a", "b"])
    expect(automation.coverage()).toEqual({ watched: 2, total: 2 })
  })

  // 归档仓库不建监听目标，但**必须**带着标记留在交给 watcher 的名单里：递归 root 句柄照样
  // 看得见它们的写入，而未归属的事件会被当成「目录结构变化」，触发一轮 force=true 的全量重扫
  //（refreshAll + 全部句柄拆建）并按 60 秒冷却持续重复——归档一个正在用的仓库反而让应用
  // 比不归档时忙得多。删出名单的写法在这里看起来「更干净」，代价是这条持续的重扫风暴
  it("已归档的仓库带标记进归属映射（不建目标），且不计入总数", async () => {
    const file = configFile()
    const { automation, entries } = make(file, [repo("a"), repo("skip", { archived: true })])
    await automation.applyWatch(true)
    expect(entries[0]).toEqual([
      { id: "a", path: "/r/a", archived: false },
      { id: "skip", path: "/r/skip", archived: true },
    ])
    expect(automation.coverage()).toEqual({ watched: 1, total: 1 }) // 归档的不计入分子也不计入分母
  })

  // watchLimit 截断只在逐仓库策略（Linux）下生效——递归策略一个 scan root 一个句柄，
  // 仓库数再多也不会多开句柄，截断没有东西可省（见 watch-strategy.ts 的 usesPerRepoWatching）。
  // 这几个用例断言的正是「截断确实发生」，故显式钉在 linux 上跑，两个 CI 平台的结果才一致；
  // 不钉的话在 windows-latest 上会因为压根不截断而集体假失败
  //
  // 收藏是用户明确说过「这个重要」的信号。只按提交时间排的话，一个 CI 机器人的提交
  // 就能把用户天天开的仓库挤出监听名额
  it("名额不够时收藏优先于最近提交（逐仓库策略）", async () => {
    const file = configFile({ watchLimit: 2 })
    const repos = [
      repo("bot", { date: "2026-07-27T10:00:00Z" }), // 最新，但没收藏
      repo("fav-old", { favorite: true, date: "2020-01-01T00:00:00Z" }),
      repo("fav-new", { favorite: true, date: "2026-01-01T00:00:00Z" }),
    ]
    const { automation, watched } = make(file, repos)
    await withPlatform("linux", () => automation.applyWatch(true))
    expect(watched[0]).toEqual(["fav-new", "fav-old"]) // 两个收藏占满名额，且收藏内部仍按时间排
    expect(automation.coverage()).toEqual({ watched: 2, total: 3 })
  })

  // lastCommit.date 是带各自时区偏移的 ISO（git %aI）。字符串比较会按墙钟文本排错序：
  // "2026-07-27T10:00:00+08:00"（=02:00Z）的文本大于 "2026-07-27T03:00:00Z"，但其实更早
  it("按真实时间戳排序，不被时区偏移的墙钟文本骗过（逐仓库策略）", async () => {
    const file = configFile({ watchLimit: 1 })
    const repos = [
      repo("wall-clock-later", { date: "2026-07-27T10:00:00+08:00" }), // 实际 02:00Z
      repo("actually-newer", { date: "2026-07-27T03:00:00Z" }),
    ]
    const { automation, watched } = make(file, repos)
    await withPlatform("linux", () => automation.applyWatch(true))
    expect(watched[0]).toEqual(["actually-newer"])
  })

  it("watchLimit=0 表示无上限（0 直接短路，与平台无关）", async () => {
    const file = configFile({ watchLimit: 0 })
    const repos = Array.from({ length: 300 }, (_, i) => repo(`r${i}`))
    const { automation, watched } = make(file, repos)
    await automation.applyWatch(true)
    expect(watched[0]).toHaveLength(300)
    expect(automation.coverage()).toEqual({ watched: 300, total: 300 })
  })

  // 关闭不等于仓库消失：total 仍如实反映非归档仓库数，只有 watched（来自 watcher 的真实计数）
  // 归零——否则界面会把「监听关着」和「压根没有仓库」显示成同一句话
  it("关闭监听时关掉 watcher，watched 归零但 total 仍如实反映非归档仓库数", async () => {
    const file = configFile()
    const { automation, closes } = make(file, [repo("a")])
    await automation.applyWatch(true)
    await automation.applyWatch(false)
    expect(closes()).toBe(1)
    expect(automation.coverage()).toEqual({ watched: 0, total: 1 })
  })

  // 截断了却谎称「其余靠兜底重扫」，在兜底重扫被关掉时就是假话
  it("截断日志按兜底重扫是否开着说不同的话（逐仓库策略）", async () => {
    const repos = [repo("a"), repo("b"), repo("c")]
    const on = make(configFile({ watchLimit: 1, autoScanMinutes: 30 }), repos)
    await withPlatform("linux", () => on.automation.applyWatch(true))
    expect(on.logs.join()).toContain("30")
    expect(on.logs.join()).not.toContain("NOT refresh")

    const off = make(configFile({ watchLimit: 1, autoScanMinutes: 0 }), repos)
    await withPlatform("linux", () => off.automation.applyWatch(true))
    expect(off.logs.join()).toContain("NOT refresh")
  })

  it("未截断时不打日志", async () => {
    const { automation, logs } = make(configFile({ watchLimit: 10 }), [repo("a")])
    await automation.applyWatch(true)
    expect(logs).toEqual([])
  })

  // 递归策略（win32/darwin）下 watchLimit 不生效：一个 root 一个句柄，仓库数再多也不截断，
  // chosen 恒等于 all——这条与上面「逐仓库策略下会截断」的用例互为正反面，两条腿都要有人验
  it("递归策略下 watchLimit 不截断，即便仓库数超过上限", async () => {
    const file = configFile({ watchLimit: 1 })
    const repos = [repo("a"), repo("b"), repo("c")]
    const { automation, watched, logs } = make(file, repos)
    await withPlatform("win32", () => automation.applyWatch(true))
    expect(watched[0]).toHaveLength(3)
    expect(automation.coverage()).toEqual({ watched: 3, total: 3 })
    expect(logs).toEqual([]) // 没有截断，自然也没有「超过上限」的日志
  })
})

describe("setX 落盘并立即生效", () => {
  // watchLimit 只在逐仓库策略（Linux）下截断，钉平台的理由同上面的「applyWatch 的上限与取舍」
  it("setWatchLimit 落盘并重挂监听（否则面板显示的覆盖数和真实监听对不上）", async () => {
    // autoWatch 显式打开：默认已改成关闭，而这些用例钉的是「重挂监听」，跟着默认值走的话
    // applyWatch 会直接 return，一次都不会挂上
    const file = configFile({ watchLimit: 0, autoWatch: true })
    const { automation, watched } = make(file, [repo("a"), repo("b"), repo("c")])
    await withPlatform("linux", () => automation.setWatchLimit(2))
    expect(loadConfig(file).watchLimit).toBe(2)
    expect(watched.at(-1)).toHaveLength(2)
    expect(automation.coverage()).toEqual({ watched: 2, total: 3 })
  })

  // 先落盘、再装监听：装监听抛错（chokidar EMFILE 等）时磁盘上已经是新值，把错误抛给
  // 路由变成 500 会让客户端回滚 UI——从此界面显示的和盘上存的对不上，下轮重扫还会按
  // 盘上的值再试。以磁盘为准：不抛，记日志
  it("setWatchLimit / setWatch 在监听器抛错时不抛，落盘保留、错误进日志", async () => {
    const file = configFile()
    const logs: string[] = []
    const failing = {
      setRoots: async () => {
        throw new Error("EMFILE")
      },
      close: async () => {
        throw new Error("EMFILE")
      },
    } as unknown as RepoWatcher
    const automation = createAutomation({
      configFile: file,
      watcher: failing,
      listRepos: () => [repo("a")],
      rescan: async () => {},
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: (m) => void logs.push(m),
    })
    await expect(automation.setWatchLimit(500)).resolves.toBeUndefined()
    expect(loadConfig(file).watchLimit).toBe(500) // 磁盘上确实是新值
    await expect(automation.setWatch(false)).resolves.toBeUndefined()
    expect(loadConfig(file).autoWatch).toBe(false)
    expect(logs.join()).toContain("EMFILE")
  })

  it("setWatch / setAutoScan / setAutoFetch 各自只改自己那个字段", async () => {
    const file = configFile()
    const { automation } = make(file, [])
    await automation.setWatch(false)
    await automation.setAutoScan(10)
    await automation.setAutoFetch(15)
    const cfg = loadConfig(file)
    expect(cfg.autoWatch).toBe(false)
    expect(cfg.autoScanMinutes).toBe(10)
    expect(cfg.autoFetchMinutes).toBe(15)
    expect(cfg.watchLimit).toBe(DEFAULT_CONFIG.watchLimit) // 没碰的字段保持原样
  })
})

describe("applyConfig 只重装真变了的", () => {
  it("值没变时不碰监听器，也不重置定时器倒计时", async () => {
    vi.useFakeTimers()
    const file = configFile({ autoScanMinutes: 10 })
    let scans = 0
    const { automation, watched, closes } = make(file, [repo("a")], { rescan: async () => void scans++ })
    const cfg = loadConfig(file)
    automation.start(cfg)

    vi.advanceTimersByTime(9 * 60_000)
    // 整份 GET→改一处→PUT 回来：三个自动化字段都在 body 里但值没变，
    // 无脑重装会把倒计时清零 —— 周期性保存的客户端能让兜底重扫永远不触发
    await automation.applyConfig({ ...cfg, notes: { x: "hi" } }, cfg)
    expect(watched).toHaveLength(0)
    expect(closes()).toBe(0)

    vi.advanceTimersByTime(1 * 60_000)
    expect(scans).toBe(1) // 倒计时没被重置，10 分钟准时触发
  })

  it("间隔变了才重装定时器", async () => {
    vi.useFakeTimers()
    const file = configFile({ autoScanMinutes: 10 })
    let scans = 0
    const { automation } = make(file, [], { rescan: async () => void scans++ })
    const prev = loadConfig(file)
    automation.start(prev)
    await automation.applyConfig({ ...prev, autoScanMinutes: 5 }, prev)
    vi.advanceTimersByTime(5 * 60_000)
    expect(scans).toBe(1)
  })

  // watchLimit 有专属的 setWatchLimit 端点，但那只覆盖 web UI 恰好走的那条路。GET → 改一处 →
  // PUT 整份配置回来是最常见的客户端写法，走的正是这里：不重装的话，值落了盘、面板也显示了
  // 新上限，而 applyWatch 从不被调用——Linux 上超出旧上限的仓库直到进程结束都不被监听，
  // 界面却声称新上限已覆盖全部。钉平台的理由同上：截断只在逐仓库策略下发生
  it("watchLimit 变了也要重挂监听（整份 PUT /api/config 回来时）", async () => {
    const file = configFile({ watchLimit: 0, autoWatch: true })
    const { automation, watched } = make(file, [repo("a"), repo("b"), repo("c")])
    const prev = loadConfig(file)
    saveConfig(file, { ...prev, watchLimit: 1 }) // 模拟 PUT /api/config 已落盘
    await withPlatform("linux", () => automation.applyConfig({ ...prev, watchLimit: 1 }, prev))
    expect(watched).toHaveLength(1) // 重挂了一次
    expect(watched[0]).toEqual(["a"]) // 而且是按**新**上限截断的名单，不是旧的
  })

  // roots 变了 → 监听目标本身变了，只有重建能让新 root 生效——递归策略下这是唯一入口，
  // 不像 watchLimit 那样有专属端点兜底
  it("roots 变了要重挂监听，且 watcher.setRoots 收到的是真实的 roots（不是占位的空数组）", async () => {
    const file = configFile({ roots: ["/old"], autoWatch: true })
    const { automation, watched, rootsCalls } = make(file, [repo("a")])
    const prev = loadConfig(file)
    saveConfig(file, { ...prev, roots: ["/new"] })
    await automation.applyConfig({ ...prev, roots: ["/new"] }, prev)
    expect(watched).toHaveLength(1)
    // 只数调用次数抓不住「roots 传的是不是空数组」这类退化（评审 I3）：Task 7 遗留的占位
    // watcher.setRoots([], …) 调用次数与这里完全一样，call 数断言不会变红，但 Windows/macOS 上
    // 递归策略会因为 roots 是空数组而一个 scan root 都不建立监听，仓库只能靠各自的 manualRepo
    // 句柄兜底（数量多时等于白做了「一个 root 一个句柄」这件事）
    expect(rootsCalls.at(-1)).toEqual(["/new"])
  })

  it("manualRepos 变了也要重挂监听", async () => {
    const file = configFile({ manualRepos: [], autoWatch: true })
    const { automation, watched } = make(file, [repo("a")])
    const prev = loadConfig(file)
    saveConfig(file, { ...prev, manualRepos: ["/x"] })
    await automation.applyConfig({ ...prev, manualRepos: ["/x"] }, prev)
    expect(watched).toHaveLength(1)
  })

  // autoWatch 保留在触发条件里（未收窄成「只看 roots/manualRepos」）：这个开关若经由整份
  // PUT /api/config 变化却不落实，会出现「配置说开着、实际监听没启动」——界面上关不掉、
  // 也开不了监听，正是本任务最该防的「装作还在监听」，比少一次重装的代价大得多
  it("autoWatch 变了也要重装，即便是走整份 PUT /api/config 而不是专属 /api/watch", async () => {
    const file = configFile({ autoWatch: true })
    const { automation, closes } = make(file, [repo("a")])
    const prev = loadConfig(file)
    await automation.applyConfig({ ...prev, autoWatch: false }, prev)
    expect(closes()).toBe(1)
  })
})

describe("start / stop", () => {
  it("stop 之后定时器不再触发", async () => {
    vi.useFakeTimers()
    const file = configFile({ autoScanMinutes: 1, autoFetchMinutes: 1 })
    let scans = 0
    let fetches = 0
    const { automation } = make(file, [], { rescan: async () => void scans++, fetchAll: async () => void fetches++ })
    automation.start(loadConfig(file))
    vi.advanceTimersByTime(60_000)
    expect([scans, fetches]).toEqual([1, 1])
    automation.stop()
    vi.advanceTimersByTime(5 * 60_000)
    expect([scans, fetches]).toEqual([1, 1])
  })

  it("兜底重扫抛错只记日志，不让未处理的 rejection 打崩进程", async () => {
    vi.useFakeTimers()
    const file = configFile({ autoScanMinutes: 1 })
    const { automation, logs } = make(file, [], { rescan: async () => Promise.reject(new Error("scan boom")) })
    automation.start(loadConfig(file))
    vi.advanceTimersByTime(60_000)
    await vi.waitFor(() => expect(logs.join()).toContain("scan boom"))
  })
})

// 本任务的主线：重扫不再无条件重建监听句柄。上一个任务交接过来的约束 A 明确要求普通重扫
// 与结构变化/溢出触发的重扫走两条不同的收尾路径——这里只钉 automation 这一层「两个方法各干
// 各的事」；「backend.ts 到底在哪种重扫上调哪个方法」是 backend.test.ts 的事
describe("重扫不重建监听", () => {
  it("applyRepos 只更新映射表，不调用 setRoots", async () => {
    let setRootsCalls = 0
    let setReposCalls = 0
    const watcher = {
      setRoots: async () => {
        setRootsCalls++
      },
      setRepos: () => {
        setReposCalls++
      },
      close: async () => {},
      coveredRepoCount: () => 2,
      isCovered: () => true,
      watchedRoots: () => ["/root"],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/root"] }),
      watcher,
      listRepos: () => [],
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })

    await auto.applyWatch(true, [])
    expect(setRootsCalls).toBe(1)

    auto.applyRepos([])
    auto.applyRepos([])
    expect(setRootsCalls).toBe(1) // 重扫了两轮，监听一次都没重建
    expect(setReposCalls).toBe(2)
  })

  // applyRepos 同样要把归档仓库带标记交出去：只在 applyWatch 那条路上做的话，两次 applyWatch
  // 之间新归档的仓库会从映射表里消失，它的每一次保存都会被当成目录结构变化去触发全量重扫
  it("applyRepos 把归档仓库带标记交给 watcher，不是把它从映射表里删掉", () => {
    const lists: WatchedRepo[][] = []
    const watcher = {
      setRoots: async () => {},
      setRepos: (list: WatchedRepo[]) => void lists.push(list),
      close: async () => {},
      coveredRepoCount: () => 1,
      isCovered: () => true,
      watchedRoots: () => ["/r"],
    } as unknown as RepoWatcher
    const auto = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/r"] }),
      watcher,
      listRepos: () => [],
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })
    auto.applyRepos([repo("live"), repo("gone", { archived: true })])
    expect(lists[0]).toEqual([
      { id: "live", path: "/r/live", archived: false },
      { id: "gone", path: "/r/gone", archived: true },
    ])
    expect(auto.coverage()).toEqual({ watched: 1, total: 1 }) // 归档的不进分母
  })

  it("coverage 取自 watcher 的真实覆盖数，root 挂不上时如实变低", async () => {
    const watcher = {
      setRoots: async () => {},
      setRepos: () => {},
      close: async () => {},
      coveredRepoCount: () => 20, // 73 个仓库里只有 20 个被覆盖
      isCovered: () => false,
      watchedRoots: () => [],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/a", "/b"] }),
      watcher,
      listRepos: () => Array.from({ length: 73 }, (_, i) => ({ id: String(i), archived: false }) as RepoStatus),
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })
    await auto.applyWatch(true)
    expect(auto.coverage()).toEqual({ watched: 20, total: 73 })
  })
})

/**
 * G1：`setRepos` 只改映射表、从不触达策略，于是「上一次 applyWatch 之后才出现的仓库」原本
 * **没有任何代码路径**会给它建立句柄——用户 git clone 进扫描根，30 分钟后周期重扫发现它、
 * 卡片出现，但这个进程余生它都没有监听：提交、切分支要等最长 30 分钟才显示，而其它卡片
 * 1 秒内更新；`autoScanMinutes = 0` 时永远不更新。
 *
 * 补挂的判据是「覆盖数够不够」，而不是「有没有新仓库」——它恰好只在策略真的需要时才重建：
 * 递归策略下新仓库已在 root 句柄之下、计入覆盖，不触发；逐仓库策略下新仓库不在 okRoots 里，
 * 触发。这一对正反面是同等重要的两条：修 G1 最容易的错误做法就是退回「每轮都重建」，
 * 那等于把整轮重构的性能收益（每 30 分钟 2311 个句柄的拆建）原样还回去
 */
describe("新出现的仓库必须拿到监听句柄（G1）", () => {
  const auto = (file: string, cw: ReturnType<typeof coverageWatcher>, repos: RepoStatus[]) =>
    createAutomation({
      configFile: file,
      watcher: cw.watcher,
      listRepos: () => repos,
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })

  it("递归策略：普通重扫（哪怕多出了新仓库）一次句柄都不重建——本轮重构的性能收益全在这里", async () => {
    const cw = coverageWatcher("recursive")
    const a = auto(configFile({ autoWatch: true, roots: ["/r"] }), cw, [repo("a"), repo("b")])
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)

    a.applyRepos([repo("a"), repo("b")]) // 什么都没变的那 99% 轮次
    a.applyRepos([repo("a"), repo("b"), repo("c")]) // 新克隆的仓库，已落在 root 的递归句柄之下
    await new Promise((r) => setTimeout(r, 50)) // 给可能存在的（不该有的）重挂时间冒出来
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 3, total: 3 }) // 新仓库确实已被覆盖，不是漏算
  })

  it("逐仓库策略：重扫发现的新仓库一个句柄都没有 → 必须补一次重挂", async () => {
    const cw = coverageWatcher("per-repo")
    const a = auto(configFile({ autoWatch: true, roots: ["/r"] }), cw, [repo("a"), repo("b")])
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 2, total: 2 })

    a.applyRepos([repo("a"), repo("b"), repo("c")]) // chokidar 的目标列表是 start 时一次性建好的，
    await vi.waitFor(() => expect(cw.calls()).toBe(2)) // 此后没有任何东西会调 add()——只能整体重挂
    expect(cw.rootCalls.at(-1)?.map((r) => r.id)).toEqual(["a", "b", "c"])
    expect(a.coverage()).toEqual({ watched: 3, total: 3 })
  })

  // watchDegraded 救不了这一条：它只在 applyWatch 内部按 chosen 重算，而 root 挂不上的那一刻
  // 其下还没有发现任何仓库（网络盘离线时 scan 也扫不到），chosen 与 covered 同为 0 → 不算降级
  it("离线的 root 回来之后，其下的仓库必须被重新挂上（那一刻 watchDegraded 恰好是 false）", async () => {
    const cw = coverageWatcher("recursive", { failFirst: true })
    const a = auto(configFile({ autoWatch: true, roots: ["/r"] }), cw, [])
    await a.applyWatch(true) // 网络盘离线：root 没建成，且此刻其下一个仓库都没有
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 0, total: 0 })

    a.applyRepos([]) // 盘还没回来的那些轮次：没有降级标志，也没有仓库，不该白白重挂
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(1)

    a.applyRepos([repo("a"), repo("b")]) // 盘回来了，重扫列出了那个 root 下的仓库
    await vi.waitFor(() => expect(cw.calls()).toBe(2))
    expect(a.coverage()).toEqual({ watched: 2, total: 2 }) // 不重挂的话它们到重启为止都没有监听
  })

  // 分母必须是「本该建成的那些」（截断之后），不是仓库总数。拿总数当分母的话，Linux 上任何
  // 设了 watchLimit 的用户都会每轮重扫重挂一次——把本轮重构省下的开销原样还回去
  it("逐仓库策略 + watchLimit 截断：覆盖数天然低于仓库总数，但不得因此每轮重挂", async () => {
    const cw = coverageWatcher("per-repo")
    const repos = [repo("a"), repo("b"), repo("c")]
    const a = auto(configFile({ autoWatch: true, roots: ["/r"], watchLimit: 2 }), cw, repos)
    await withPlatform("linux", () => a.applyWatch(true))
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 2, total: 3 }) // 截断是预期内的短缺，不是降级

    await withPlatform("linux", async () => {
      a.applyRepos(repos)
      a.applyRepos(repos)
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(cw.calls()).toBe(1)
  })
})

/**
 * E1：applyRepos 的两道闸原先只比**数量**（`coveredRepoCount() >= …`），于是在名额已被
 * watchLimit 占满时 100% 失效——而「名额不够时收藏优先」这条排序**只在名额被截断时才有意义**。
 * Linux + 201 个仓库 + 上限 200：用户按面板与 config.ts 的承诺给某个不刷新的仓库打 ⭐，
 * pickWatched 的名单换了人、长度仍是 200，`200 >= 200` 成立 → 直接 return；而 applyWatch 是
 * **唯一**会重算 pickWatched 的入口，那个仓库在这个进程余生一个监听目标都不会有，界面还零反馈
 *（coverage 打 ⭐ 前后都是同一个数）。判据必须是「该覆盖的这批路径是不是都真的被覆盖了」。
 *
 * 断言必须落在**监听目标名单的内容**上：只断言「applyWatch 被调用了」正是上一轮那条假收益的
 * 同款错误——调用次数在这个场景里根本不变，那种断言在修好之前之后都是绿的
 */
describe("名额占满时打 ⭐ 必须真的换进监听名单（E1）", () => {
  it("逐仓库策略 + 名额已满：被 ⭐ 的仓库进了监听目标名单", async () => {
    const cw = coverageWatcher("per-repo")
    const outside = { favorite: true, date: "2026-05-01T00:00:00Z" }
    let repos = [
      repo("a", { date: "2026-07-01T00:00:00Z" }),
      repo("b", { date: "2026-06-01T00:00:00Z" }),
      repo("c", { date: "2026-05-01T00:00:00Z" }), // 名额之外的那个：不刷新，用户于是给它打 ⭐
    ]
    const a = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/r"], watchLimit: 2 }),
      watcher: cw.watcher,
      listRepos: () => repos,
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })
    await withPlatform("linux", () => a.applyWatch(true))
    expect(cw.rootCalls.at(-1)?.map((r) => r.id)).toEqual(["a", "b"])
    expect(a.coverage()).toEqual({ watched: 2, total: 3 })

    repos = [repos[0], repos[1], repo("c", outside)] // ⭐ 落盘后的下一次 syncRepos / 重扫
    await withPlatform("linux", async () => {
      a.applyRepos(repos)
      await vi.waitFor(() => expect(cw.rootCalls.at(-1)?.map((r) => r.id)).toEqual(["c", "a"]))
    })
    expect(a.coverage()).toEqual({ watched: 2, total: 3 }) // 名额仍是 2，但坐在里面的换成了 c 和 a
  })
})

/**
 * E2：存在「路径还在、但就是挂不上」的目标时（inotify ENOSPC——73+ 仓库时是真实场景；
 * root/仓库 EACCES；网络盘鉴权失败——pathGone 刻意只认 ENOENT，所以它们**留在**分母里），
 * watchDegraded 永久为真，两道闸全部短路。而 applyRepos 自从接上 PATCH meta 的 syncRepos
 * 之后是个**高频**入口：不挡的话，用户每点一次 ⭐ / 排除都要 strategy.stop() 后整体重建——
 * Linux 上那是把唯一那个 chokidar 实例关掉再建，还要 await waitForReady（最长 10 秒），
 * 那段窗口里所有仓库都收不到任何文件事件，且不补票
 */
describe("降级被闩住时不得跟着用户点击反复拆建监听（E2）", () => {
  /** 「路径还在、但就是挂不上」的目标：pathGone 只认 ENOENT，它留在分母里 → 永久降级 */
  function stuckWatcher(unmountable: string[]) {
    let mapped: WatchedRepo[] = []
    let attempts = 0
    const w = {
      setRoots: async (_roots: string[], list: WatchedRepo[]) => {
        attempts++
        mapped = list
      },
      setRepos: (list: WatchedRepo[]) => void (mapped = list),
      close: async () => {},
      coveredRepoCount: () => mapped.filter((r) => !r.archived && !unmountable.includes(r.path)).length,
      isCovered: (p: string) => !unmountable.includes(p),
      watchedRoots: () => ["/r"],
    }
    return { watcher: w as unknown as RepoWatcher, calls: () => attempts }
  }

  it("同一份挂不上的名单连点三次，setRoots 只涨一次；名单真变了才再补一次", async () => {
    const cw = stuckWatcher(["/r/b"])
    const repos = [repo("a"), repo("b")]
    const a = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/r"] }),
      watcher: cw.watcher,
      listRepos: () => repos,
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive, // /r/b 的路径**还在**，只是挂不上——这才是永久降级的形状
      log: () => {},
    })
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)

    a.applyRepos(repos) // 用户连点三次 ⭐ / 排除（PATCH meta → syncRepos → applyRepos）
    a.applyRepos(repos)
    a.applyRepos(repos)
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(2) // 自愈只补一次；同一份名单再挂一遍只会得到同样的失败

    // 反向：这道闸不能把真正的自愈一起关掉。名单真的变了（新克隆的仓库）就该照旧补挂
    a.applyRepos([...repos, repo("c")])
    await vi.waitFor(() => expect(cw.calls()).toBe(3))
  })
})

/**
 * G2：上面那道闸原先是**永久**的（只记名单、不记时刻），于是用户把底层问题修好之后点「重扫」
 * 永远没有任何效果——`POST /api/scan` 是 force=false，收尾走 applyRepos，名单一个字没变 →
 * 直接 return。而挂不上的原因**会消失**：inotify 名额被别的程序吃光（ENOSPC，73+ 仓库时是
 * 真实场景）之后用户把那个程序关掉 / 调大 `fs.inotify.max_user_watches`，EMFILE 更是本来就会
 * 自己好。「重扫」恰恰是用户面对「监听没挂上」时的自然动作；闩死的话那批仓库到进程结束都不
 * 实时刷新，设置面板那行 warn「N 个中监听 M 个」也不恢复，只有重启应用、或去设置里把监听
 * 开关关掉再打开才好。冷却期的取值理由见 automation.ts 的 HEAL_RETRY_MS
 */
describe("底层问题修好之后，重扫必须能把监听救回来（G2）", () => {
  /** 「路径还在、但就是挂不上」的目标；heal() 模拟用户调大了 inotify 名额 / 关掉了占用的程序 */
  function healableWatcher(stuck: string) {
    let mapped: WatchedRepo[] = []
    let attempts = 0
    let broken = true
    const blocked = (p: string): boolean => broken && p === stuck
    const w = {
      setRoots: async (_roots: string[], list: WatchedRepo[]) => {
        attempts++
        mapped = list
      },
      setRepos: (list: WatchedRepo[]) => void (mapped = list),
      close: async () => {},
      coveredRepoCount: () => mapped.filter((r) => !r.archived && !blocked(r.path)).length,
      isCovered: (p: string) => !blocked(p),
      watchedRoots: () => ["/r"],
    }
    return { watcher: w as unknown as RepoWatcher, calls: () => attempts, heal: () => void (broken = false) }
  }

  it("完整序列：故障期间挂不上 → 故障消失 → 冷却期内重扫不重试 → 冷却期过后重扫救回覆盖", async () => {
    // 只假造时钟：冷却判据读的是 Date.now()，而用例本身仍要用真实的 setTimeout 等重挂跑完
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-07-28T10:00:00Z"))
    const cw = healableWatcher("/r/b")
    const repos = [repo("a"), repo("b")]
    const a = createAutomation({
      configFile: configFile({ autoWatch: true, roots: ["/r"] }),
      watcher: cw.watcher,
      listRepos: () => repos,
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive, // /r/b 的路径**还在**，只是挂不上——这才是永久降级的形状
      log: () => {},
    })

    await a.applyWatch(true) // inotify 名额被吃光：/r/b 一个目标都建不成
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 1, total: 2 })

    a.applyRepos(repos) // 自愈补挂一次，仍然失败——这份名单连同时刻被记下
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(2)
    expect(a.coverage()).toEqual({ watched: 1, total: 2 })

    cw.heal() // 用户关掉占用 inotify 的程序 / 调大 max_user_watches：故障消失了

    vi.setSystemTime(new Date("2026-07-28T10:00:30Z")) // 半分钟后点「重扫」
    a.applyRepos(repos)
    a.applyRepos(repos)
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(2) // 冷却期内：连点也不拆建，E2 的收益一分不能丢

    vi.setSystemTime(new Date("2026-07-28T10:01:30Z")) // 冷却期过了，用户再点一次「重扫」
    a.applyRepos(repos)
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(3) // 永久闩住的话这里到进程结束都是 2
    expect(a.coverage()).toEqual({ watched: 2, total: 2 }) // 覆盖恢复，那行 warn 才消得掉
  })
})

// 评审 I2：applyWatchLogged / PUT /api/config 把监听器的失败咽掉时，原先靠的是「下一轮扫描的
// applyWatch 会重试」——本任务把周期路径收窄成 applyRepos 之后，那句承诺不再自动成立。
// 「有目标没建成」（RecursiveRootStrategy 对单个 root 的失败是内部吞掉的，不向上抛异常，只是
// 不把它放进返回的 ok 列表）记进 watchDegraded，由 applyRepos 在下一轮周期/手动重扫时补一次
// 便宜的重挂——只有真的降级时才付这笔重建的代价，绝大多数重扫这个分支根本不会进
describe("watchDegraded 自愈：periodic 路径的便宜重挂（评审 I2）", () => {
  it("applyWatch 有目标没建成时标记降级，下一次 applyRepos 会补一次重挂", async () => {
    let setRootsCalls = 0
    let ok: string[] = []
    const watcher = {
      setRoots: async (_roots: string[], list: { id: string; path: string }[]) => {
        setRootsCalls++
        // 第一次只建成 1 个，比请求的 2 个少——EMFILE 一类瞬时故障的典型样子；重挂那次全部建成
        ok = (setRootsCalls >= 2 ? list : list.slice(0, 1)).map((r) => r.path)
      },
      setRepos: () => {},
      close: async () => {},
      coveredRepoCount: () => ok.length,
      isCovered: (p: string) => ok.includes(p),
      watchedRoots: () => [...ok],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: configFile({ autoWatch: true }),
      watcher,
      listRepos: () => [repo("a"), repo("b")],
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })

    await auto.applyWatch(true)
    expect(setRootsCalls).toBe(1)
    expect(auto.coverage()).toEqual({ watched: 1, total: 2 }) // 如实反映：2 个里只建成 1 个

    auto.applyRepos([repo("a"), repo("b")]) // 普通重扫：不直接重挂，但检测到降级后应该补一次
    await vi.waitFor(() => expect(setRootsCalls).toBe(2))
    expect(auto.coverage()).toEqual({ watched: 2, total: 2 }) // 补救成功，覆盖数恢复
  })

  it("完全建成时不触发重挂——绝大多数周期重扫应该走这条轻量路径", async () => {
    let setRootsCalls = 0
    const watcher = {
      setRoots: async (_roots: string[], list: { id: string; path: string }[]) => {
        setRootsCalls++
      },
      setRepos: () => {},
      close: async () => {},
      coveredRepoCount: () => 2, // 与请求的名单长度一致——完全建成
      isCovered: () => true,
      watchedRoots: () => [],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: configFile({ autoWatch: true }),
      watcher,
      listRepos: () => [repo("a"), repo("b")],
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })

    await auto.applyWatch(true)
    expect(setRootsCalls).toBe(1)
    auto.applyRepos([repo("a"), repo("b")])
    await new Promise((r) => setTimeout(r, 50)) // 给可能存在的（不该有的）重挂一点时间冒出来
    expect(setRootsCalls).toBe(1) // 没有多余的重挂
  })

  it("降级仍在但用户这期间已经手动关闭监听：不会擅自把监听重新打开", async () => {
    let setRootsCalls = 0
    let closes = 0
    const watcher = {
      setRoots: async (_roots: string[], list: { id: string; path: string }[]) => {
        setRootsCalls++
      },
      setRepos: () => {},
      close: async () => {
        closes++
      },
      coveredRepoCount: () => 1, // 只建成 1 个，制造降级
      isCovered: (p: string) => p === "/r/a",
      watchedRoots: () => [],
    } as unknown as RepoWatcher

    const file = configFile({ autoWatch: true })
    const auto = createAutomation({
      configFile: file,
      watcher,
      listRepos: () => [repo("a"), repo("b")],
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: allPathsAlive,
      log: () => {},
    })

    await auto.applyWatch(true) // 降级：covered(1) < chosen.length(2)
    expect(setRootsCalls).toBe(1)

    saveConfig(file, { ...loadConfig(file), autoWatch: false }) // 用户在这期间关掉了监听
    auto.applyRepos([repo("a"), repo("b")])
    await new Promise((r) => setTimeout(r, 50)) // 给可能存在的（不该有的）重挂一点时间冒出来
    expect(setRootsCalls).toBe(1) // 没有因为残留的降级标志被擅自重新打开
    expect(closes).toBe(0)
  })
})

/**
 * A1：`excludes` 只能经由 `setRoots` 进 watcher（那是它唯一的入口）。不交出去的话，被排除的
 * 仓库不进 `scan()`、因而永远不在归属表里，它的每一次写入都走「未归属 → 结构变化」分支——
 * 一个**永不关闭的水龙头**：按 60 秒冷却无限触发 force=true 的全量重扫 + 完整 applyWatch 拆建
 */
describe("excludes 要交到 watcher 手上（A1）", () => {
  it("applyWatch 把 cfg.excludes 一并交给 setRoots", async () => {
    const file = configFile({ roots: ["/r"], excludes: ["node_modules", "archive"] })
    const { automation, excludesCalls } = make(file, [repo("a")])
    await automation.applyWatch(true)
    expect(excludesCalls.at(-1)).toEqual(["node_modules", "archive"])
  })

  // excludes 只在 applyConfig 这条路上能进 watcher。不跟着重装的话，改完 excludes 得到的是
  // 两种静默错误之一：新加的排除项不生效（水龙头继续开着），或删掉的排除项不生效
  //（那棵子树里新出现的仓库要等最长 30 分钟的兜底重扫，autoScanMinutes = 0 时永不出现）
  it("excludes 变了要重挂监听（整份 PUT /api/config 回来时）", async () => {
    const file = configFile({ excludes: ["node_modules"], autoWatch: true })
    const { automation, excludesCalls } = make(file, [repo("a")])
    const prev = loadConfig(file)
    const next = { ...prev, excludes: ["node_modules", "archive"] }
    saveConfig(file, next) // 模拟 PUT /api/config 已落盘
    await automation.applyConfig(next, prev)
    expect(excludesCalls).toHaveLength(1)
    expect(excludesCalls[0]).toEqual(["node_modules", "archive"]) // 而且是**新**值，不是旧的
  })

  it("excludes 没变就不重挂（与其它字段同一条「只重装真变了的」规则）", async () => {
    const file = configFile({ excludes: ["node_modules"] })
    const { automation, excludesCalls } = make(file, [repo("a")])
    const prev = loadConfig(file)
    await automation.applyConfig({ ...prev, notes: { x: "hi" } }, prev)
    expect(excludesCalls).toHaveLength(0)
  })
})

/**
 * A2：路径失效的仓库会一直留在仓库列表里（Task 9 有意为之：不能让卡片静默消失，要产出一张
 * 「路径已失效」的错误卡片），而任何策略都挂不上一个不存在的路径。把它留在覆盖率的**分母**
 * 里的后果是 `watchDegraded` 与 applyRepos 的补挂条件被**永久闩住**：每一轮重扫都触发一次
 * 注定失败的 applyWatch（拆了重建全部句柄）——正是本轮重构要消灭的开销，只是换了个理由回来。
 */
describe("已知路径失效的仓库不进覆盖率分母（A2）", () => {
  /** 路径失效的仓库任何策略都挂不上：逐仓库策略下 chokidar 前的 existsSync 预过滤把它剔掉，
   *  递归策略下 roots 之外的 manualRepo 各挂一个句柄、realpath ENOENT 时不进 ok 列表 */
  function watcherMissing(unmountable: string[]) {
    let mapped: WatchedRepo[] = []
    let started = false
    let attempts = 0
    const w = {
      setRoots: async (_roots: string[], list: WatchedRepo[]) => {
        attempts++
        mapped = list
        started = true
      },
      setRepos: (list: WatchedRepo[]) => void (mapped = list),
      close: async () => void (started = false),
      coveredRepoCount: () =>
        started ? mapped.filter((r) => !r.archived && !unmountable.includes(r.path)).length : 0,
      isCovered: (p: string) => started && !unmountable.includes(p),
      watchedRoots: () => ["/r"],
    }
    return { watcher: w as unknown as RepoWatcher, calls: () => attempts }
  }

  const auto = (file: string, cw: ReturnType<typeof watcherMissing>, repos: RepoStatus[], gone: (p: string) => boolean) =>
    createAutomation({
      configFile: file,
      watcher: cw.watcher,
      listRepos: () => repos,
      rescan: async () => [],
      fetchAll: async () => {},
      pathGone: gone,
      log: () => {},
    })

  it("一个死掉的 manualRepo 不再把降级判定闩住：普通重扫一次 setRoots 都不调", async () => {
    const repos = [repo("a"), repo("b"), repo("dead")]
    const cw = watcherMissing(["/r/dead"])
    const a = auto(configFile({ autoWatch: true, roots: ["/r"] }), cw, repos, (p) => p === "/r/dead")
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 2, total: 3 }) // total 仍如实含那张错误卡片

    a.applyRepos(repos)
    a.applyRepos(repos)
    a.applyRepos(repos)
    await new Promise((r) => setTimeout(r, 50)) // 给可能存在的（不该有的）重挂时间冒出来
    expect(cw.calls()).toBe(1)
  })

  // 反向：别把自愈一起关掉。「挂不上」与「路径没了」是两回事——EACCES/网络盘鉴权失败时
  // 路径**还在**，那就是真降级，必须照旧补挂，否则这批仓库到进程结束都拿不到监听句柄
  it("路径还在却没挂上（EACCES 一类）仍算降级，照旧补一次重挂", async () => {
    const repos = [repo("a"), repo("b")]
    const cw = watcherMissing(["/r/b"])
    const a = auto(configFile({ autoWatch: true, roots: ["/r"] }), cw, repos, allPathsAlive)
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)
    a.applyRepos(repos)
    await vi.waitFor(() => expect(cw.calls()).toBe(2))
  })

  // 真实判定的接线：不注入 pathGone，用真实临时目录。上面那批用例全都注入了替身，
  // 把 automation.ts 里的默认值悄悄改掉（比如换成 existsSync，那会把 EACCES 也判成没了）
  // 它们一条都不会变红
  it("默认判定接的是真实文件系统：真目录不算失效，不存在的路径算", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-live-"))
    dirs.push(dir)
    const alive = { ...repo("alive"), path: dir } as RepoStatus
    const dead = { ...repo("dead"), path: join(dir, "no-such-repo") } as RepoStatus
    const cw = watcherMissing([dead.path])
    const a = createAutomation({
      configFile: configFile({ autoWatch: true, roots: [dir] }),
      watcher: cw.watcher,
      listRepos: () => [alive, dead],
      rescan: async () => [],
      fetchAll: async () => {},
      log: () => {},
    })
    await a.applyWatch(true)
    expect(cw.calls()).toBe(1)
    expect(a.coverage()).toEqual({ watched: 1, total: 2 })

    a.applyRepos([alive, dead])
    a.applyRepos([alive, dead])
    await new Promise((r) => setTimeout(r, 50))
    expect(cw.calls()).toBe(1) // 死路径不再每轮触发一次注定失败的重挂
  })
})

/**
 * 只有 ENOENT 算「没了」。判反的代价是不对称的：把一个还在磁盘上的仓库判成「没了」，
 * 它就被排除出分母，于是**真正的降级从此测不出来**（一个网络盘抖动的仓库会让「本该监听却
 * 没监听」永远显示为正常）；判成「还在」最多是多跑一次注定失败的重挂，下一轮自己会好
 */
describe("pathGone — 只有 ENOENT 算没了", () => {
  it("存在的目录为假，不存在的路径为真", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-gone-"))
    dirs.push(dir)
    expect(pathGone(dir)).toBe(false)
    expect(pathGone(join(dir, "no-such-thing"))).toBe(true)
  })

  // EACCES / EPERM / 网络盘鉴权失败没法在两条 CI 腿上都稳定造出来，用「statSync 会抛的
  // 另一种错误」代替：钉住的是 catch 分支的取舍——**抛出来的错误一律按「还在」处理**，
  // 而不是被 catch 顺手当成「没了」
  it("stat 抛出非 ENOENT 的错误时按「还在」处理", () => {
    expect(pathGone("bad\u0000path")).toBe(false)
  })
})
