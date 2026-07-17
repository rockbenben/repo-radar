import { describe, expect, it } from "vitest"
import { matchBrowserLang } from "../src/i18n"

describe("matchBrowserLang", () => {
  it("routes Chinese by script/region", () => {
    expect(matchBrowserLang(["zh-TW"])).toBe("zh-Hant")
    expect(matchBrowserLang(["zh-HK"])).toBe("zh-Hant")
    expect(matchBrowserLang(["zh-MO"])).toBe("zh-Hant")
    expect(matchBrowserLang(["zh-Hant"])).toBe("zh-Hant")
    expect(matchBrowserLang(["zh-Hant-TW"])).toBe("zh-Hant")
    expect(matchBrowserLang(["zh-CN"])).toBe("zh-Hans")
    expect(matchBrowserLang(["zh-SG"])).toBe("zh-Hans")
    expect(matchBrowserLang(["zh"])).toBe("zh-Hans")
  })

  it("matches by primary subtag for regional variants", () => {
    expect(matchBrowserLang(["en-US"])).toBe("en")
    expect(matchBrowserLang(["en-GB"])).toBe("en")
    expect(matchBrowserLang(["pt-BR"])).toBe("pt")
    expect(matchBrowserLang(["ja-JP"])).toBe("ja")
    expect(matchBrowserLang(["fr"])).toBe("fr")
  })

  it("takes the first matching tag in preference order, skipping unsupported", () => {
    expect(matchBrowserLang(["xx", "de-DE", "fr"])).toBe("de")
  })

  it("returns null when nothing matches (caller falls back to en)", () => {
    expect(matchBrowserLang(["xx"])).toBeNull()
    expect(matchBrowserLang(["sv-SE", "nl"])).toBeNull()
    expect(matchBrowserLang([])).toBeNull()
  })
})
