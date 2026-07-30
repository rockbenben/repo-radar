import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { LANGS } from "../src/i18n"

/**
 * 18 份 locale 的「键位齐备 + 占位符一致」是这个项目在维护的不变量，但一直没有守卫，
 * 于是 settings.watchLimitCappedNoRescan 只落在 en / zh-Hans 两份里：其余 16 种语言下
 * 这行提示会经 t() 的兜底链退成英文原文，日文/俄文/阿拉伯文界面里突兀地插一句英文
 * （阿拉伯语还会与 RTL 布局叠加）。而它相邻的 settings.watchLimitCapped 18 种齐全——
 * 同一行提示「关掉兜底重扫就变英文」，靠肉眼是发现不了的。
 * 这条测试让下次漏键当场转红，而不是等用户看到英文。
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/i18n/locales")
const dicts = new Map<string, Record<string, string>>(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>]),
)

// 占位符形如 {watched}；漏一个或写错名字，界面上会直接露出 "{total}" 这样的字面量
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("locale 齐备性", () => {
  it("每种支持语言都有对应的 locale 文件，且没有多余文件", () => {
    expect([...dicts.keys()].sort()).toEqual(LANGS.map((l) => l.code).sort())
  })

  it("18 份 locale 的键集完全一致", () => {
    const base = [...dicts.keys()][0]
    const baseKeys = Object.keys(dicts.get(base)!).sort()
    for (const [code, dict] of dicts) {
      const keys = Object.keys(dict).sort()
      // 断言写成「缺了什么 / 多了什么」而不是裸的 toEqual：整份键集对不上时的 diff
      // 有几百行，读不出到底是哪个键漏了
      expect({ code, missing: baseKeys.filter((k) => !keys.includes(k)), extra: keys.filter((k) => !baseKeys.includes(k)) })
        .toEqual({ code, missing: [], extra: [] })
    }
  })

  it("同一个键在 18 份 locale 里的占位符集合一致", () => {
    const base = [...dicts.keys()][0]
    const baseDict = dicts.get(base)!
    for (const [code, dict] of dicts) {
      for (const [key, value] of Object.entries(baseDict)) {
        const mine = dict[key]
        if (mine === undefined) continue // 键缺失由上一条负责报，这里不重复失败
        expect({ code, key, ph: placeholders(mine) }).toEqual({ code, key, ph: placeholders(value) })
      }
    }
  })
})
