import { App as AntdApp, Button, Input } from "antd"
import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n"
import { dirName, loadScanConfig, type OpenCommands } from "../lib/scanConfig"

const EMPTY_OPEN: OpenCommands = { editor: "", terminal: "", explorer: "" }
// 三个「打开方式」命令的行序与文案键；标签复用卡片上那三颗按钮的文案，不新造一套说法
const OPEN_ROWS: { key: keyof OpenCommands; tk: string }[] = [
  { key: "editor", tk: "card.editor" },
  { key: "terminal", tk: "card.terminal" },
  { key: "explorer", tk: "card.dir" },
]

/**
 * 扫描与打开方式：查看/编辑 config 里的 roots、excludes、open 三段，保存后触发全量重扫。
 * 这是设置弹窗里的一栏（不是自己开一层弹窗——弹层套弹层的旧结构见 git 历史）。
 * `open` 仍然是入参：它决定这一栏什么时候去拉配置——设置弹窗一开就拉一次，
 * 切栏不重拉（hidden 只藏不卸载，打字打到一半不会因为切栏被抹掉）。
 * 这是「zero-config」承诺的补全——下载即用的用户不该被迫去手改 JSON（还要懂反斜杠转义）。
 * 打开方式尤其：默认值 code / wt / explorer 是 Windows + VS Code 的组合，换个机器就是
 * 点了「在编辑器打开」毫无反应（openTarget 的失败只进控制台日志），而界面上原本无处可改。
 */
export function ScanConfigEditor({
  open,
  hidden,
  onClose,
  onSaved,
}: {
  open: boolean
  // 不在这一栏时只是藏起来、不卸载：切到别的栏再切回来，敲了一半还没保存的路径必须还在。
  // 条件挂载会把它连同 loaded/loadFailed 一起丢掉，用户看到的是自己刚输入的东西凭空消失
  hidden?: boolean
  onClose: () => void
  onSaved: () => void
}) {
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
  const [excludes, setExcludes] = useState<string[]>([])
  const [openCmds, setOpenCmds] = useState<OpenCommands>(EMPTY_OPEN)
  const [input, setInput] = useState("")
  const [exInput, setExInput] = useState("")
  const [saving, setSaving] = useState(false)
  // 现有配置加载成功前禁止保存：加载失败时列表是空的，此时保存会用「只有新输入那一条」的
  // roots 整体覆盖配置，把用户已有的扫描目录全部静默抹掉（excludes、open 同理）
  const [loaded, setLoaded] = useState(false)
  // 这次打开是否加载失败——单独于 loaded 之外：loaded=false 只表示「还不能保存」，
  // 不足以让界面区分「正在加载」和「加载失败、别再干等了」这两种要展示不同文案的状态
  const [loadFailed, setLoadFailed] = useState(false)
  // 点「重试」时自增，加进下面 effect 的依赖数组触发重新加载；不复用 open（它这次打开期间不变）
  const [reloadTick, setReloadTick] = useState(0)

  // biome-ignore-start lint/correctness/useExhaustiveDependencies: reloadTick 是「重试」心跳，本体不读它，
  // 只为在 open 不变的这次打开里再触发一次加载
  useEffect(() => {
    if (!open) return
    // 每次打开都要重置——之前只重置了 input/loaded，roots 从来没清过：重新打开弹窗、
    // 这次的 /api/config 又恰好失败时，界面显示的是上一次打开时加载到的旧列表，用户可能
    // 把它当成当前配置来编辑保存。列表必须先清空，加载成功后才重新填入
    setRoots([])
    setExcludes([])
    setOpenCmds(EMPTY_OPEN)
    setInput("")
    setExInput("")
    setLoaded(false)
    setLoadFailed(false)
    // cancelled 防止「快速关闭又重新打开」导致的乱序响应覆盖当前状态：没有它的话，第一次打开
    // 触发的 fetch 如果比第二次打开的 fetch 更晚回来，会用第一次（此刻已经过期）的结果
    // 覆盖第二次打开正确加载到的 roots/loaded，而这忠实反映的是已经关闭的那次弹窗的状态
    let cancelled = false
    loadScanConfig(fetch).then((res) => {
      if (cancelled) return
      if (res.status === "loaded") {
        setRoots(res.roots)
        setExcludes(res.excludes)
        setOpenCmds(res.open)
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
  }, [open, reloadTick])
  // biome-ignore-end lint/correctness/useExhaustiveDependencies: 重试心跳豁免块结束

  // 合并规则只此一份：去空白、空则忽略、重复项静默去重。
  // 「按回车/点添加」和「直接点保存」必须走同一套，否则将来改了归一化（比如去掉末尾斜杠）
  // 只改一处，两条路径就会存下不一样的值
  const merged = (list: string[], value: string) => {
    const v = value.trim()
    return v === "" || list.includes(v) ? list : [...list, v]
  }

  const save = async () => {
    // 输入框里敲了但没按回车/「添加」的路径也算数——首次引导的用户十有八九粘贴完直接点「保存并扫描」，
    // 静默丢掉它会让 zero-config 流程无声失败（保存了空 roots、扫出 0 个仓库）
    const next = merged(roots, input)
    const nextEx = merged(excludes, dirName(exInput))
    setSaving(true)
    try {
      const r = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: next, excludes: nextEx, open: openCmds }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      onClose()
      onSaved() // 保存即重扫：改了 roots/excludes 后看板必须立刻对上（open 不需要，但一起重扫无害）
    } catch (err) {
      message.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  // 一行一条、右侧 ✕ 移除；roots 与 excludes 两段共用。
  // 按下标而不是按值 key/删除：配置文件是手改的，里面完全可能有两条一样的路径，
  // 按值删会把重名的几条一起删掉——用户点的是其中一行，消失的是全部
  const list = (items: string[], remove: (i: number) => void, empty: string | null) => (
    <div className="rr-roots-list">
      {items.length === 0 && empty !== null && <div className="rr-roots-none">{empty}</div>}
      {items.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 路径可重复出现且整单编辑，行位即身份
        <div key={i} className="row">
          <span className="p">{p}</span>
          <button type="button" className="rm" title={t("common.remove")} onClick={() => remove(i)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )

  // 加载完成前禁用：/api/config 慢下来时（扫描是同步的，几百个仓库能把事件循环堵上几秒）
  // 用户敲进去的那条会被随后到达的响应整份覆盖掉，而保存一直是禁用的，他连提交的机会都没有
  const adder = (value: string, set: (v: string) => void, add: () => void, placeholder: string) => (
    <div style={{ display: "flex", gap: 8 }}>
      <Input
        size="small"
        value={value}
        disabled={!loaded}
        onChange={(e) => set(e.target.value)}
        onPressEnter={add}
        placeholder={placeholder}
        className="mono"
      />
      <Button size="small" disabled={!loaded} onClick={add}>
        {t("roots.add")}
      </Button>
    </div>
  )

  return (
    <div className="rr-scancfg" hidden={hidden}>
      {/* 加载失败：只留这一条说明 + 重试，三段一个都不渲染。空列表和空输入框会被读成
          「你还没配置过」「我的命令没了」，而实际情况是「不知道」——用户会跑去手改
          config.json 抢救一份根本没丢的配置。错误 toast 会自己消失，指望不上 */}
      {loadFailed ? (
        <div className="rr-roots-list">
          <div className="rr-roots-none">
            {t("roots.loadFailed")}{" "}
            <Button size="small" type="link" onClick={() => setReloadTick((v) => v + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="rr-sect first">{t("roots.title")}</div>
          <div className="rr-roots-hint">{t("roots.hint")}</div>
          {list(roots, (i) => setRoots(roots.filter((_, n) => n !== i)), t("roots.none"))}
          {adder(input, setInput, () => {
            setRoots(merged(roots, input))
            setInput("")
          }, t("roots.placeholder"))}

          <div className="rr-sect">{t("excludes.title")}</div>
          <div className="rr-roots-hint">{t("excludes.hint")}</div>
          {list(excludes, (i) => setExcludes(excludes.filter((_, n) => n !== i)), null)}
          {adder(exInput, setExInput, () => {
            setExcludes(merged(excludes, dirName(exInput)))
            setExInput("")
          }, t("excludes.placeholder"))}

          <div className="rr-sect">{t("open.title")}</div>
          <div className="rr-roots-hint">{t("open.hint")}</div>
          {OPEN_ROWS.map(({ key, tk }) => (
            <div key={key} className="rr-cmd-row">
              <span className="lb">{t(tk)}</span>
              <Input
                size="small"
                className="mono"
                value={openCmds[key]}
                disabled={!loaded}
                onChange={(e) => setOpenCmds({ ...openCmds, [key]: e.target.value })}
                placeholder={t("open.placeholder")}
              />
            </div>
          ))}
        </>
      )}
      {/* 保存按钮跟着这一栏走，不放进弹窗的公共 footer：这一栏是**显式保存**（改完要重扫才生效），
          而「常规」「系统」两栏的开关是即时生效的。公共 footer 会让人以为那些开关也要按了才算 */}
      <div className="rr-scancfg-foot">
        <Button type="primary" ghost loading={saving} disabled={!loaded} onClick={save}>
          {t("roots.saveScan")}
        </Button>
      </div>
    </div>
  )
}
