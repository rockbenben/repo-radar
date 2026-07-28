import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { PerRepoStrategy, RecursiveRootStrategy, defaultStrategy } from "../src/watch-strategy"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-root-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  // maxRetries：目录刚被监听过，Windows 上句柄释放晚于 close() 返回，头一次 rm 常撞 EBUSY
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")) }
    }, 50)
  })
}

const noopHandlers = (events: string[]) => ({
  onEvent: (p: string) => events.push(p),
  onOverflow: () => {},
  onError: () => {},
})

/** 临时改写 process.platform 探测平台分叉；finally 还原，不污染其它用例 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...desc, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, "platform", desc)
  }
}

// 两个策略在任何平台上都能构造、都能真跑（Node 从 20.13 起三个平台都支持
// recursive: true）。不按平台 skip 是有意的：CI 只跑 ubuntu + windows，一旦按
// process.platform 门禁，递归策略这条腿在 Linux 上永远没人验证过
describe("RecursiveRootStrategy", () => {
  it("监听 root，收到 root 底下深层文件的事件（绝对路径）", async () => {
    const root = tmpRoot()
    mkdirSync(join(root, "a", "b"), { recursive: true })
    const events: string[] = []
    const s = new RecursiveRootStrategy()
    const ok = await s.start([root], [], noopHandlers(events))
    expect(ok).toEqual([root])
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(root, "a", "b", "deep.txt"), "x")
    await waitFor(() => events.some((p) => p.endsWith("deep.txt")))
    // 路径形式必须与调用方给的 root 一致：tmpdir() 在本机和 CI 上常是 8.3 短名
    // （C:\Users\RUNNER~1\...），macOS 上 /var 是指向 /private/var 的软链，而监听本身
    // 必须挂在 realpath 上（libuv 的 8.3 断言会整个进程 abort）。若事件报 realpath 形式，
    // 归属表（scanner 用配置里的 root 拼出来的路径）一条都对不上——所有仓库静默停止刷新
    expect(events.every((p) => p.startsWith(root))).toBe(true)
    await s.stop()
  })

  it("root 不存在 → 不在返回的成功列表里，且不抛", async () => {
    const s = new RecursiveRootStrategy()
    const ok = await s.start([join(tmpRoot(), "no-such-dir")], [], noopHandlers([]))
    expect(ok).toEqual([])
    await s.stop()
  })

  it("stop 之后不再有事件", async () => {
    const root = tmpRoot()
    const events: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 200))
    await s.stop()
    writeFileSync(join(root, "after.txt"), "x")
    await new Promise((r) => setTimeout(r, 400))
    expect(events).toEqual([])
  })

  // watcherErrorIsNoise 靠「出事的路径是不是监听目标本身」决定能不能咽掉这条错误。
  // realpath 失败时错误带的是原始路径，监听建立之后内核报的是 realpath——只给一种形式的话，
  // 「整个 root 从此不再有事件」会被当成单文件噪音咽掉：那棵树下的仓库全部静默停止刷新，
  // 而打包后日志是唯一诊断面
  it("错误分级用的目标列表同时含原始形式与 realpath 形式", async () => {
    const root = tmpRoot()
    const missing = join(root, "no-such-dir")
    let seen: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root, missing], [], {
      onEvent: () => {},
      onOverflow: () => {},
      onError: (_err, targets) => void (seen = [...targets]),
    })
    expect(seen).toContain(root)
    expect(seen).toContain(realpathSync.native(root))
    expect(seen).toContain(missing)
    await s.stop()
  })

  // roots 之外的 manualRepos 各挂一个；已经在某个 root 之下的不再重复挂
  it("已被 root 覆盖的仓库不重复挂，root 之外的仓库单独挂", async () => {
    const root = tmpRoot()
    const inside = join(root, "inside")
    mkdirSync(inside)
    const outside = tmpRoot()
    const s = new RecursiveRootStrategy()
    const ok = await s.start([root], [{ id: "IN", path: inside }, { id: "OUT", path: outside }], noopHandlers([]))
    expect(ok).toEqual([root, outside])
    await s.stop()
  })
})

describe("PerRepoStrategy", () => {
  it("监听仓库，收到工作区改动事件", async () => {
    const repo = makeRepo()
    const events: string[] = []
    const s = new PerRepoStrategy()
    await s.start([], [{ id: "R", path: repo }], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "w.txt"), "x")
    await waitFor(() => events.length > 0)
    // 与递归策略同一条约束：内部按 realpath 监听（8.3 断言崩溃），对外报调用方的路径形式
    expect(events.every((p) => p.startsWith(repo))).toBe(true)
    await s.stop()
  })

  it("start 返回调用方给的仓库路径形式（coverage 要按同一坐标系比对）", async () => {
    const repo = makeRepo()
    const s = new PerRepoStrategy()
    const ok = await s.start([], [{ id: "R", path: repo }], noopHandlers([]))
    expect(ok).toEqual([repo])
    await s.stop()
  })

  it("stop 之后不再有事件", async () => {
    const repo = makeRepo()
    const events: string[] = []
    const s = new PerRepoStrategy()
    await s.start([], [{ id: "R", path: repo }], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 300))
    await s.stop()
    writeFileSync(join(repo, "after.txt"), "x")
    await new Promise((r) => setTimeout(r, 600))
    expect(events).toEqual([])
  })
})

describe("defaultStrategy", () => {
  it("win32/darwin 用递归策略，其余用逐仓库策略", () => {
    const s = defaultStrategy()
    const expectRecursive = process.platform === "win32" || process.platform === "darwin"
    expect(s instanceof RecursiveRootStrategy).toBe(expectRecursive)
  })

  // 三条分支在任何一个平台上都要成立，否则 CI 上永远只有一条腿被覆盖。
  // Linux 不走递归是有原因的：Node 在 Linux 上的 recursive: true 是用户态实现——自己递归
  // 遍历并给每个目录加 inotify watch，且不认 ignore 列表，于是每个 node_modules 都会被挂上，
  // 比逐仓库更糟且可能撞 fs.inotify.max_user_watches；而 Linux 上目录本来就不会被句柄锁住
  it("平台分叉三条分支都成立（不依赖当前跑在哪个平台）", () => {
    withPlatform("win32", () => expect(defaultStrategy()).toBeInstanceOf(RecursiveRootStrategy))
    withPlatform("darwin", () => expect(defaultStrategy()).toBeInstanceOf(RecursiveRootStrategy))
    withPlatform("linux", () => expect(defaultStrategy()).toBeInstanceOf(PerRepoStrategy))
  })
})
