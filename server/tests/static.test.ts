import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, parse } from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import { diskStatic } from "../src/static"

const dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-static-"))
  dirs.push(dir)
  mkdirSync(join(dir, "assets"), { recursive: true })
  writeFileSync(join(dir, "index.html"), "<div id=\"root\"></div>")
  writeFileSync(join(dir, "assets", "app-a1b2c3d4.js"), "console.log(1)")
  // web/public/ 下的资源（favicon.svg 等）会原样落到 dist 根部，文件名不带哈希——
  // 用它模拟这种「非 assets/ 下、无哈希」的场景
  writeFileSync(join(dir, "favicon.svg"), "<svg></svg>")
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function appWith(root: string): Hono {
  const app = new Hono()
  app.use("/*", diskStatic(root))
  return app
}

describe("diskStatic", () => {
  it("根路径返回 index.html", async () => {
    const res = await appWith(fixture()).request("/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("id=\"root\"")
  })

  it("按扩展名给出 content-type", async () => {
    const res = await appWith(fixture()).request("/assets/app-a1b2c3d4.js")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("javascript")
  })

  // 带哈希的构建产物可长缓存；index.html 必须每次校验，否则升级后仍加载旧壳
  it("index.html 不缓存，assets/ 下带哈希的文件长缓存", async () => {
    const app = appWith(fixture())
    expect((await app.request("/")).headers.get("cache-control")).toBe("no-cache")
    expect((await app.request("/assets/app-a1b2c3d4.js")).headers.get("cache-control")).toContain("immutable")
  })

  // web/public/ 下的资源原样落到 dist 根部、文件名不带哈希——内容更新后文件名不变，
  // 若也给一年 immutable，浏览器会拿着旧文件钉死一年。回归用例覆盖的正是这个此前的缺陷。
  it("根部无哈希资源不被长缓存", async () => {
    const app = appWith(fixture())
    const res = await app.request("/favicon.svg")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-cache")
  })

  it("不存在的路径交给下一个处理器（API 的 404 不能被静态层吞掉）", async () => {
    const app = appWith(fixture())
    app.all("*", (c) => c.text("fell through", 404))
    const res = await app.request("/api/nope")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("fell through")
  })

  // 路径穿越：root 之外的文件绝不能被读出来
  it("拒绝越出 root 的路径", async () => {
    const root = fixture()
    writeFileSync(join(root, "..", "rr-secret.txt"), "secret")
    const app = appWith(root)
    app.all("*", (c) => c.text("fell through", 404))
    for (const p of ["/../rr-secret.txt", "/..%2Frr-secret.txt", "/assets/../../rr-secret.txt"]) {
      const res = await app.request(p)
      expect(await res.text()).not.toContain("secret")
    }
    rmSync(join(root, "..", "rr-secret.txt"), { force: true })
  })

  // 跨盘符绝对路径注入：resolve(base, "C:/x") 会把整个 base 丢弃、直接返回 "C:/x"，
  // 而 path.relative 在跨盘符时返回目标的绝对路径（不带 ".." 前缀），字符串前缀判断因此失效。
  // 这个用例只在 Windows 上有意义（POSIX 没有盘符概念），且需要机器上确实存在第二个盘符。
  describe.runIf(process.platform === "win32")("跨盘符路径穿越（Windows）", () => {
    it("不能通过 /X:/... 读到 root 之外、别的盘符上的文件", async () => {
      const root = fixture()
      const fixtureDrive = parse(root).root // 例如 "C:\\"
      const candidateDrives = ["C", "D", "E", "F"].map((letter) => `${letter}:\\`)
      const otherDrive = candidateDrives.find((d) => d.toLowerCase() !== fixtureDrive.toLowerCase() && existsSync(d))
      if (!otherDrive) return // 机器上找不到第二个可用盘符，跳过该断言

      const driveLetter = otherDrive[0]
      const secretPath = join(otherDrive, "rr-cross-drive-secret.txt")
      writeFileSync(secretPath, "cross-drive-secret")
      try {
        const app = appWith(root)
        app.all("*", (c) => c.text("fell through", 404))
        const res = await app.request(`/${driveLetter}:/rr-cross-drive-secret.txt`)
        expect(await res.text()).not.toContain("cross-drive-secret")
      } finally {
        rmSync(secretPath, { force: true })
      }
    })
  })

  // 畸形百分号编码：decodeURIComponent("/%") 会抛 URIError。中间件的设计前提是
  // "未命中就 next()"，畸形请求不该穿出去变成裸 500，应同样落到后面的路由（最终 404）。
  it("畸形百分号编码不抛异常、落到 next()", async () => {
    const app = appWith(fixture())
    app.all("*", (c) => c.text("fell through", 404))
    const res = await app.request("/%")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("fell through")
  })
})
