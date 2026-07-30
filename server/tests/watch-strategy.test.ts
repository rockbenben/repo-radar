import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { pathKey, watchTargetLost } from "../src/watch-filter"
import {
  PerRepoStrategy,
  RecursiveRootStrategy,
  defaultStrategy,
  reportedPath,
  usesPerRepoWatching,
  waitForReady,
} from "../src/watch-strategy"
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
    // 停之前先清空：这条用例钉的是「stop 之后」，建立监听期间收到什么与它无关。
    // 不清的话，macOS 上 mkdtemp/建立监听阶段迟到的事件会把它染红，而失败信息指向的是
    // 一个它根本没在测的东西
    events.length = 0
    await s.stop()
    writeFileSync(join(root, "after.txt"), "x")
    await new Promise((r) => setTimeout(r, 400))
    expect(events).toEqual([])
  })

  // macOS CI 上真实发生过：stop() 之后写文件，回调照样进来（FSEvents 的延迟缓冲把已经在途
  // 的那一批交了上来）。这里不依赖某个平台的时序去复现，直接把「关掉之后内核又送来一条」
  // 这个事实摆出来——它在三个平台上都必须被挡住
  it("句柄关掉之后迟到的事件不转手（macOS 的 FSEvents 会这么干）", async () => {
    const root = tmpRoot()
    const events: string[] = []
    const overflows: string[] = []
    const errors: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], {
      onEvent: (p) => events.push(p),
      onOverflow: (r) => overflows.push(r),
      onError: (e) => errors.push(e.code ?? e.message),
    })
    // 关之前抓住句柄：stop() 会把 watchers 清空，之后就没有别的入口了
    const w = (s as unknown as { watchers: { emit(ev: string, ...a: unknown[]): void }[] }).watchers[0]
    await s.stop()
    w.emit("change", "rename", "late.txt") // 迟到的普通事件
    w.emit("change", "rename", null) // 迟到的缓冲区溢出
    w.emit("error", Object.assign(new Error("late"), { code: "EIO", path: realpathSync.native(root) }))
    expect(events).toEqual([])
    expect(overflows).toEqual([]) // 关掉之后不该再要求重扫，更不该要求重建
    expect(errors).toEqual([])
  })

  // 反面：世代号用布尔量实现时最容易踩的坑——同一个实例先 stop 再 start（setRoots 就是
  // 这么走的），第二批句柄必须照常工作，否则「改了扫描目录之后再也不刷新」
  it("stop 之后重新 start，新一批句柄照常报事件", async () => {
    const root = tmpRoot()
    const events: string[] = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], noopHandlers(events))
    await s.stop()
    await s.start([root], [], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(root, "again.txt"), "x")
    await waitFor(() => events.length > 0)
    await s.stop()
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

  /**
   * 同一棵树被挂两个递归句柄 = 句柄、内核缓冲区、每条事件的 JS 处理成本全部翻倍，而多出来的
   * 那份一条新信息都不带（防抖会把重复事件合并掉）——没有任何症状会把它暴露出来，只能靠
   * 这条用例。尾分隔符与 `sub/..` 这种写法在两个平台上都是合法且不同的裸字符串
   */
  it("只差写法的 root 只挂一个句柄（按归一化口径去重，不是裸字符串）", async () => {
    const root = tmpRoot()
    const s = new RecursiveRootStrategy()
    const ok = await s.start([root, `${root}${sep}`, join(root, "sub", "..")], [], noopHandlers([]))
    expect(ok).toEqual([root]) // 保留第一次出现的原始形式：事件要按调用方给的形式报回去
    const watchers = (s as unknown as { watchers: unknown[] }).watchers
    expect(watchers).toHaveLength(1) // 三种写法，一个句柄
    await s.stop()
  })

  // 归档仓库要进 RepoWatcher 的归属映射（否则它的写入会被当成目录结构变化，见 watcher.test.ts），
  // 但**不该为它建句柄**：它不上看板，挂了也只是白占资源
  it("归档仓库不建立监听目标（它只该进归属映射，不该占一个句柄）", async () => {
    const root = tmpRoot()
    const archivedOutside = tmpRoot()
    const s = new RecursiveRootStrategy()
    const ok = await s.start([root], [{ id: "ARCH", path: archivedOutside, archived: true }], noopHandlers([]))
    expect(ok).toEqual([root]) // 只有 scan root 自己，归档的 manualRepo 没有单独的句柄
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
    events.length = 0 // 同递归那条：钉的是「stop 之后」，建立期间收到什么与它无关
    await s.stop()
    writeFileSync(join(repo, "after.txt"), "x")
    await new Promise((r) => setTimeout(r, 600))
    expect(events).toEqual([])
  })

  // 递归策略那边要靠世代号挡住关掉之后迟到的事件；这条腿不需要，理由不是"大概不会发生"，
  // 而是 chokidar 的 close() 在同步段里就把监听器摘掉了——这里把它钉住，免得哪天有人
  // 照着递归那条给这里也补一个永远走不到的守卫，或者反过来把递归那条删掉
  it("chokidar 的 close() 同步摘掉监听器，关掉之后根本没有回调可言", async () => {
    const repo = makeRepo()
    const s = new PerRepoStrategy()
    await s.start([], [{ id: "R", path: repo }], noopHandlers([]))
    const w = (s as unknown as { watcher: { listenerCount(ev: string): number } | null }).watcher!
    expect(w.listenerCount("all")).toBe(1)
    const stopping = s.stop() // 故意不 await：摘监听器发生在 close() 的同步段，不在 await 之后
    expect(w.listenerCount("all")).toBe(0)
    expect(w.listenerCount("error")).toBe(0)
    await stopping
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

  /**
   * A3：start 原先返回的是「路径存在的」而不是「chokidar 真正挂上的」——它从不 await `ready`。
   * inotify 耗尽（ENOSPC，73+ 仓库时是真实场景）或 EMFILE 时所有路径都存在，于是设置面板
   * 显示**全覆盖**而实际一个仓库都收不到事件，用户看到卡片不动时唯一的诊断面在说「一切正常」。
   *
   * 手法：不 await start（它在第一个 await 之前是同步跑完的，`this.watcher` 已经赋值），
   * 趁 ready 之前把内核会给我们的那条错误直接投进实例。内核错误没法在测试里稳定复现
   * （要真把 inotify 上限打满），测的是我们的分流而不是 chokidar 的行为。
   * 这同时钉住了「start 确实等了 ready」：不等的话返回值在我们 emit 之前就已经算完了
   */
  describe("PerRepoStrategy 的建立期失守 → coverage 如实变低", () => {
    const emitError = (s: PerRepoStrategy, err: NodeJS.ErrnoException): void => {
      const w = (s as unknown as { watcher: { emit: (ev: string, e: unknown) => void } }).watcher
      w.emit("error", err)
    }

    it("ENOSPC 路径不明 → 一个仓库都不算覆盖（说不清打掉了谁，只能按整个实例算）", async () => {
      const a = makeRepo()
      const b = makeRepo()
      const s = new PerRepoStrategy()
      const started = s.start([], [{ id: "A", path: a }, { id: "B", path: b }], noopHandlers([]))
      emitError(s, Object.assign(new Error("no space"), { code: "ENOSPC" }))
      expect(await started).toEqual([])
      await s.stop()
    })

    it("失守打在某个仓库的目标上 → 只有它掉出覆盖，其它仓库照常", async () => {
      const a = makeRepo()
      const b = makeRepo()
      const s = new PerRepoStrategy()
      const started = s.start([], [{ id: "A", path: a }, { id: "B", path: b }], noopHandlers([]))
      emitError(s, Object.assign(new Error("no space"), { code: "ENOSPC", path: join(realpathSync.native(a), ".git", "refs") }))
      expect(await started).toEqual([b])
      await s.stop()
    })

    // 首轮遍历撞上一个刚被删掉/正被锁着的临时文件是本地开发的日常噪音（EBUSY/EPERM/ENOENT
    // 打在目标**底下**的单个文件上）。把它算成失守的话，覆盖数会因为一次 npm install 的
    // 残骸凭空掉下去，automation 随即每轮重扫补一次注定白跑的 applyWatch
    it("目标底下单个文件的日常噪音不影响覆盖", async () => {
      const a = makeRepo()
      const s = new PerRepoStrategy()
      const started = s.start([], [{ id: "A", path: a }], noopHandlers([]))
      emitError(s, Object.assign(new Error("busy"), { code: "EBUSY", path: join(realpathSync.native(a), "obj", "x.tmp") }))
      expect(await started).toEqual([a])
      await s.stop()
    })
  })

  // 这条腿上每个仓库要挂好几个 inotify watch，为不上看板的归档仓库挂等于白占
  // fs.inotify.max_user_watches 的名额
  it("归档仓库不进 chokidar 的目标列表，也不算进覆盖", async () => {
    const live = makeRepo()
    const archived = makeRepo()
    const s = new PerRepoStrategy()
    const ok = await s.start([], [{ id: "L", path: live }, { id: "A", path: archived, archived: true }], noopHandlers([]))
    expect(ok).toEqual([live])
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

/**
 * `ready` 要等所有目标的首轮 readdir 结束，网络盘 / 巨大仓库上可能很久甚至走不完，而这条
 * promise 挂在 RepoWatcher.setRoots 里——没有上限的话一次慢盘就能让整轮重扫、以及退出流程里
 * 的 drainRescans 永远挂住（托盘退出/关机路径上直接表现为「点了退出没反应」）。
 * 用真 watcher 造不出「永远不 ready」，所以直接喂一个不发 ready 的 EventEmitter
 */
describe("waitForReady — 等不到 ready 不能永远挂住", () => {
  const fake = () => new EventEmitter() as unknown as { once(e: "ready", f: () => void): unknown }

  it("超时返回 false，而不是把调用方挂死", async () => {
    const hung = Symbol("hung")
    const raced = await Promise.race([
      waitForReady(fake(), 50),
      new Promise((r) => setTimeout(() => r(hung), 500)),
    ])
    expect(raced).toBe(false) // 拿到 hung 就说明超时兜底没了
  })

  it("ready 到了就立刻返回 true", async () => {
    const em = new EventEmitter()
    const p = waitForReady(em as unknown as { once(e: "ready", f: () => void): unknown }, 5000)
    em.emit("ready")
    expect(await p).toBe(true)
  })
})

/**
 * 事件路径必须回到**调用方给的坐标系**：监听挂在 realpath 上（8.3 短名会触发 libuv 断言，
 * 整个进程 abort），归属表里却是 scanner 从配置 root 拼出来的原始形式。两者对不上时，
 * 所有仓库静默停止刷新，且每条事件都被当成目录结构变化去触发重扫。
 * 直接喂两个不同的形式进来，不依赖平台是否恰好能造出 8.3 短名或软链
 */
describe("reportedPath — 两个坐标系", () => {
  // 两条腿上都要是**绝对**路径：`isAbsolute(name)` 是这个函数的第一道分叉，
  // 拿 `D:\…` 当输入的话它在 Linux 上是相对路径，走的就是另一条分支（等于没测到）
  const vol = process.platform === "win32" ? "D:\\" : "/"
  const target = join(vol, "t")
  const real = join(vol, "real", "deep")

  it("real 之下的路径换回调用方的形式", () => {
    expect(reportedPath(target, real, "a.txt")).toBe(join(target, "a.txt"))
    expect(reportedPath(target, real, join(real, "src", "a.ts"))).toBe(join(target, "src", "a.ts"))
    expect(reportedPath(target, real, "")).toBe(target)
  })

  // 裸 rel.startsWith("..") 会把仓库根下一个名叫 `..foo` 的文件当成「跑到 real 外面去了」，
  // 于是报 realpath 形式——那条路径在归属表里对不上，这次写入被当成目录结构变化，
  // 白跑一轮 force=true 的全量重扫（拆了重建全部句柄）
  it("名字以 .. 开头的普通文件不算「不在 real 之下」", () => {
    expect(reportedPath(target, real, "..foo")).toBe(join(target, "..foo"))
    expect(reportedPath(target, real, "...hidden")).toBe(join(target, "...hidden"))
    expect(reportedPath(target, real, join("sub", "..bar"))).toBe(join(target, "sub", "..bar"))
  })

  it("真的跑到 real 外面时原样交出绝对路径，不硬拼一个假路径", () => {
    const outside = join(vol, "real", "sibling", "x.ts")
    expect(reportedPath(target, real, outside)).toBe(outside)
  })
})

// 归属映射与监听目标去重共用这一个键。两处各写一份的话，「同一棵树」在一处是一个、
// 在另一处是两个，句柄成本翻倍而没有任何症状会把它暴露出来
describe("pathKey — 归一化口径", () => {
  it("Windows 上大小写不敏感，其余平台敏感（两个平台都真跑）", () => {
    withPlatform("win32", () => expect(pathKey(join("D:", "Work"))).toBe(pathKey(join("d:", "work"))))
    withPlatform("linux", () => expect(pathKey(join("D:", "Work"))).not.toBe(pathKey(join("d:", "work"))))
  })

  it("尾分隔符与 `sub/..` 这类写法归一到同一个键", () => {
    const p = join("D:", "code")
    expect(pathKey(`${p}${sep}`)).toBe(pathKey(p))
    expect(pathKey(join(p, "sub", ".."))).toBe(pathKey(p))
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

  /** 把一条 change 事件直接投进真实 watcher；name === null 就是内核缓冲区溢出，
   *  libuv 以这个形式把它交给回调（塞满 64KB 内核缓冲区无法在测试里稳定复现） */
  const changeOn = (s: RecursiveRootStrategy, i: number, name: string | null): void => {
    const watchers = (s as unknown as { watchers: { emit(ev: string, ...a: unknown[]): void }[] }).watchers
    expect(watchers.length).toBeGreaterThan(i)
    watchers[i].emit("change", "rename", name)
  }

  // 溢出与「监听目标本身没了」后果完全不同：前者句柄还活着，只是这一批通知装不下；后者句柄
  // 已经死了，不重建那棵树从此永久静默。两者曾共用一个信号、都按「重建」处理，于是一棵正忙的
  // 树上每分钟一次的溢出都要把整套句柄拆了重建（实测 74 个仓库、每 62 秒一次，永不停）——
  // 纯属白干，还会在拆建窗口里真的丢事件，反过来又给下一轮重扫提供理由
  it("缓冲区溢出报 rebuild=false（句柄还活着），目标丢失报 rebuild=true", async () => {
    const root = tmpRoot()
    const seen: Array<[string, boolean]> = []
    const s = new RecursiveRootStrategy()
    await s.start([root], [], {
      onEvent: () => {},
      onOverflow: (r, rebuild) => void seen.push([r, rebuild]),
      onError: () => {},
    })
    changeOn(s, 0, null)
    emitOn(s, 0, Object.assign(new Error("io error"), { code: "EIO", path: realpathSync.native(root) }))
    expect(seen.map(([, rebuild]) => rebuild)).toEqual([false, true])
    expect(seen[0][0]).toContain("overflow")
    expect(seen[1][0]).toContain("lost")
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
