import { describe, expect, it } from "vitest"
import { resolveEmptyArea } from "../src/lib/emptyState"

describe("resolveEmptyArea", () => {
  it("hidden：有 loadError 或正在 scanning 时让位给各自的状态展示", () => {
    expect(resolveEmptyArea({ loadError: "boom", scanning: false, hasRoots: true, reposCount: 0 })).toBe("hidden")
    expect(resolveEmptyArea({ loadError: null, scanning: true, hasRoots: true, reposCount: 0 })).toBe("hidden")
  })

  it("list：已经有仓库卡片时不用再判断 hasRoots，交给卡片本身撑起页面", () => {
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: null, reposCount: 3 })).toBe("list")
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: "unknown", reposCount: 3 })).toBe("list")
  })

  // 缺陷 2 之一：请求悬而未决（hasRoots 还是 null）时不能什么都不渲染，也不能显示欢迎文案——
  // 只是还没等到结果，跟"确知没配置过"是两回事
  it("loading：hasRoots 还没拉到（挂载首帧/请求悬而未决），不是欢迎页也不是空白", () => {
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: null, reposCount: 0 })).toBe("loading")
  })

  // 缺陷 2 之二：配置请求确实失败了，不能冒充「首次运行」欢迎页去骗一个用了半年的老用户
  it('configError：hasRoots = "unknown"（请求确实失败）走明确的错误态，不是欢迎页', () => {
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: "unknown", reposCount: 0 })).toBe("configError")
  })

  it("welcome：只有确知没配置过（hasRoots === false）才展示首次运行文案", () => {
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: false, reposCount: 0 })).toBe("welcome")
  })

  it("list：确知配置过但扫出 0 个仓库——交给「未发现仓库」空状态列表分支，不是欢迎页", () => {
    expect(resolveEmptyArea({ loadError: null, scanning: false, hasRoots: true, reposCount: 0 })).toBe("list")
  })
})
