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
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json") })
  })

  it("设置为绝对路径：原样使用，不做任何 resolve/规范化", () => {
    const result = resolveConfigFile("D:\\work\\repo-radar-config.json", home)
    expect(result).toEqual({ ok: true, configFile: "D:\\work\\repo-radar-config.json" })
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
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json") })
  })

  it("纯空白字符串：同样视为未设置（缺陷 3）", () => {
    const result = resolveConfigFile("   ", home)
    expect(result).toEqual({ ok: true, configFile: join(home, ".repo-radar", "config.json") })
  })
})
