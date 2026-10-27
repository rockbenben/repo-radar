import type { TFunc } from "../i18n"

// 服务端错误码 → err.* 词表键。与 healthText.ts 同一套路：服务端只回「出了什么事」，
// 至于怎么说，由界面按当前语言决定——界面有 18 种语言，服务端把中文写死的话，
// 英文/日文界面里会蹦出一句中文，而用户除了猜没别的办法。
//
// 码后面可以带一段细节，用冒号隔开（"renameFailed:EPERM"）：翻译时作为 {detail} 填进去。
const ERR_KEY: Record<string, string> = {
  nameInvalid: "err.nameInvalid",
  parentMissing: "err.parentMissing",
  parentNotUnderRoot: "err.parentNotUnderRoot",
  targetExists: "err.targetExists",
  urlInvalid: "err.urlInvalid",
  renameFailed: "err.renameFailed",
  ghMissing: "err.ghMissing",
  ghNotLoggedIn: "err.ghNotLoggedIn",
  ghQueryFailed: "err.ghQueryFailed",
  // 批量执行命令（服务端只回码，文案在这里）
  willExecute: "err.willExecute",
  execFailed: "err.execFailed",
  execTimeout: "err.execTimeout",
  execTimeoutOrphan: "err.execTimeoutOrphan",
}

/**
 * 服务端的错误字符串 → 当前语言的说明。
 * 不认识的码（原样透传的 git / gh 报错）原样显示——那里面有诊断价值，不能被吞掉。
 */
export function errText(t: TFunc, raw: string | null | undefined): string {
  if (!raw) return ""
  const sep = raw.indexOf(":")
  const code = sep >= 0 ? raw.slice(0, sep) : raw
  const detail = sep >= 0 ? raw.slice(sep + 1) : ""
  const key = ERR_KEY[code]
  if (!key) return raw
  return detail ? t(key, { detail }) : t(key)
}
