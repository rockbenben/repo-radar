import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAutomation, intervalMs } from "../src/automation"
import { DEFAULT_CONFIG, loadConfig, MAX_INTERVAL_MINUTES, saveConfig, type Config } from "../src/config"
import type { RepoStatus } from "../src/types"
import type { RepoWatcher } from "../src/watcher"

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

const repo = (id: string, opts: { favorite?: boolean; date?: string; archived?: boolean } = {}): RepoStatus =>
  ({
    id,
    path: `/r/${id}`,
    name: id,
    favorite: opts.favorite ?? false,
    archived: opts.archived ?? false,
    lastCommit: opts.date ? { date: opts.date } : null,
  }) as unknown as RepoStatus

/** 记录 setRoots/close 调用的假 watcher */
function fakeWatcher() {
  const watched: string[][] = []
  let closes = 0
  const w = {
    setRoots: async (_roots: string[], list: { id: string; path: string }[]) => void watched.push(list.map((r) => r.id)),
    close: async () => void closes++,
  }
  return { watcher: w as unknown as RepoWatcher, watched, closes: () => closes }
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

  it("已归档的仓库不监听，也不计入总数", async () => {
    const file = configFile()
    const { automation, watched } = make(file, [repo("a"), repo("skip", { archived: true })])
    await automation.applyWatch(true)
    expect(watched[0]).toEqual(["a"])
    expect(automation.coverage()).toEqual({ watched: 1, total: 1 })
  })

  // 收藏是用户明确说过「这个重要」的信号。只按提交时间排的话，一个 CI 机器人的提交
  // 就能把用户天天开的仓库挤出监听名额
  it("名额不够时收藏优先于最近提交", async () => {
    const file = configFile({ watchLimit: 2 })
    const repos = [
      repo("bot", { date: "2026-07-27T10:00:00Z" }), // 最新，但没收藏
      repo("fav-old", { favorite: true, date: "2020-01-01T00:00:00Z" }),
      repo("fav-new", { favorite: true, date: "2026-01-01T00:00:00Z" }),
    ]
    const { automation, watched } = make(file, repos)
    await automation.applyWatch(true)
    expect(watched[0]).toEqual(["fav-new", "fav-old"]) // 两个收藏占满名额，且收藏内部仍按时间排
    expect(automation.coverage()).toEqual({ watched: 2, total: 3 })
  })

  // lastCommit.date 是带各自时区偏移的 ISO（git %aI）。字符串比较会按墙钟文本排错序：
  // "2026-07-27T10:00:00+08:00"（=02:00Z）的文本大于 "2026-07-27T03:00:00Z"，但其实更早
  it("按真实时间戳排序，不被时区偏移的墙钟文本骗过", async () => {
    const file = configFile({ watchLimit: 1 })
    const repos = [
      repo("wall-clock-later", { date: "2026-07-27T10:00:00+08:00" }), // 实际 02:00Z
      repo("actually-newer", { date: "2026-07-27T03:00:00Z" }),
    ]
    const { automation, watched } = make(file, repos)
    await automation.applyWatch(true)
    expect(watched[0]).toEqual(["actually-newer"])
  })

  it("watchLimit=0 表示无上限", async () => {
    const file = configFile({ watchLimit: 0 })
    const repos = Array.from({ length: 300 }, (_, i) => repo(`r${i}`))
    const { automation, watched } = make(file, repos)
    await automation.applyWatch(true)
    expect(watched[0]).toHaveLength(300)
    expect(automation.coverage()).toEqual({ watched: 300, total: 300 })
  })

  it("关闭监听时关掉 watcher，覆盖数归零", async () => {
    const file = configFile()
    const { automation, closes } = make(file, [repo("a")])
    await automation.applyWatch(true)
    await automation.applyWatch(false)
    expect(closes()).toBe(1)
    expect(automation.coverage()).toEqual({ watched: 0, total: 0 })
  })

  // 截断了却谎称「其余靠兜底重扫」，在兜底重扫被关掉时就是假话
  it("截断日志按兜底重扫是否开着说不同的话", async () => {
    const repos = [repo("a"), repo("b"), repo("c")]
    const on = make(configFile({ watchLimit: 1, autoScanMinutes: 30 }), repos)
    await on.automation.applyWatch(true)
    expect(on.logs.join()).toContain("30")
    expect(on.logs.join()).not.toContain("NOT refresh")

    const off = make(configFile({ watchLimit: 1, autoScanMinutes: 0 }), repos)
    await off.automation.applyWatch(true)
    expect(off.logs.join()).toContain("NOT refresh")
  })

  it("未截断时不打日志", async () => {
    const { automation, logs } = make(configFile({ watchLimit: 10 }), [repo("a")])
    await automation.applyWatch(true)
    expect(logs).toEqual([])
  })
})

describe("setX 落盘并立即生效", () => {
  it("setWatchLimit 落盘并重挂监听（否则面板显示的覆盖数和真实监听对不上）", async () => {
    const file = configFile({ watchLimit: 0 })
    const { automation, watched } = make(file, [repo("a"), repo("b"), repo("c")])
    await automation.setWatchLimit(2)
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

  it("watchLimit 变了也要重挂监听", async () => {
    const file = configFile({ watchLimit: 0 })
    const { automation, watched } = make(file, [repo("a"), repo("b"), repo("c")])
    const prev = loadConfig(file)
    saveConfig(file, { ...prev, watchLimit: 1 }) // 模拟 PUT /api/config 已落盘
    await automation.applyConfig({ ...prev, watchLimit: 1 }, prev)
    expect(watched.at(-1)).toHaveLength(1)
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
