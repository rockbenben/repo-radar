import { Button } from "antd"
import type { TFunc } from "../i18n"

/**
 * 一条 stash 的操作按钮组（查看 diff / apply / pop / drop），StashView 与 DetailPanel 共用。
 * busy：任一 stash 操作进行中，禁用全部按钮，避免并发导致刷新错位；loading：本行正在执行，显示 spinner。
 */
export function StashActions({
  t,
  busy,
  loading = false,
  onDiff,
  onApply,
  onPop,
  onDrop,
}: {
  t: TFunc
  busy: boolean
  loading?: boolean
  onDiff: () => void
  onApply: () => void
  onPop: () => void
  onDrop: () => void
}) {
  return (
    <>
      <Button size="small" type="text" disabled={busy} onClick={onDiff}>
        {t("stash.viewDiff")}
      </Button>
      <Button size="small" type="text" disabled={busy} loading={loading} onClick={onApply}>
        {t("stash.apply")}
      </Button>
      <Button size="small" type="text" disabled={busy} loading={loading} onClick={onPop}>
        {t("stash.pop")}
      </Button>
      <Button size="small" type="text" danger disabled={busy} loading={loading} onClick={onDrop}>
        {t("stash.drop")}
      </Button>
    </>
  )
}
