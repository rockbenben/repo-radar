import ar from "../../web/src/i18n/locales/ar.json"
import bn from "../../web/src/i18n/locales/bn.json"
import de from "../../web/src/i18n/locales/de.json"
import en from "../../web/src/i18n/locales/en.json"
import es from "../../web/src/i18n/locales/es.json"
import fr from "../../web/src/i18n/locales/fr.json"
import hi from "../../web/src/i18n/locales/hi.json"
import id from "../../web/src/i18n/locales/id.json"
import it from "../../web/src/i18n/locales/it.json"
import ja from "../../web/src/i18n/locales/ja.json"
import ko from "../../web/src/i18n/locales/ko.json"
import pt from "../../web/src/i18n/locales/pt.json"
import ru from "../../web/src/i18n/locales/ru.json"
import th from "../../web/src/i18n/locales/th.json"
import tr from "../../web/src/i18n/locales/tr.json"
import vi from "../../web/src/i18n/locales/vi.json"
import zhHans from "../../web/src/i18n/locales/zh-Hans.json"
import zhHant from "../../web/src/i18n/locales/zh-Hant.json"

type Dict = Record<string, string>

const DICTS: Record<string, Dict> = {
  ar,
  bn,
  de,
  en,
  es,
  fr,
  hi,
  id,
  it,
  ja,
  ko,
  pt,
  ru,
  th,
  tr,
  vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
}

/** 把 BCP-47 标签（app.getLocale() 或 web 传来的 lang）归一到 18 个 locale 之一 */
export function resolveLang(tag: string | undefined): string {
  if (!tag) return "en"
  if (Object.hasOwn(DICTS, tag)) return tag
  const lower = tag.toLowerCase()
  if (lower.startsWith("zh")) return lower.includes("hant") || /-(tw|hk|mo)(-|$)/.test(lower) ? "zh-Hant" : "zh-Hans"
  const base = lower.split("-")[0]
  return Object.hasOwn(DICTS, base) ? base : "en"
}

/** 主进程侧取词：与 web 的 t() 一样用 {key} 占位，缺语言回退英语 */
export function mainT(tag: string | undefined, key: string, params?: Record<string, string | number>): string {
  const lang = resolveLang(tag)
  let s = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, () => String(v))
  return s
}
