import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * 守卫：代码里 `t("…")` 用到的键，必须在 en.json 里存在。
 *
 * 现有的 i18n-parity 只保证「18 份 locale 的键集互相一致」，**不保证「代码用到的键都存在」**——
 * 而 translate() 在缺键时会把键本身当文案返回（`DICTS[lang]?.[key] ?? … ?? key`）。
 * 于是漏键的表象是界面上直接露出一个原始键名：实测 stash.log.pop / stash.log.apply
 * 这两个键从没进过任何 locale，stash 每 apply/pop 一次，活动日志里就多一条
 * 「✓ stash.log.pop」（还会落 localStorage 长期累积）。
 *
 * 这里把「用到即必须存在」变成可执行的检查：漏键当场转红，而不是等用户看到。
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src")
const dict = JSON.parse(readFileSync(join(srcDir, "i18n/locales/en.json"), "utf8")) as Record<string, string>

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

/** 取出 `t(...)` 第一个实参里的**字符串字面量**。
 *
 *  为什么不只找 `t("…")`：键也常写成三元（`t(c ? "a.b" : "c.d")`），那种写法正是
 *  漏键藏身的地方（stash.log.pop 就是这么写的）。所以先把第一个实参完整切出来再取字面量。
 *  模板字面量（含 `${}` 的）一律跳过——那是动态键，人工核对（见文件末尾的清单）。 */
function literalKeysOf(src: string): string[] {
  const keys: string[] = []
  const call = /(?<![\w$.])t\s*\(/g
  let m: RegExpExecArray | null
  while ((m = call.exec(src)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    let quote: string | null = null
    const arg: string[] = []
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]
      if (quote !== null) {
        arg.push(ch)
        if (ch === quote && src[i - 1] !== "\\") quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        arg.push(ch)
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++
      if (ch === ")" || ch === "]" || ch === "}") {
        depth--
        if (depth === 0) break
      }
      if (ch === "," && depth === 1) break // 第一个实参结束
      arg.push(ch)
    }
    const text = arg.join("")
    if (text.includes("`")) continue // 动态键，人工核对
    for (const lit of text.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const key = lit[1] ?? lit[2] ?? ""
      if (key.includes(".")) keys.push(key)
    }
  }
  return keys
}

describe("locale 键的实际使用", () => {
  it("代码里 t(\"…\") 用到的字面量键都在 en.json 里", () => {
    const missing: string[] = []
    for (const file of walk(srcDir)) {
      if (file.includes(join("i18n", "locales"))) continue
      for (const key of literalKeysOf(readFileSync(file, "utf8"))) {
        if (!(key in dict)) missing.push(`${key}  <- ${file.replace(srcDir, "src")}`)
      }
    }
    expect(missing).toEqual([])
  })

  // 动态键（有 ${} 的模板）扫不出来，人工核对时这份清单要一起更新。
  // 键的来源：web/src/lib/attention.ts 的 action.*、web/src/lib/healthText.ts 的 healthMsg.*、
  // web/src/lib/errText.ts 的 err.*、web/src/components/DetailPanel.tsx 的 detail.*Tip。
  it("动态键的取值都在 en.json 里", () => {
    const dynamic = [
      "action.fetch",
      "action.pull",
      "action.push",
      "detail.fetchTip",
      "detail.pullTip",
      "detail.pushTip",
      "healthMsg.conflicted",
      "healthMsg.noRemote",
      "healthMsg.detached",
      "healthMsg.dirty",
      "healthMsg.unpushed",
      "healthMsg.noUpstream",
      "healthMsg.behind",
      "healthMsg.stash",
      "healthMsg.stale",
      "err.nameInvalid",
      "err.parentMissing",
      "err.parentNotUnderRoot",
      "err.targetExists",
      "err.urlInvalid",
      "err.renameFailed",
      "err.ghMissing",
      "err.ghNotLoggedIn",
      "err.ghQueryFailed",
    ]
    expect(dynamic.filter((k) => !(k in dict))).toEqual([])
  })
})
