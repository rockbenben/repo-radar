import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveConfigFile } from "../src/config-path"

// 撤销上一轮对 REPO_RADAR_CONFIG 的 path.resolve()：那把「响亮的失败」换成了
// 「静默地按 cwd 选配置文件」——打包应用的 cwd 由系统决定、不可预期（双击启动时可能是
// System32 之类），用户以为在用 ./work.json，实际用的是某个他找不到的地方的文件，
// 找不到就当成首次运行写出一份全新默认配置，原来的 work.json 分毫未动、且没有任何报错。
// 正确做法是显式要求绝对路径：设了但不是绝对路径就报错，不猜。
describe("resolveConfigFile — REPO_RADAR_CONFIG 必须是绝对路径，不再用 cwd 兜底", () => {
  const home = "D:\\Users\\me"

  it("未设置 REPO_RADAR_CONFIG：退回默认路径（~/.repo-radar/config.json）", () => {
    const result = resolveConfigFile(undefined, home)
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json"), isDefault: true })
  })

  it("设置为绝对路径：原样使用，不做任何 resolve/规范化", () => {
    // 用当前平台的绝对路径：resolveConfigFile 走 isAbsolute 判定，硬编码 "D:\\work\\..." 这种盘符
    // 路径在 Linux/macOS 上 isAbsolute=false，会被判成相对路径而报错（CI 上因此挂）。
    const abs = join(tmpdir(), "repo-radar-config.json")
    const result = resolveConfigFile(abs, home)
    expect(result).toEqual({ ok: true, configFile: abs, isDefault: false })
  })

  it("设置为相对路径：报错，不猜、不按 cwd 展开", () => {
    const result = resolveConfigFile("./work.json", home)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/绝对路径/)
  })

  it("设置为相对路径（无 ./ 前缀）：同样报错", () => {
    const result = resolveConfigFile("work.json", home)
    expect(result.ok).toBe(false)
  })

  it("报错信息里包含实际收到的值，方便用户对照自己设的是什么", () => {
    const result = resolveConfigFile("relative/config.json", home)
    if (!result.ok) expect(result.error).toContain("relative/config.json")
  })

  // 缺陷 3：REPO_RADAR_CONFIG="" 在 CI / shell 脚本里很常见（变量声明了但赋的是空值），
  // 语义上等价于"没设置"。上一轮把它当成"设置了一个空字符串"、报"不是绝对路径"的错，
  // 后果是应用启动瞬间弹原生错误框并直接退出——而用户很可能压根没打算设这个变量。
  it("空字符串：视为未设置，退回默认路径，而不是报错（缺陷 3）", () => {
    const result = resolveConfigFile("", home)
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json"), isDefault: true })
  })

  it("纯空白字符串：同样视为未设置（缺陷 3）", () => {
    const result = resolveConfigFile("   ", home)
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json"), isDefault: true })
  })
})

// isDefault 决定 main.ts 要不要把 userData 挪走，也就决定了 Electron 单实例锁的锁域。
// 判定必须看「最终用的是不是那份默认配置」，而不是「有没有设环境变量」：
// REPO_RADAR_CONFIG=<默认路径> 用的是同一份配置、同一批仓库，如果因为"设了变量"就自成锁域，
// 两个后端会同时跑——都往 config.json 写（后写的抹掉前面的设置）、都对同一批仓库做 git 写
// 操作（抢 .git/index.lock）。端口曾是这种情况的最后一道拦截，端口回退把它也拿掉了
describe("resolveConfigFile — isDefault 决定单实例锁域", () => {
  const home = tmpdir() // 用当前平台的真实绝对路径，isAbsolute 才成立
  const defaultFile = join(home, ".repo-radar", "config.json")

  it("显式指向默认路径 → isDefault 为真（与没设变量的进程共享锁域）", () => {
    const result = resolveConfigFile(defaultFile, home)
    expect(result).toEqual({ ok: true, configFile: defaultFile, isDefault: true })
  })

  it("指向别处 → isDefault 为假（自成锁域，这正是多档案能力的用意）", () => {
    const other = join(home, "rr-profile", "config.json")
    const result = resolveConfigFile(other, home)
    if (result.ok) expect(result.isDefault).toBe(false)
  })

  it("同一路径的不同写法也算默认（含 . 与 .. 段）", () => {
    const roundabout = join(home, ".repo-radar", "sub", "..", "config.json")
    const result = resolveConfigFile(roundabout, home)
    if (result.ok) expect(result.isDefault).toBe(true)
  })

  it.runIf(process.platform === "win32")("Windows 上大小写不同也算同一份配置", () => {
    const result = resolveConfigFile(defaultFile.toUpperCase(), home)
    if (result.ok) expect(result.isDefault).toBe(true)
  })
})
