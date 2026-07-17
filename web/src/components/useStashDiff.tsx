import { Modal } from "antd"
import { type ReactNode, useRef, useState } from "react"
import type { TFunc } from "../i18n"
import { fetchStashDiff } from "../lib/stash"

/**
 * 复用于 StashView 与 DetailPanel 的 stash diff 弹窗：管理加载态、请求令牌与 Modal。
 * 令牌保证先后点两条时慢响应不覆盖新内容，且关闭后迟到的响应不会把弹窗重新打开。
 * 返回 view(打开某条 stash 的 diff) 与 node(挂到组件里的 Modal)。
 */
export function useStashDiff(t: TFunc, width = 800): { view: (repoId: string, sha: string, title: string) => Promise<void>; node: ReactNode } {
  const [state, setState] = useState<{ title: string; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const req = useRef(0)

  const view = async (repoId: string, sha: string, title: string) => {
    const id = ++req.current
    setState({ title, text: t("stash.diffLoading") })
    setOpen(true)
    const text = await fetchStashDiff(repoId, sha, t)
    if (id === req.current) setState({ title, text }) // 期间又点了别的、或已关闭：丢弃这次结果
  }

  const node = (
    <Modal
      open={open}
      onCancel={() => {
        req.current++ // 关闭即作废在途请求，别让迟到的响应重新弹开
        setOpen(false)
      }}
      footer={null}
      width={width}
      title={<span className="mono" style={{ color: "var(--hi)" }}>{state?.title}</span>}
      styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
    >
      <pre className="rr-exec-out">{state?.text}</pre>
    </Modal>
  )
  return { view, node }
}
