import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createBackend, createRescanScheduler, createStructureRescan, type Backend } from "../src/backend"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config"
import { RepoWatcher } from "../src/watcher"

/** 手动可控的 promise，精确摆出「上一轮还没结束/还没开跑」的时序——与 serial.test.ts 同一手法 */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// 端口不能写死：除了「撞上本机正在跑的实例」，Windows 上还有更隐蔽的一种——Hyper-V/WSL2 的
// WinNAT 会成段预留高位端口，落在区间里的端口 bind 直接 EACCES（本仓库这次的启动故障就是
// 旧的默认端口 7420 被圈进 7420–7519）。让系统给一个当下确实可用的端口，测试才在任何机器上都成立
let PORT = 0
beforeAll(async () => {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r))
  PORT = (probe.address() as AddressInfo).port
  await new Promise((r) => probe.close(r))
})

let running: Backend[] = []
let dirs: string[] = []
let squatters: Server[] = []

function opts() {
  const dir = mkdtempSync(join(tmpdir(), "rr-backend-"))
  dirs.push(dir)
  return { configFile: join(dir, "config.json"), staticRoot: dir, version: "9.9.9", port: PORT }
}

afterEach(async () => {
  for (const b of running.splice(0)) await b.stop()
  for (const s of squatters.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function track(b: Backend): Backend {
  running.push(b)
  return b
}

describe("createBackend", () => {
  it("start 后端口可访问，/api/version 自报注入的版本", async () => {
    const b = track(createBackend(opts()))
    await b.start()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/version`)
    expect(await res.json()).toMatchObject({ app: "repo-radar", version: "9.9.9" })
  })

  it("stop 之后端口被释放，可以再次 start", async () => {
    const b1 = createBackend(opts())
    await b1.start()
    await b1.stop()
    const b2 = track(createBackend(opts()))
    await expect(b2.start()).resolves.toBeUndefined()
  })

  it("stop 幂等：重复调用不抛", async () => {
    const b = createBackend(opts())
    await b.start()
    await b.stop()
    await expect(b.stop()).resolves.toBeUndefined()
  })

  // 「上次扫描」是界面上唯一能看出兜底重扫是否真的在跑的凭据——它必须由真正跑完的
  // 全量扫描来填，而不是 start() 一返回就先写上一个值
  it("启动扫描跑完后 /api/scan 报出扫描时刻", async () => {
    const b = track(createBackend(opts()))
    await b.start()
    let last: string | null = null
    for (let i = 0; i < 40 && last === null; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const s = (await (await fetch(`http://127.0.0.1:${PORT}/api/scan`)).json()) as { lastScanAt: string | null }
      last = s.lastScanAt
    }
    expect(last).not.toBeNull()
    expect(Number.isNaN(Date.parse(last!))).toBe(false)
  })

  // 兜底定时重扫没有任何 HTTP 响应可以承载结果——scan:done 只带时刻的话，服务端 store
  // 更新了、界面却停在旧数据：删掉的仓库还列着，新克隆的不出现，而顶栏偏偏说「刚扫过」
  it("scan:done 带上完整仓库列表，定时重扫的结果才到得了界面", async () => {
    const b = track(createBackend(opts()))
    await b.start()
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("ws 连接失败")))
    })
    const done = new Promise<{ at: string; repos: unknown[] }>((resolve) => {
      ws.addEventListener("message", (m) => {
        const e = JSON.parse(String(m.data)) as { type: string; payload: { at: string; repos: unknown[] } }
        if (e.type === "scan:done") resolve(e.payload)
      })
    })
    await fetch(`http://127.0.0.1:${PORT}/api/scan`, { method: "POST" })
    const payload = await done
    expect(Number.isNaN(Date.parse(payload.at))).toBe(false)
    expect(Array.isArray(payload.repos)).toBe(true)
    ws.close()
  })

  it("POST /api/auto-scan 把兜底重扫间隔落盘到 config", async () => {
    const o = opts()
    const b = track(createBackend(o))
    await b.start()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/auto-scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutes: 60 }),
    })
    expect(await res.json()).toEqual({ ok: true, autoScanMinutes: 60 })
    expect(loadConfig(o.configFile).autoScanMinutes).toBe(60)
  })

  // 端口被别的程序占着 / 被系统成段保留（Windows 的 WinNAT 会让 bind 直接 EACCES，
  // 而且区间随重启漂移）：不能就此起不来，换个端口继续
  it("端口被占用 → 自动回退到候选端口，backend.port 报的是实际绑定的那个", async () => {
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b = track(createBackend(opts()))
    await expect(b.start()).resolves.toBeUndefined()
    expect(b.port).not.toBe(PORT)
    expect(b.port).toBeGreaterThan(0)
    const res = await fetch(`http://127.0.0.1:${b.port}/api/version`)
    expect(await res.json()).toMatchObject({ app: "repo-radar" })
  })

  // 回退换了端口，界面自己发的请求就带着新端口的 Origin——白名单没跟着换的话整个 API 403，
  // 表现是「窗口开着、按钮全都点不动」，比起不来更难查
  it("回退后同源白名单跟着实际端口走", async () => {
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b = track(createBackend(opts()))
    await b.start()
    const ok = await fetch(`http://127.0.0.1:${b.port}/api/version`, {
      headers: { origin: `http://127.0.0.1:${b.port}` },
    })
    expect(ok.status).toBe(200)
    const stale = await fetch(`http://127.0.0.1:${b.port}/api/version`, {
      headers: { origin: `http://127.0.0.1:${PORT}` }, // 原端口上现在是别人
    })
    expect(stale.status).toBe(403)
  })

  it("能绑上原端口时绝不回退", async () => {
    const b = track(createBackend(opts()))
    await b.start()
    expect(b.port).toBe(PORT)
  })

  // 显式指定的端口是对外承诺（书签、反向代理上游、脚本）；开发模式下 vite 的代理目标也在
  // 配置加载时就定死了。这两种情况必须响亮地失败，而不是换个端口装作一切正常
  it("allowPortFallback=false 时绑不上就如实抛，绝不换端口", async () => {
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b = createBackend({ ...opts(), allowPortFallback: false })
    await expect(b.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
  })

  // 端口是窗口 origin 的一部分，换端口 = localStorage 整个换一套（保存的视图、活动日志、
  // 主题、语言全在里面）。系统保留区间会随重启漂移，不记住的话用户数据会来回消失又出现
  it("被迫换端口后记住它，下次启动直接用记住的那个", async () => {
    const o = opts()
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b1 = createBackend(o)
    await b1.start()
    const fallbackPort = b1.port
    expect(fallbackPort).not.toBe(PORT)
    await b1.stop()

    // 原端口这次空着，但仍应优先用记住的那个——origin 稳定比用上默认端口重要
    await new Promise((r) => squatter.close(r))
    squatters.length = 0
    const logged: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")))
    const b2 = track(createBackend(o))
    await b2.start()
    spy.mockRestore()
    expect(b2.port).toBe(fallbackPort)
    // 这一轮原端口其实是空的，日志不能写成「原 X 不可用」——那会把照着日志排查端口占用的人带偏
    const portLine = logged.find((l) => l.includes(`使用端口 ${fallbackPort}`))
    expect(portLine).toBeDefined()
    expect(portLine).not.toContain("不可用")
  })

  it("用回原端口时清掉记录，一次偶发冲突不会被永久固化", async () => {
    const o = opts()
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))
    const b1 = createBackend(o)
    await b1.start()
    await b1.stop()
    await new Promise((r) => squatter.close(r))
    squatters.length = 0

    // 关掉回退：此时只会尝试原端口，绑上后应把记录抹掉
    const b2 = createBackend({ ...o, allowPortFallback: false })
    await b2.start()
    expect(b2.port).toBe(PORT)
    await b2.stop()

    // 记录已清：再开一个允许回退的实例，原端口空着就该用原端口
    const b3 = track(createBackend(o))
    await b3.start()
    expect(b3.port).toBe(PORT)
  })

  // 5173 是 vite 默认端口，用户机器上别的项目随时可能占着它
  it("默认不放行 vite dev origin，devOrigins=true 才放行", async () => {
    const b = track(createBackend(opts()))
    await b.start()
    const blocked = await fetch(`http://127.0.0.1:${b.port}/api/version`, {
      headers: { origin: "http://localhost:5173" },
    })
    expect(blocked.status).toBe(403)

    const d = track(createBackend({ ...opts(), port: 0, devOrigins: true }))
    await d.start()
    const allowed = await fetch(`http://127.0.0.1:${d.port}/api/version`, {
      headers: { origin: "http://localhost:5173" },
    })
    expect(allowed.status).toBe(200)
  })
})

// 「监听丢了事件 / 目录结构变了」→ 重新刷新，这条自愈链的最后一环。坏掉的表现是某些仓库
// 永远停在过期状态而进程里没有任何异常，所以每一条行为都得钉住：合并窗口、失败只记日志、
// 退出后不再排队、以及「定时器先置空再重扫」的顺序
describe("createStructureRescan — 结构变化触发的兜底重扫", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // cooldownMs 默认 0：本 describe 钉的是防抖/日志/撤销这一层，速率上限单独有一个
  // 假时钟的 describe 负责，两者混在一起会让每条用例都要多等一个冷却窗口
  function harness(rescan: () => Promise<unknown>, delayMs = 30, cooldownMs = 0) {
    const logs: string[] = []
    const errors: string[] = []
    const s = createStructureRescan({
      rescan,
      delayMs,
      cooldownMs,
      log: (m) => void logs.push(m),
      logError: (m) => void errors.push(m),
    })
    return { ...s, logs, errors }
  }

  it("窗口内连发多条信号只跑一轮重扫（改一批目录名会连发一串）", async () => {
    let calls = 0
    const h = harness(async () => void calls++)
    h.onStructureChanged("first reason")
    h.onStructureChanged("second reason")
    h.onStructureChanged("third reason")
    expect(calls).toBe(0) // 后沿触发：不是收到就立刻跑
    await sleep(120)
    expect(calls).toBe(1)
    expect(h.logs.join()).toContain("first reason") // 日志里留下触发原因，打包后这是唯一诊断面
    h.stop()
  })

  it("重扫抛错只记日志，不产生未处理的 rejection", async () => {
    const h = harness(async () => Promise.reject(new Error("rescan boom")))
    h.onStructureChanged("boom")
    await sleep(120)
    expect(h.errors.join()).toContain("rescan boom")
    h.stop()
  })

  it("stop 之后不再触发重扫（退出时排着的那一轮必须撤销）", async () => {
    let calls = 0
    const h = harness(async () => void calls++)
    h.onStructureChanged("x")
    h.stop()
    await sleep(120)
    expect(calls).toBe(0)
  })

  // 定时器要在开跑之前置空，且重扫期间到来的信号必须被记住——正好是「重扫本身很慢、
  // 这期间新克隆了一个仓库」这种情况。**但它不能立刻再起一轮**：那是 C2 那条无上界
  // 速率的来源。新语义是「记下来，等这一轮收尾 + 冷却之后再排」，信号既不丢也不加速。
  // 本用例把冷却设为 0，只钉「不丢」这一半；速率上限由下面的假时钟用例单独钉
  it("重扫进行中到来的新信号被记住，等这一轮收尾后才排下一轮", async () => {
    let calls = 0
    let release: () => void = () => {}
    const h = harness(async () => {
      calls++
      await new Promise<void>((r) => (release = r))
    }, 30, 0)
    h.onStructureChanged("first")
    await sleep(120)
    expect(calls).toBe(1) // 第一轮还没结束
    h.onStructureChanged("second")
    await sleep(120)
    expect(calls).toBe(1) // 上一轮还跑着，绝不能叠一轮上去
    release()
    await sleep(120)
    expect(calls).toBe(2) // 收尾之后那条信号如约兑现，没有被丢掉
    h.stop()
  })
})

// C2：防抖只压得住「一串」，压不住「一直」。win/mac 的递归监听看得见 scan root 下的一切，
// 于是 root 下的草稿目录、非 git 项目、以及被 excludes 排除的仓库只要在持续写入，就会
// 源源不断地产生未归属事件；而结构重扫走的是 force=true（stop() + start() 整套监听句柄）
// 的贵路径。旧写法是每约 2 秒 + 重扫时长无限触发一轮——约 600 倍于它所取代的
// 「每 30 分钟重建一次」。用假时钟把这条不变量钉死：无论投多少信号，速率有上限。
describe("createStructureRescan — 结构信号的速率上限（C2）", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("10 秒内投 100 个未归属信号，只触发一轮重扫", async () => {
    let calls = 0
    const s = createStructureRescan({
      rescan: async () => void calls++,
      delayMs: 2000,
      cooldownMs: 60_000,
      log: () => {},
      logError: () => {},
    })
    try {
      for (let i = 0; i < 100; i++) {
        s.onStructureChanged(`noise ${i}`)
        await vi.advanceTimersByTimeAsync(100) // 100 × 100ms = 10 秒
      }
      expect(calls).toBe(1)

      // 冷却过去之后，攒着的那条信号如约兑现——限的是速率，不是把信号丢掉
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(2)
    } finally {
      s.stop()
    }
  })

  it("stop 之后，正在跑的那一轮收尾时不会再排一轮", async () => {
    let calls = 0
    let release: () => void = () => {}
    const s = createStructureRescan({
      rescan: async () => {
        calls++
        await new Promise<void>((r) => (release = r))
      },
      delayMs: 10,
      cooldownMs: 0,
      log: () => {},
      logError: () => {},
    })
    s.onStructureChanged("first")
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toBe(1)
    s.onStructureChanged("second") // 排进 pending
    s.stop()
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
  })
})

// 上一个任务交接过来的约束 A：普通重扫（周期定时器/手动点击）只能走 applyRepos（纯 JS 改
// 映射表），结构变化/溢出触发的重扫必须走 applyWatch（重建句柄）——否则「这棵树已经死了」
// 这一类信号会被收下又扔掉，那个 root 下的仓库会在进程余下的生命周期里静默冻结。
//
// 不直接模拟一次真实的 fs 结构变化事件来触发这条路径：createStructureRescan 本身的防抖/
// 去重/错误处理已经在上面的 describe 里钉住了；而"新仓库出现"在 Linux 的 PerRepoStrategy 下
// 根本不会产生结构信号（chokidar 只认已知的仓库路径，不认 scan root 本身，见 watch-strategy.ts
// 的 PerRepoStrategy 注释），照真实 fs 事件写的测试在这条腿上会一直等不到信号、只能超时，
// 不是"平台上表现不同"而是"平台上压根测不到"。
// 换一个断言点：backend.ts 里 rescanFresh()（POST /api/new-project、POST /api/clone 用）
// 与结构变化触发的重扫共享同一个 rescanAndWatch(true) 收尾路径（同一个 force=true），
// 用它验证"force 决定收尾走 applyWatch 还是 applyRepos"这条线路真的接对了，且跨平台一致
describe("doRescanAndWatch 收尾按 force 走两条不同的路（约束 A）", () => {
  it("普通重扫只调 watcher.setRepos；force 重扫（新建项目触发）会调 watcher.setRoots 重建监听", async () => {
    const o = opts()
    const root = mkdtempSync(join(tmpdir(), "rr-backend-root-"))
    dirs.push(root)
    saveConfig(o.configFile, { ...DEFAULT_CONFIG, roots: [root] })
    const b = track(createBackend(o))
    await b.start()

    // 等启动扫描（force=true 的第一轮）落定，再装间谍——否则启动那一次的 setRoots 会被误数进来
    let last: string | null = null
    for (let i = 0; i < 60 && last === null; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const s = (await (await fetch(`http://127.0.0.1:${b.port}/api/scan`)).json()) as { lastScanAt: string | null }
      last = s.lastScanAt
    }
    expect(last).not.toBeNull()

    const setRootsSpy = vi.spyOn(RepoWatcher.prototype, "setRoots")
    const setReposSpy = vi.spyOn(RepoWatcher.prototype, "setRepos")

    // 手动点「重扫」：force=false，本任务的性能收益所在——只该改映射表，不该碰句柄
    await fetch(`http://127.0.0.1:${b.port}/api/scan`, { method: "POST" })
    expect(setReposSpy).toHaveBeenCalled()
    expect(setRootsSpy).not.toHaveBeenCalled()

    // 新建项目：服务端自己刚往磁盘上添了一个仓库，走 rescanFresh（force=true），
    // 与结构变化触发的重扫收尾走的是同一段代码
    const res = await fetch(`http://127.0.0.1:${b.port}/api/new-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: root, name: "new-repo" }),
    })
    expect(res.status).toBe(200) // 前提：创建必须成功，否则不会走到 rescanFresh，下面的断言就没有意义
    expect(setRootsSpy).toHaveBeenCalled()

    setRootsSpy.mockRestore()
    setReposSpy.mockRestore()
  })
})

// 评审 I1：force=true 的请求如果落在一个 force=false 轮次「已排队但还没开跑」的窗口里，
// 旧写法会被那一轮悄悄吞掉——约束 A 从另一个口子漏回来（死句柄不再发任何事件，之后也不会
// 再有信号来救它）。这里不需要真实的 backend/HTTP：SerialQueue.share 排的任务必然要等一个
// 微任务才真正开跑（tail.then 的回调不会同步执行），所以两次同步的 trigger() 调用——不在
// 中间 await 任何东西——就足以精确摆出「已排队未开跑」这个窗口，不需要 deferred/sleep
describe("createRescanScheduler — force 与已排队轮次的交错（约束 A 的另一个漏洞）", () => {
  it("force=true 落在一个 force=false 已排队未开跑的轮次上，那一轮仍按重建执行", async () => {
    const calls: boolean[] = []
    const scheduler = createRescanScheduler<string[]>({
      run: async (rebuild) => {
        calls.push(rebuild)
        return []
      },
      scanTargets: () => "same",
    })

    const p1 = scheduler.trigger(false) // 排队但还没开跑：task 要等一个微任务才真正执行
    const p2 = scheduler.trigger(true) // 同步紧跟着来一次 force=true
    expect(p2).toBe(p1) // 确实共乘了同一轮——这是 bug 存在的前提，没被吞掉的话根本不会共乘

    await p1
    // 关键断言：共乘的这一轮必须按「重建」执行，而不是最初 force=false 排队时的样子
    expect(calls).toEqual([true])
  })

  it("对照组：全程 force=false 时保持轻量，不会被误判成需要重建", async () => {
    const calls: boolean[] = []
    const scheduler = createRescanScheduler<string[]>({
      run: async (rebuild) => {
        calls.push(rebuild)
        return []
      },
      scanTargets: () => "same",
    })
    const p1 = scheduler.trigger(false)
    const p2 = scheduler.trigger(false)
    expect(p2).toBe(p1)
    await p1
    expect(calls).toEqual([false])
  })

  it("force=true 已经排上队时，后来的 force=false 不能把它降级", async () => {
    const calls: boolean[] = []
    const scheduler = createRescanScheduler<string[]>({
      run: async (rebuild) => {
        calls.push(rebuild)
        return []
      },
      scanTargets: () => "same",
    })
    const p1 = scheduler.trigger(true)
    const p2 = scheduler.trigger(false) // 共乘同一轮，但不该冲掉前面已经置位的「必须重建」
    expect(p2).toBe(p1)
    await p1
    expect(calls).toEqual([true])
  })

  it("进行中的一轮（非排队）：scanTargets 变化时另排新一轮，rebuild 仍按各自的 force 计算", async () => {
    const calls: boolean[] = []
    const gate = deferred<string[]>()
    let target = "a"
    const scheduler = createRescanScheduler<string[]>({
      run: async (rebuild) => {
        calls.push(rebuild)
        return gate.promise
      },
      scanTargets: () => target,
    })
    const running = scheduler.trigger(false)
    await new Promise((r) => setTimeout(r, 10)) // 让它真正开跑（进入 run，不再是「排队」状态）
    target = "b" // 扫描目标变了：即便 force=false 也不该共乘进行中的这一轮
    const p2 = scheduler.trigger(false)
    expect(p2).not.toBe(running)
    gate.resolve([])
    await Promise.all([running, p2])
    expect(calls).toEqual([false, false])
  })
})
