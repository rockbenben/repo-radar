import { describe, expect, it } from "vitest"
import { mainT, resolveLang } from "../src/i18n"

describe("resolveLang — 系统标签与 web lang 的归一", () => {
  it("精确 code、地区标签、大小写都能落到 18 语之一", () => {
    expect(resolveLang("zh-Hans")).toBe("zh-Hans")
    expect(resolveLang("zh-CN")).toBe("zh-Hans")
    expect(resolveLang("zh-TW")).toBe("zh-Hant")
    expect(resolveLang("zh-HK")).toBe("zh-Hant")
    expect(resolveLang("pt-BR")).toBe("pt")
    expect(resolveLang("en-US")).toBe("en")
    expect(resolveLang("ja-JP")).toBe("ja")
  })

  it("未知/空标签回退英语", () => {
    expect(resolveLang(undefined)).toBe("en")
    expect(resolveLang("xx-YY")).toBe("en")
    // 原型链上的键不是 locale（lang 来自 API，可能被任意字符串驱动）
    expect(resolveLang("constructor")).toBe("en")
    expect(resolveLang("__proto__")).toBe("en")
  })
})

describe("mainT — 主进程原生文案", () => {
  it("按语言取词，缺词回退英语", () => {
    expect(mainT("zh-Hans", "update.download")).toBe("下载")
    expect(mainT("zh-Hant", "update.download")).toBe("下載")
    expect(mainT("ar", "palette.more")).toBe("إجراءات إضافية")
    // 主进程直接读 web 的 locale 文件：stats.noStale 的德文改成了「超过 15 个活跃仓库才列出
    // 最少活跃的」，这里跟着新文案钉（断言的是「主进程能取到该语言的词」）
    expect(mainT("de", "stats.noStale")).toContain("Mehr als 15")
    expect(mainT("en", "does.not.exist")).toBe("does.not.exist")
  })

  it("占位符替换是单次替换，不会把错误文本里的花括号再解释一遍", () => {
    expect(mainT("en", "update.availableTitle", { version: "1.2.3" })).toBe("Version 1.2.3 is available")
    expect(mainT("en", "update.failedDetail", { err: "{version}" })).toBe("Couldn't reach the release server: {version}")
  })
})
