import { getLang, gt } from "../i18n"

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400_000],
  ["month", 30 * 86400_000],
  ["week", 7 * 86400_000],
  ["day", 86400_000],
  ["hour", 3600_000],
  ["minute", 60_000],
]

// 相对时间用 Intl.RelativeTimeFormat 按当前语言原生本地化（18 种语言无需手工翻译单位）；
// 不足 1 分钟用词条 time.now（保留「刚刚」这类措辞）。按语言缓存 formatter。
const cache = new Map<string, Intl.RelativeTimeFormat>()
function rtf(): Intl.RelativeTimeFormat {
  const lang = getLang()
  let f = cache.get(lang)
  if (!f) {
    f = new Intl.RelativeTimeFormat(lang, { numeric: "always" })
    cache.set(lang, f)
  }
  return f
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf().format(Math.round(diff / ms), unit)
  }
  return gt("time.now")
}

// 本地时区的 YYYY-MM-DD（热力图分桶、工作记录日期选择共用）
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
