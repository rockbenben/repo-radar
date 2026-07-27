import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createBackend, type Backend } from "../src/backend"
import { loadConfig } from "../src/config"

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
