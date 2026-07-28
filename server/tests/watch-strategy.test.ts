import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { watchTargetLost } from "../src/watch-filter"
import { PerRepoStrategy, RecursiveRootStrategy, defaultStrategy, usesPerRepoWatching } from "../src/watch-strategy"
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

  // 这条腿上**一个** FSWatcher 管着所有仓库，start 却无条件返回全部仓库，
  // 于是被删掉/网络盘掉线的仓库照样计进 coveredRepoCount——设置面板说「全部实时监听中」，
  // 而那些仓库其实一个事件都收不到。接口注释自己写着「coverage 要如实反映」
  it("不存在的仓库不算进覆盖（start 只返回真正挂上的）", async () => {
    const repo = makeRepo()
    const gone = join(tmpRoot(), "no-such-repo")
    const s = new PerRepoStrategy()
    const ok = await s.start([], [{ id: "R", path: repo }, { id: "G", path: gone }], noopHandlers([]))
    expect(ok).toEqual([repo])
    await s.stop()
  })

  // Task 7 为 win/mac 建的自愈链（失守 → onOverflow → 重扫补票 + 重建句柄）必须延伸到 Linux。
  // 不延伸的后果：ENOSPC（inotify 上限，73+ 仓库时是真实场景）或 EMFILE 打掉整个实例，
  // 所有仓库一起冻结、日志一行、无人重建，而 coverage 还在报满覆盖。
  // 内核错误没法在测试里稳定复现（要真把 inotify 上限打满），直接在实例上 emit 一条——
  // 这正是 chokidar 收到内核错误时对我们做的事，测的是我们的分流而不是它的行为
  describe("PerRepoStrategy 的错误分流", () => {
    const emitError = (s: PerRepoStrategy, err: NodeJS.ErrnoException): void => {
      const w = (s as unknown as { watcher: { emit: (ev: string, e: unknown) => void } }).watcher
      w.emit("error", err)
    }

    it("监听目标本身失守（ENOSPC/EMFILE，路径不明也算）→ onOverflow + onError", async () => {
      const repo = makeRepo()
      const overflows: string[] = []
      const errors: NodeJS.ErrnoException[] = []
      const s = new PerRepoStrategy()
      await s.start([], [{ id: "R", path: repo }], {
        onEvent: () => {},
        onOverflow: (r) => void overflows.push(r),
        onError: (e) => void errors.push(e),
      })
      emitError(s, Object.assign(new Error("no space"), { code: "ENOSPC" }))
      emitError(s, Object.assign(new Error("too many files"), { code: "EMFILE", path: realpathSync.native(repo) }))
      expect(overflows.length).toBe(2)
      expect(errors.length).toBe(2)
      await s.stop()
    })

    it("目标底下某个文件出错 → 只记日志，不重建（那是本地开发的日常噪音）", async () => {
      const repo = makeRepo()
      const overflows: string[] = []
      const errors: NodeJS.ErrnoException[] = []
      const s = new PerRepoStrategy()
      await s.start([], [{ id: "R", path: repo }], {
        onEvent: () => {},
        onOverflow: (r) => void overflows.push(r),
        onError: (e) => void errors.push(e),
      })
      emitError(s, Object.assign(new Error("busy"), { code: "EBUSY", path: join(realpathSync.native(repo), "obj", "x.tmp") }))
      expect(overflows).toEqual([])
      expect(errors.length).toBe(1)
      await s.stop()
    })
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

// automation.ts 的 watchLimit 截断靠这个函数判断要不要生效：递归策略下一个 scan root 一个
// 句柄，仓库数再多也不会多开句柄，对着它截断没有任何东西可省
describe("usesPerRepoWatching", () => {
  it("win32/darwin 为假，其余为真——与 defaultStrategy 的平台分叉同一条线", () => {
    withPlatform("win32", () => expect(usesPerRepoWatching()).toBe(false))
    withPlatform("darwin", () => expect(usesPerRepoWatching()).toBe(false))
    withPlatform("linux", () => expect(usesPerRepoWatching()).toBe(true))
  })
})

// Node 在 emit error **之前**就把句柄关了：一次 EMFILE / EIO / FSEvents 失败之后那棵树就是死的，
// 和 EPERM/ENOENT 没有区别。按错误码白名单分流的话，Windows 上一次重负载构建的瞬时 EMFILE
// 加上「用户关掉了周期兜底重扫」（autoScanMinutes = 0 是合法配置），就等于这个 root 下所有仓库
// 在进程余下的生命周期里全部冻结——界面上永远停在过期状态，其它 root 照常更新
describe("watchTargetLost — 监听目标失守判定", () => {
  const targets = [join("D:", "work"), join("D:", "work", ".git", "index")]
  const err = (code: string, path?: string) => ({ code, path }) as NodeJS.ErrnoException

  it("任何错误码打在监听目标本身上都算失守，不只是 EPERM/ENOENT", () => {
    for (const code of ["EPERM", "ENOENT", "EMFILE", "EIO", "ENOSPC", "UNKNOWN"]) {
      expect(watchTargetLost(err(code, join("D:", "work")), targets)).toBe(true)
    }
  })

  it("路径不明 → 算失守（宁可多重建一次，也不要把一棵死掉的树当噪音咽掉）", () => {
    expect(watchTargetLost(err("EMFILE"), targets)).toBe(true)
    expect(watchTargetLost(err("EPERM", undefined), targets)).toBe(true)
  })

  it("目标底下的单个文件出错 → 不算失守（那棵树还活着）", () => {
    expect(watchTargetLost(err("EBUSY", join("D:", "work", "repo", "obj", "x.tmp")), targets)).toBe(false)
    expect(watchTargetLost(err("EMFILE", join("D:", "work", "repo", "a.ts")), targets)).toBe(false)
  })

  // 同一目录以不同大小写回报在 Windows 上是常态；非 Windows 上 /work 与 /WORK 是两个真实目录
  it("大小写比对随平台（两个平台都真跑）", () => {
    withPlatform("win32", () => expect(watchTargetLost(err("EIO", join("d:", "WORK")), targets)).toBe(true))
    withPlatform("linux", () => expect(watchTargetLost(err("EIO", join("d:", "WORK")), targets)).toBe(false))
  })
})

describe("RecursiveRootStrategy — 失守的分流", () => {
  /** 直接把一条 error 投进真实 watcher：验的是「策略拿到这条错误怎么分流」，
   *  不是 libuv 怎么产生它（EMFILE 无法在测试里稳定复现） */
  const emitOn = (s: RecursiveRootStrategy, i: number, e: NodeJS.ErrnoException): void => {
    const watchers = (s as unknown as { watchers: { emit(ev: string, err: unknown): void }[] }).watchers
    expect(watchers.length).toBeGreaterThan(i)
    watchers[i].emit("error", e)
  }

  it("EMFILE 打在 root 上 → 触发重扫补票（而不是只记一条日志就让这棵树永久死掉）", async () => {
    const root = tmpRoot()
    const reasons: string[] = []
    const codes: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], {
      onEvent: () => {},
      onOverflow: (r) => void reasons.push(r),
      onError: (e) => void codes.push(e.code ?? ""),
    })
    emitOn(s, 0, Object.assign(new Error("too many open files"), { code: "EMFILE", path: realpathSync.native(root) }))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(root) // 报调用方的路径形式，日志里能对上配置
    expect(codes).toEqual(["EMFILE"]) // 同时仍然记日志：打包后日志是唯一诊断面
    await s.stop()
  })

  it("目标底下某个文件的错误不触发重扫（那棵树还活着，重扫是白跑）", async () => {
    const root = tmpRoot()
    const reasons: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], { onEvent: () => {}, onOverflow: (r) => void reasons.push(r), onError: () => {} })
    emitOn(s, 0, Object.assign(new Error("busy"), { code: "EBUSY", path: join(realpathSync.native(root), "obj", "x.tmp") }))
    expect(reasons).toEqual([])
    await s.stop()
  })
})
