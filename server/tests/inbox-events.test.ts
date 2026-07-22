import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBackend, createInboxEmitter, inboxEqual, type Backend, type InboxChange } from "../src/backend"

// 这里只验证「事件缝的形状与订阅语义」——真正的 GitHub 拉取需要 gh 已登录，
// 在 CI 与本机都不可靠，因此变化的产生由 store/inboxCache 的既有测试覆盖
const PORT = 7471
let running: Backend[] = []
let dirs: string[] = []

function opts() {
  const dir = mkdtempSync(join(tmpdir(), "rr-inbox-evt-"))
  dirs.push(dir)
  return { configFile: join(dir, "config.json"), staticRoot: dir, version: "9.9.9", port: PORT }
}
afterEach(async () => {
  for (const b of running.splice(0)) await b.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("Backend.onInboxChanged", () => {
  it("可以在 start 之前订阅（主进程会在启动前就接好线）", () => {
    const b = createBackend(opts())
    running.push(b)
    expect(() => b.onInboxChanged(() => {})).not.toThrow()
  })

  it("支持多个订阅者，互不影响", () => {
    const b = createBackend(opts())
    running.push(b)
    const seen: string[] = []
    b.onInboxChanged(() => seen.push("a"))
    b.onInboxChanged(() => seen.push("b"))
    expect(seen).toEqual([]) // 没有补全轮次发生时不该有任何回调
  })
})

// 缺陷 7：上面 Backend.onInboxChanged 的测试只验证了「没发生任何拉取时」的形状——真正的投递
// （抛错隔离、空轮不发、多订阅者依次投递）没法靠它们触发，因为真正的 GitHub 拉取依赖 gh 已登录，
// 在 CI/本机都不可靠。原先这里还有第三条名为「某个订阅者抛错不影响其它订阅者」的测试，
// 但它只断言了 b.start() 会 resolve，从未真正触发过投递，已删除——改成直接对抽出来的
// 投递器 createInboxEmitter 写测试，不依赖任何网络/子进程，真正跑一遍三条保证。
const oneChange: InboxChange[] = [{ repoId: "r1", name: "repo-one", before: null, after: { prs: 1, issues: 0, ciFailed: false } }]

describe("createInboxEmitter", () => {
  it("emit 空数组不投递给任何订阅者", () => {
    const emitter = createInboxEmitter()
    const seen: InboxChange[][] = []
    emitter.subscribe((c) => seen.push(c))
    emitter.emit([])
    expect(seen).toEqual([])
  })

  it("多订阅者按注册顺序依次收到同一份 changes", () => {
    const emitter = createInboxEmitter()
    const order: string[] = []
    emitter.subscribe(() => order.push("a"))
    emitter.subscribe(() => order.push("b"))
    emitter.subscribe(() => order.push("c"))
    emitter.emit(oneChange)
    expect(order).toEqual(["a", "b", "c"])
  })

  it("某个订阅者抛错不影响排在它后面的订阅者，emit 本身也不抛出", () => {
    const emitter = createInboxEmitter()
    const seen: InboxChange[][] = []
    emitter.subscribe(() => {
      throw new Error("订阅者炸了")
    })
    emitter.subscribe((c) => seen.push(c))
    expect(() => emitter.emit(oneChange)).not.toThrow()
    expect(seen).toEqual([oneChange])
  })

  it("排在抛错订阅者之前的订阅者同样正常收到（抛错不影响任何顺位的其它订阅者）", () => {
    const emitter = createInboxEmitter()
    const seen: InboxChange[][] = []
    emitter.subscribe((c) => seen.push(c))
    emitter.subscribe(() => {
      throw new Error("订阅者炸了")
    })
    emitter.emit(oneChange)
    expect(seen).toEqual([oneChange])
  })

  it("clear() 之后不再有任何订阅者收到 emit", () => {
    const emitter = createInboxEmitter()
    const seen: InboxChange[][] = []
    emitter.subscribe((c) => seen.push(c))
    emitter.clear()
    emitter.emit(oneChange)
    expect(seen).toEqual([])
  })
})

// Minor 7：InboxChange 这个名字承诺的是「变化」，不该把「拉到了但和上次一模一样」也塞进去
describe("inboxEqual", () => {
  const base = { prs: 1, issues: 2, ciFailed: false, ciSha: "abc", byViewer: true }

  it("before 为 null（首次拿到缓存）永远不算一致", () => {
    expect(inboxEqual(null, base)).toBe(false)
  })

  it("字段全部相同 → 一致", () => {
    expect(inboxEqual({ ...base }, { ...base })).toBe(true)
  })

  it("任意一个字段不同 → 不一致", () => {
    expect(inboxEqual(base, { ...base, prs: 2 })).toBe(false)
    expect(inboxEqual(base, { ...base, issues: 3 })).toBe(false)
    expect(inboxEqual(base, { ...base, ciFailed: true })).toBe(false)
    expect(inboxEqual(base, { ...base, ciSha: "def" })).toBe(false)
    expect(inboxEqual(base, { ...base, byViewer: false })).toBe(false)
  })

  it("旧缓存缺 byViewer/ciSha（undefined）与本轮显式给出不算一致——口径/CI 记录点可能真的变了", () => {
    const legacy = { prs: 1, issues: 2, ciFailed: false }
    expect(inboxEqual(legacy, base)).toBe(false)
  })
})
