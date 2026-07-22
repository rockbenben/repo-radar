import { App as AntdApp, Button, Input, Modal } from "antd"
import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n"
import { loadRoots } from "../lib/rootsEditor"

/**
 * 扫描目录管理：查看/添加/删除 config.roots，保存后触发全量重扫。
 * 这是「zero-config」承诺的补全——下载即用的用户不该被迫去手改 JSON（还要懂反斜杠转义）。
 */
export function RootsEditor({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const { message } = AntdApp.useApp()
  // t 由 I18nProvider 的 useMemo 在语言变化时重建（见 web/src/i18n/index.tsx），
  // message 也可能不是稳定引用——两者都不该出现在下面加载 effect 的依赖数组里：
  // 之前 t 在依赖数组里，切换界面语言会让这个 effect 重跑，而它第一件事就是 setRoots([])，
  // 用户在对话框里敲了一半、还没保存的扫描目录会被无声清空。改用 ref 持有最新值，
  // effect 内部读 ref，只由 open/reloadTick 决定要不要重新加载
  const tRef = useRef(t)
  tRef.current = t
  const messageRef = useRef(message)
  messageRef.current = message
  const [roots, setRoots] = useState<string[]>([])
  const [input, setInput] = useState("")
  const [saving, setSaving] = useState(false)
  // 现有 roots 加载成功前禁止保存：加载失败时列表是空的，此时保存会用「只有新输入那一条」的
  // roots 整体覆盖配置，把用户已有的扫描目录全部静默抹掉
  const [loaded, setLoaded] = useState(false)
  // 这次打开是否加载失败——单独于 loaded 之外：loaded=false 只表示「还不能保存」，
  // 不足以让界面区分「正在加载」和「加载失败、别再干等了」这两种要展示不同文案的状态
  const [loadFailed, setLoadFailed] = useState(false)
  // 点「重试」时自增，加进下面 effect 的依赖数组触发重新加载；不复用 open（它这次打开期间不变）
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!open) return
    // 每次打开都要重置 roots——之前只重置了 input/loaded，roots 从来没清过：重新打开弹窗、
    // 这次的 /api/config 又恰好失败时，界面显示的是上一次打开时加载到的旧列表，用户可能
    // 把它当成当前配置来编辑保存。列表必须先清空，加载成功后才重新填入
    setRoots([])
    setInput("")
    setLoaded(false)
    setLoadFailed(false)
    // cancelled 防止「快速关闭又重新打开」导致的乱序响应覆盖当前状态：没有它的话，第一次打开
    // 触发的 fetch 如果比第二次打开的 fetch 更晚回来，会用第一次（此刻已经过期）的结果
    // 覆盖第二次打开正确加载到的 roots/loaded，而这忠实反映的是已经关闭的那次弹窗的状态
    let cancelled = false
    loadRoots(fetch).then((res) => {
      if (cancelled) return
      if (res.status === "loaded") {
        setRoots(res.roots)
        setLoaded(true)
      } else {
        setLoadFailed(true)
        messageRef.current.error(tRef.current("msg.loadError", { err: res.message }))
      }
    })
    return () => {
      cancelled = true
    }
    // 故意不把 t/message 放进依赖数组——见上面 tRef/messageRef 的注释：这个 effect 只该在
    // 弹窗开关或点了「重试」时重新加载，语言切换不该触发它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reloadTick])

  // 合并规则只此一份：去空白、空则忽略、重复路径静默去重。
  // 「按回车/点添加」和「直接点保存」必须走同一套，否则将来改了归一化（比如去掉末尾斜杠）
  // 只改一处，两条路径就会存下不一样的 roots
  const merged = (list: string[], value: string) => {
    const v = value.trim()
    return v === "" || list.includes(v) ? list : [...list, v]
  }

  const add = () => {
    setRoots(merged(roots, input))
    setInput("")
  }

  const save = async () => {
    // 输入框里敲了但没按回车/「添加」的路径也算数——首次引导的用户十有八九粘贴完直接点「保存并扫描」，
    // 静默丢掉它会让 zero-config 流程无声失败（保存了空 roots、扫出 0 个仓库）
    const next = merged(roots, input)
    setSaving(true)
    try {
      const r = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: next }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      onClose()
      onSaved() // 保存即重扫，让新目录立刻出现在看板
    } catch (err) {
      message.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={t("roots.title")}
      width={560}
      footer={
        <Button type="primary" ghost loading={saving} disabled={!loaded} onClick={save}>
          {t("roots.saveScan")}
        </Button>
      }
    >
      <div className="rr-roots-hint">{t("roots.hint")}</div>
      {loadFailed ? (
        // 加载失败：明确说明，不能落到「roots 为空」的展示分支——那会被读成「你还没配置过」，
        // 而实际情况是「不知道」。给一个重试入口，不悄悄显示上一次打开时加载到的旧数据
        <div className="rr-roots-list">
          <div className="rr-roots-none">
            {t("roots.loadFailed")}{" "}
            <Button size="small" type="link" onClick={() => setReloadTick((v) => v + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rr-roots-list">
          {roots.length === 0 && <div className="rr-roots-none">{t("roots.none")}</div>}
          {roots.map((p) => (
            <div key={p} className="row">
              <span className="p">{p}</span>
              <button className="rm" title={t("common.remove")} onClick={() => setRoots(roots.filter((x) => x !== p))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Input
          size="small"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={add}
          placeholder={t("roots.placeholder")}
          className="mono"
        />
        <Button size="small" onClick={add}>
          {t("roots.add")}
        </Button>
      </div>
    </Modal>
  )
}
