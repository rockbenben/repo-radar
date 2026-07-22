import { beforeEach, describe, expect, it } from "vitest"
import { syncActiveLang } from "../src/i18n"
import { relativeTime } from "../src/lib/time"

const NOW = new Date("2026-07-14T12:00:00Z").getTime()

// relativeTime 按当前界面语言本地化。每个用例前显式钉住语言，不依赖测试环境的 navigator/默认
// 回退——CI 的 jsdom 是 en-US，activeLang 会解析成 en，旧测试断言中文因此只在 CI 上挂。
beforeEach(() => syncActiveLang("zh-Hans"))

describe("relativeTime", () => {
  it("formats days ago", () => {
    expect(relativeTime("2026-07-11T12:00:00Z", NOW)).toBe("3天前")
  })
  it("formats months ago", () => {
    expect(relativeTime("2026-05-01T12:00:00Z", NOW)).toBe("2个月前")
  })
  it("formats just now", () => {
    expect(relativeTime("2026-07-14T11:59:40Z", NOW)).toBe("刚刚")
  })
  it("localizes to the active language", () => {
    syncActiveLang("en")
    expect(relativeTime("2026-07-11T12:00:00Z", NOW)).toBe("3 days ago")
  })
})
