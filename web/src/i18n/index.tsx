import { createContext, useContext, useMemo, type ReactNode } from "react"

// 18 种语言，与 ChatGPT-Shortcut 一致；code 用于 <html lang> 与 locale 文件名
export const LANGS = [
  { code: "zh-Hans", name: "简体中文" },
  { code: "zh-Hant", name: "繁體中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "pt", name: "Português" },
  { code: "ru", name: "Русский" },
  { code: "it", name: "Italiano" },
  { code: "ar", name: "العربية" },
  { code: "hi", name: "हिन्दी" },
  { code: "bn", name: "বাংলা" },
  { code: "th", name: "ไทย" },
  { code: "tr", name: "Türkçe" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "id", name: "Bahasa Indonesia" },
] as const

export type LangCode = (typeof LANGS)[number]["code"]

type Dict = Record<string, string>
// 打包全部 locale JSON（每个约 100+ 短串，体量小）；缺失的语言在 t() 里回退
const modules = import.meta.glob<{ default: Dict }>("./locales/*.json", { eager: true })
const DICTS: Record<string, Dict> = {}
for (const [path, mod] of Object.entries(modules)) {
  const m = /\/([^/]+)\.json$/.exec(path)
  if (m) DICTS[m[1]] = mod.default
}

const DEFAULT: LangCode = "zh-Hans" // translate() 兜底链的最末一环
const INIT_FALLBACK: LangCode = "en" // 首访、且浏览器语言匹配不上任何支持语言时用英语（更通用）
const RTL = new Set<string>(["ar"])
export const isRtl = (lang: string): boolean => RTL.has(lang)

const SIMPLE = LANGS.map((l) => l.code).filter((c) => !c.includes("-")) as LangCode[] // 单子标签语言(en/ja/…)，zh 另按字形处理

/**
 * 把浏览器语言标签（BCP-47，按偏好顺序）匹配到支持的 18 种之一；都不匹配返回 null。
 * 中文按字形分流：zh-TW/HK/MO 或带 Hant → 繁体，其余 zh（zh-CN/SG/…）→ 简体；
 * 其余语言取主子标签匹配（en-US→en、pt-BR→pt）。取偏好列表里第一个能匹配上的。
 */
export function matchBrowserLang(tags: readonly string[]): LangCode | null {
  for (const raw of tags) {
    const tag = raw.toLowerCase()
    const exact = LANGS.find((l) => l.code.toLowerCase() === tag)
    if (exact) return exact.code
    if (tag.startsWith("zh")) return tag.includes("hant") || /-(tw|hk|mo)(-|$)/.test(tag) ? "zh-Hant" : "zh-Hans"
    const hit = SIMPLE.find((c) => c === tag.split("-")[0])
    if (hit) return hit
  }
  return null
}

export function readLang(): LangCode {
  try {
    const s = localStorage.getItem("rr.lang")
    if (s && LANGS.some((l) => l.code === s)) return s as LangCode // 已存偏好：尊重
  } catch {
    /* localStorage 不可用 */
  }
  // 首访无偏好：按浏览器语言对齐；匹配不上落到英语
  try {
    if (typeof navigator !== "undefined") {
      const tags = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
      const m = matchBrowserLang(tags)
      if (m) return m
    }
  } catch {
    /* navigator 不可用 */
  }
  return INIT_FALLBACK
}

export type TFunc = (key: string, params?: Record<string, string | number>) => string

function translate(lang: string, key: string, params?: Record<string, string | number>): string {
  let s = DICTS[lang]?.[key] ?? DICTS.en?.[key] ?? DICTS[DEFAULT]?.[key] ?? key
  // 替换值用函数形式：字符串形式的替换会解释 $&/$$ 等模式——仓库名/提交信息里带 $$ 会被吞成 $
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, () => String(v))
  return s
}

// 模块级当前语言，供非组件代码（如相对时间格式化）使用；Provider 挂载/切换时更新
let activeLang: LangCode = readLang()
export const gt: TFunc = (key, params) => translate(activeLang, key, params)
export const getLang = (): LangCode => activeLang

interface I18nCtx {
  lang: LangCode
  setLang: (l: LangCode) => void
  t: TFunc
}
const Ctx = createContext<I18nCtx>(null as unknown as I18nCtx)

// lang/setLang 由上层 Root 拥有（Root 同时把 dir 传给 antd ConfigProvider）。
// 这里同步镜像 activeLang（在渲染子组件之前），保证 gt()/relativeTime 当帧就用新语言；
// 用 useMemo 稳定 t 与 context value，避免非语言变更（如切主题）触发消费者重跑 effect。
export function I18nProvider({ lang, setLang, children }: { lang: LangCode; setLang: (l: LangCode) => void; children: ReactNode }) {
  activeLang = lang
  const t = useMemo<TFunc>(() => (key, params) => translate(lang, key, params), [lang])
  const value = useMemo<I18nCtx>(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useI18n = (): I18nCtx => useContext(Ctx)
export const useT = (): TFunc => useContext(Ctx).t
