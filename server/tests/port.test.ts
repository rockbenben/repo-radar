import { describe, expect, it, vi } from "vitest"
import { DEFAULT_PORT, resolvePort } from "../src/port"

describe("resolvePort — REPO_RADAR_PORT 解析", () => {
  const silent = () => {}

  it("未设置/空串 → 默认端口", () => {
    expect(resolvePort(undefined, silent)).toBe(DEFAULT_PORT)
    expect(resolvePort("", silent)).toBe(DEFAULT_PORT)
    expect(resolvePort("   ", silent)).toBe(DEFAULT_PORT)
  })

  it("合法端口原样采用（含边界）", () => {
    expect(resolvePort("8080", silent)).toBe(8080)
    expect(resolvePort(" 8080 ", silent)).toBe(8080) // Number() 自己吃掉空白
    expect(resolvePort("1", silent)).toBe(1)
    expect(resolvePort("65535", silent)).toBe(65535)
  })

  it("非法值退回默认并告警（不能静默跑在意料之外的端口上）", () => {
    for (const bad of ["0", "-1", "65536", "abc", "80.5", "1e5", "NaN"]) {
      const warn = vi.fn()
      expect(resolvePort(bad, warn)).toBe(DEFAULT_PORT)
      expect(warn).toHaveBeenCalledOnce()
    }
  })

  it("端口 0 必须被拒：系统随机分配会让 URL/单实例探测/同源白名单同时失效", () => {
    expect(resolvePort("0", silent)).toBe(DEFAULT_PORT)
  })
})
