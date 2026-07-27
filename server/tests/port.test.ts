import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_PORT, isExplicitPort, isPortUnavailable, portCandidates, resolvePort } from "../src/port"

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

// 显式指定的端口是对外承诺（书签、反向代理上游、脚本里写死的 URL）。悄悄换掉之后那些东西
// 全部 ECONNREFUSED，而应用窗口一切正常——用户没有任何线索。默认端口没有这层承诺
describe("isExplicitPort — 用户是否显式指定了端口", () => {
  it("没设 / 空串 / 纯空白 → 不算显式", () => {
    for (const raw of [undefined, "", "   "]) expect(isExplicitPort(raw)).toBe(false)
  })

  it("合法端口 → 算显式（含前后空白）", () => {
    for (const raw of ["8080", " 8080 ", "1", "65535"]) expect(isExplicitPort(raw)).toBe(true)
  })

  it("非法值 → 不算显式：resolvePort 会把它退回默认端口，那等同于没指定", () => {
    for (const raw of ["0", "-1", "65536", "abc", "80.5", "NaN"]) expect(isExplicitPort(raw)).toBe(false)
  })

  it("显式写成默认端口也算显式：用户点名要它，就别擅自换", () => {
    expect(isExplicitPort(String(DEFAULT_PORT))).toBe(true)
  })

  // 合法性规则只写在 resolvePort 一处，这里防止将来两边漂移
  it("判定与 resolvePort 的合法性规则一致", () => {
    for (const raw of ["8080", "0", "abc", "65535", "65536", " 443 "]) {
      const accepted = resolvePort(raw, () => {}) === Number(raw.trim())
      expect(isExplicitPort(raw)).toBe(accepted)
    }
  })
})

describe("isPortUnavailable — 哪些绑定失败换个端口就能好", () => {
  it("EADDRINUSE / EACCES 属于换端口可解", () => {
    expect(isPortUnavailable({ code: "EADDRINUSE" } as NodeJS.ErrnoException)).toBe(true)
    expect(isPortUnavailable({ code: "EACCES" } as NodeJS.ErrnoException)).toBe(true)
  })

  it("其它错误不属于：换端口既解决不了，还会掩盖真正的故障", () => {
    for (const code of ["EADDRNOTAVAIL", "ENOTFOUND", "EMFILE", undefined]) {
      expect(isPortUnavailable({ code } as NodeJS.ErrnoException)).toBe(false)
    }
  })
})

// 操作系统的动态端口范围是这条防线的核心：落在里面的端口随时可能被成段预留走（bind 直接
// EACCES），而两种 Windows 配置的范围不同——出厂 49152–65535，装了 Hyper-V/WSL2 后 1024–15000。
// 15001–49151 在两者之外都安全，默认端口必须落在这里
const DYNAMIC_RANGE_SAFE_LOW = 15001
const DYNAMIC_RANGE_SAFE_HIGH = 49151

describe("DEFAULT_PORT — 必须避开操作系统动态端口范围", () => {
  it("落在 15001–49151（两种 Windows 动态范围配置之外）", () => {
    expect(DEFAULT_PORT).toBeGreaterThanOrEqual(DYNAMIC_RANGE_SAFE_LOW)
    expect(DEFAULT_PORT).toBeLessThanOrEqual(DYNAMIC_RANGE_SAFE_HIGH)
  })

  it("不是 17500——那是 Dropbox LanSync", () => {
    expect(DEFAULT_PORT).not.toBe(17500)
  })
})

describe("portCandidates — 回退阶梯", () => {
  it("第一个永远是原端口：能用就绝不换", () => {
    expect(portCandidates(DEFAULT_PORT)[0]).toBe(DEFAULT_PORT)
  })

  it("步长足够大，能跨出成段的系统保留区间", () => {
    // 实测 Windows 的 WinNAT 一次预留 7120–7619 共 500 个端口，逐个 +1 会在同段里空转到底
    const alts = portCandidates(DEFAULT_PORT).slice(1).filter((p) => p !== 0)
    expect(alts.every((p) => p >= DEFAULT_PORT + 1000)).toBe(true)
    expect(alts.length).toBeGreaterThanOrEqual(2)
  })

  // 默认端口选得再好，回退一两级就掉回动态范围的话等于白选
  it("默认端口的整条阶梯都留在安全窗口内", () => {
    for (const p of portCandidates(DEFAULT_PORT).filter((p) => p !== 0)) {
      expect(p).toBeGreaterThanOrEqual(DYNAMIC_RANGE_SAFE_LOW)
      expect(p).toBeLessThanOrEqual(DYNAMIC_RANGE_SAFE_HIGH)
    }
  })

  it("最后兜底 0（交给系统分配），保证总能起来", () => {
    expect(portCandidates(DEFAULT_PORT).at(-1)).toBe(0)
    expect(portCandidates(65500).at(-1)).toBe(0)
  })

  it("越界候选被剔除，不会去绑 65535 以上", () => {
    expect(portCandidates(65500).every((p) => p >= 0 && p <= 65535)).toBe(true)
  })

  it("候选不重复", () => {
    const list = portCandidates(DEFAULT_PORT)
    expect(new Set(list).size).toBe(list.length)
  })
})

// vite.config.ts 不能 import 后端代码，只能把默认端口抄一份。两边漂移的后果是 dev 下
// 整个 /api 静默 502——没有任何报错，只是界面上什么都不动。这里把「抄的那份」钉住
describe("web/vite.config.ts 的默认端口与 DEFAULT_PORT 同步", () => {
  it("代理默认端口就是 DEFAULT_PORT", () => {
    const src = readFileSync(new URL("../../web/vite.config.ts", import.meta.url), "utf8")
    const match = src.match(/REPO_RADAR_PORT \|\| "(\d+)"/)
    expect(match?.[1]).toBe(String(DEFAULT_PORT))
  })
})
