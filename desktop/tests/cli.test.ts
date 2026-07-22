import { describe, expect, it } from "vitest"
import { startsHidden } from "../src/cli"

describe("startsHidden — 是否只起托盘、不弹窗", () => {
  it("命令行带 --tray（Windows/Linux 的自启参数）", () => {
    expect(startsHidden(["repo-radar.exe", "--tray"], false)).toBe(true)
  })

  it("macOS 的登录项没有参数，靠 wasOpenedAsHidden 判断", () => {
    expect(startsHidden(["/Applications/repo-radar.app/Contents/MacOS/repo-radar"], true)).toBe(true)
  })

  it("普通启动 → 显示窗口", () => {
    expect(startsHidden(["repo-radar.exe"], false)).toBe(false)
  })

  it("不把包含 tray 的路径误判成参数", () => {
    expect(startsHidden(["C:\\my--tray\\repo-radar.exe"], false)).toBe(false)
  })
})
