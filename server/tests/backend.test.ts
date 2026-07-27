import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBackend, type Backend } from "../src/backend"
import { loadConfig } from "../src/config"

const PORT = 7461 // 与默认端口错开，避免撞上本机正在跑的实例
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

  // 端口被别的程序占着：如实失败，由 desktop 层弹原生对话框
  it("端口被占用 → start reject，code 为 EADDRINUSE", async () => {
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b = createBackend(opts())
    await expect(b.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
  })
})
