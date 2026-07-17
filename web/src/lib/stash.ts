import { App as AntdApp } from "antd"
import type { TFunc } from "../i18n"

const JSON_HEADERS = { "content-type": "application/json" }
type MsgApi = ReturnType<typeof AntdApp.useApp>["message"]

// 取某条 stash 的 diff 文本（收纳箱与详情面板共用）：404→已不存在；其它非 2xx→如实显示错误（不当成空）；200 空→无改动。
export async function fetchStashDiff(repoId: string, sha: string, t: TFunc): Promise<string> {
  try {
    const r = await fetch(`/api/repos/${repoId}/stash/${sha}/diff`)
    if (!r.ok) {
      const eb = (await r.json().catch(() => ({}))) as { error?: string }
      return r.status === 404 ? t("stash.diffGone") : (eb.error ?? `HTTP ${r.status}`)
    }
    const body = (await r.json()) as { diff?: string }
    return body.diff && body.diff !== "" ? body.diff : t("stash.diffEmpty")
  } catch (err) {
    return String(err)
  }
}

// 单条 stash 的 apply/pop：请求 + 结果处理（收纳箱与详情面板共用，保证两处 UX 一致）。
// 忙碌态与后续刷新由各调用方自己管（它们用不同的 state/刷新方式）。
export async function runStashApplyPop(
  repoId: string,
  sha: string,
  action: "apply" | "pop",
  label: string,
  ctx: { t: TFunc; message: MsgApi; onLog: (ok: boolean, text: string) => void },
): Promise<void> {
  const { t, message, onLog } = ctx
  try {
    const r = await fetch(`/api/repos/${repoId}/stash`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action, sha }) })
    // 4xx/5xx 返回的是 { error }，没有 result；用可选链取，别在 result 缺失时抛 TypeError
    const body = (await r.json()) as { result?: { ok: boolean; message: string; conflict?: boolean }; error?: string }
    const res = body.result
    if (res?.ok) {
      message.success(action === "pop" ? t("stash.popOk") : t("stash.applyOk"))
      onLog(true, t(action === "pop" ? "stash.log.pop" : "stash.log.apply", { name: label }))
    } else if (res?.conflict) {
      // 撞冲突：改动已带标记应用、stash 保留——明确提示「需手动解决」，别让用户误以为没生效
      message.warning(t("stash.conflict"))
      onLog(false, `${label} · ${t("stash.conflict")}`)
    } else {
      const err = res?.message ?? body.error ?? `HTTP ${r.status}`
      message.warning(t("stash.actionFail", { err }))
      onLog(false, t("stash.actionFail", { err: `${label}: ${err}` }))
    }
  } catch (err) {
    message.error(t("stash.actionFail", { err: String(err) }))
  }
}
