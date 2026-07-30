import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INBOX_REFRESH_MS } from "../src/backend"
import { InboxCache } from "../src/inbox-cache"
import type { GithubInbox } from "../src/types"

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "rr-inbox-"))
  return { file: join(dir, "github-inbox.json"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

const INBOX = { prs: 2, issues: 1, ci: "passing" } as unknown as GithubInbox
const inbox = (prs: number, over: Partial<GithubInbox> = {}): GithubInbox => ({ prs, issues: 0, ciFailed: false, byViewer: true, ...over })

// 落盘是 1 秒防抖的，退出路径必须能把它立刻挤出去，否则最后一轮拉取结果随进程一起丢
describe("InboxCache.flush — 退出前落盘", () => {
  it("set 之后立刻 flush，内容已经在磁盘上（不必等防抖窗口）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("repo1", "https://github.com/a/b", INBOX)
    expect(existsSync(file)).toBe(false) // 防抖中，还没写

    c.flush()
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).repo1.url).toBe("https://github.com/a/b")

    // 重新加载能读回来——这正是「重启秒显上次结果」依赖的东西
    expect(new InboxCache(file).get("repo1", "https://github.com/a/b")).toEqual(INBOX)
    cleanup()
  })

  it("累计新到达数一并落盘，重启后接着往上加（不从 0 重来）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("repo1", "u", inbox(1))
    c.set("repo1", "u", inbox(3)) // +2
    c.flush()

    const reloaded = new InboxCache(file)
    expect(reloaded.getWithArrivals("repo1", "u")?.prsAdded).toBe(2)
    reloaded.set("repo1", "u", inbox(4)) // +1
    expect(reloaded.getWithArrivals("repo1", "u")?.prsAdded).toBe(3)
    cleanup()
  })

  it("没有待写内容时 flush 不产生文件（退出路径不做无谓写盘）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.flush()
    expect(existsSync(file)).toBe(false)
    cleanup()
  })

  it("flush 之后重复 flush 不再写（防抖定时器已清）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("repo1", "u", INBOX)
    c.flush()
    const first = readFileSync(file, "utf8")
    rmSync(file)
    c.flush() // 没有新的 set，不该再写出文件
    expect(existsSync(file)).toBe(false)
    expect(first).toContain("repo1")
    cleanup()
  })

  it("路径不可写时 flush 不抛（缓存只是加速，绝不能挡住退出）", () => {
    const { file, cleanup } = tmpFile()
    // 把「父目录」的位置先占成一个普通文件，mkdirSync 必然失败——确定性地触发写盘失败路径
    const blocked = join(dirname(file), "blocked")
    writeFileSync(blocked, "x")
    const c = new InboxCache(join(blocked, "github-inbox.json"))
    c.set("repo1", "u", INBOX)
    expect(() => c.flush()).not.toThrow()
    cleanup()
  })
})

/**
 * 累计「新到达」数。前端队列的「已处理」水位存在 localStorage 里，只有渲染进程活着并且恰好
 * 观察到那次下探时才会被下调——而托盘常驻（--tray / 开机自启）恰恰是「没有渲染进程」的形态：
 * 4 个 PR 全被合掉（差值 ≤ 0 不弹通知，也没人下调水位）、随后来 2 个新的 → 通知照弹「PR +2」，
 * 用户点进来，前端按 2 ≤ 4 判定为已处理，「该你了」里没有这条，且清理 effect 紧接着把水位降到 2，
 * 2 ≤ 2 依然成立——再也不会出现。这里把「下探」挪到服务端记账，通知与队列读同一条数据链。
 */
describe("InboxCache 的累计新到达数（面板关着时也照记）", () => {
  it("完整序列：4 → 0（全被合掉）→ 2（来了新的），累计新到达 = 2", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u", inbox(4))
    expect(c.getWithArrivals("r1", "u")?.prsAdded).toBe(0) // 首轮不算新到（否则缓存重建那轮把积压整包当新增）

    c.set("r1", "u", inbox(0)) // 4 个全合掉：只减不加
    expect(c.getWithArrivals("r1", "u")?.prsAdded).toBe(0)

    c.set("r1", "u", inbox(2)) // 来了 2 个新的：总数 2 仍低于旧水位 4，但确实有新东西进来
    const seen = c.getWithArrivals("r1", "u")
    expect(seen?.prs).toBe(2)
    expect(seen?.prsAdded).toBe(2)
    cleanup()
  })

  it("只减不增（合掉 1 个）时累计不动——「没有新的」不该把已处理顶出来", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u", inbox(4))
    c.set("r1", "u", inbox(3))
    c.set("r1", "u", inbox(3)) // 原地不动的轮次同样不加
    expect(c.getWithArrivals("r1", "u")?.prsAdded).toBe(0)
    cleanup()
  })

  it("issue 单独记账，互不串台", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u", inbox(1, { issues: 5 }))
    c.set("r1", "u", inbox(1, { issues: 8 }))
    const seen = c.getWithArrivals("r1", "u")
    expect(seen?.issuesAdded).toBe(3)
    expect(seen?.prsAdded).toBe(0)
    cleanup()
  })

  it("byViewer 口径变了（本轮 viewer 查询失败）不算新到——与 notify.ts 同一条规矩", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u", inbox(2, { byViewer: true })) // 2 个（已减去自己开的）
    c.set("r1", "u", inbox(9, { byViewer: false })) // 口径变成「含自己在内」，这 7 个是虚的
    expect(c.getWithArrivals("r1", "u")?.prsAdded).toBe(0)
    // 口径恢复一致后照常记
    c.set("r1", "u", inbox(11, { byViewer: false }))
    expect(c.getWithArrivals("r1", "u")?.prsAdded).toBe(2)
    cleanup()
  })

  it("换了远程（origin url 变）累计清零——那已经是另一个仓库了", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u1", inbox(1))
    c.set("r1", "u1", inbox(4))
    expect(c.getWithArrivals("r1", "u1")?.prsAdded).toBe(3)
    c.set("r1", "u2", inbox(9))
    expect(c.getWithArrivals("r1", "u2")?.prsAdded).toBe(0)
    cleanup()
  })

  it("get() 不带累计量：通知那条链取的 before 必须是 GitHub 原样内容", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("r1", "u", inbox(1))
    c.set("r1", "u", inbox(3))
    expect(c.get("r1", "u")).toEqual(inbox(3)) // 一个多余字段都没有
    cleanup()
  })
})

// TTL 与 backend.ts 的 INBOX_REFRESH_MS 耦合：定时器在 T、T+12m… 触发，而一轮里每个仓库的
// fetchedAt 都落在 tick **之后** d 秒。两者相等时下一个 tick 的已过时间是 12m − d，
// `Date.now() - at > TTL_MS` 恒假 —— 整轮没有一个仓库被判过期、直接空转，真实刷新间隔变成 24 分钟。
//
// 必须用 setSystemTime 而不是 spyOn(Date, "now")：set() 里落的是 `new Date().toISOString()`，
// 构造器**不走** Date.now，spy 对它毫无作用——那样三个参数化用例其实都是 roundMs=0 的同一份拷贝，
// 把 TTL 改成 11m59s（余量只剩 1 秒、用例名字在现实中为假）也照样全绿。
// POLL_MS 直接 import 真常量，不在这里重抄：抄一份的话改轮询周期不会让任何测试变红。
describe("InboxCache.isStale — 必须赶在下一个轮询 tick 之前过期", () => {
  afterEach(() => vi.useRealTimers())
  for (const roundMs of [2_000, 10_000, 40_000]) {
    it(`一轮耗时 ${roundMs / 1000}s 时，下一个 tick 判为过期`, () => {
      const { file, cleanup } = tmpFile()
      const c = new InboxCache(file)
      const base = new Date("2026-07-29T00:00:00.000Z").getTime()
      vi.useFakeTimers()
      vi.setSystemTime(base + roundMs) // 这一轮在 tick 之后 roundMs 才拿到结果
      c.set("r1", "u", inbox(1))
      vi.setSystemTime(base + INBOX_REFRESH_MS) // 下一个 tick
      expect(c.isStale("r1", "u")).toBe(true)
      vi.useRealTimers()
      cleanup()
    })
  }
})
