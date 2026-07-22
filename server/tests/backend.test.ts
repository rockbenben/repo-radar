import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBackend, type Backend } from "../src/backend"

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

  // 端口被别的程序占着：如实失败，由 desktop 层弹原生对话框
  it("端口被占用 → start reject，code 为 EADDRINUSE", async () => {
    const squatter = createServer()
    squatters.push(squatter)
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", r))

    const b = createBackend(opts())
    await expect(b.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
  })
})
