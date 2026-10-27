import type { TFunc } from "../i18n"
import type { HealthIssue } from "../types"

// 健康规则 → healthMsg.* 词表键。详情与卡片共用这一份，新增规则只改这里。
const HEALTH_KEY: Record<string, string> = {
  conflicted: "conflicted",
  "no-remote": "noRemote",
  "detached-head": "detached",
  dirty: "dirty",
  unpushed: "unpushed",
  "no-upstream": "noUpstream",
  behind: "behind",
  "stash-left": "stash",
  stale: "stale",
}

/** 把服务端健康规则译成当前语言的完整描述；数字仍从服务端原文里取。 */
export function healthMessage(t: TFunc, h: HealthIssue): string {
  const key = HEALTH_KEY[h.rule]
  return key ? t(`healthMsg.${key}`, { n: h.message.match(/\d+/)?.[0] ?? "" }) : h.message
}
