import { Button, Dropdown, Modal } from "antd"
import { useEffect, useMemo, useRef, useState } from "react"
import { useT } from "../i18n"
import { remoteWeb } from "../lib/meta"
import type { RepoStatus } from "../types"

function sev(r: RepoStatus): string {
  if (r.error || r.health.some((h) => h.severity === "error")) return "var(--crit)"
  if (r.health.some((h) => h.severity === "warn")) return "var(--warn)"
  return "var(--ok)"
}

export function CommandPalette({
  open,
  repos,
  onClose,
  onOpen,
  onCopyPath,
}: {
  open: boolean
  repos: RepoStatus[]
  onClose: () => void
  onOpen: (id: string, target: "editor" | "terminal" | "explorer") => void
  onCopyPath: (path: string) => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setSel(0)
      // 打开后聚焦输入框
      const t = setTimeout(() => inputRef.current?.focus(), 60)
      return () => clearTimeout(t)
    }
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (r: RepoStatus) =>
      q === "" ||
      r.name.toLowerCase().includes(q) ||
      (r.displayName ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q) ||
      r.path.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q))
    return repos.filter(match).slice(0, 8)
  }, [repos, query])

  const selectedIndex = Math.min(sel, results.length - 1)

  // ⌘K 是启动器：选中回车 / 点整行都直接用编辑器打开
  const pick = (r: RepoStatus | undefined) => {
    if (!r) return
    onOpen(r.id, "editor")
    onClose()
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      centered
      title={t("palette.title")}
      classNames={{ container: "rr-palette-container", body: "rr-palette-body" }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
        <input
          ref={inputRef}
          role="combobox"
          aria-label={t("palette.placeholder")}
          aria-expanded={results.length > 0}
          aria-controls="rr-palette-list"
          aria-activedescendant={selectedIndex >= 0 ? `rr-palette-opt-${selectedIndex}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || selectedIndex < 0) return
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const next = e.key === "ArrowDown"
                ? Math.min(selectedIndex + 1, results.length - 1)
                : Math.max(selectedIndex - 1, 0)
              setSel(next)
              document.getElementById(`rr-palette-opt-${next}`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
            } else if (e.key === "Enter") {
              pick(results[selectedIndex])
            }
          }}
          placeholder={t("palette.placeholder")}
          className="mono rr-palette-input"
        />
      </div>
      <div className="rr-palette-results" role="listbox" id="rr-palette-list" aria-label={t("palette.placeholder")}>
        {results.length === 0 && (
          <div style={{ padding: "28px 0", textAlign: "center", color: "var(--dim)", fontSize: 13 }}>{t("palette.noMatch")}</div>
        )}
        {results.map((r, i) => (
          // biome-ignore-start lint/a11y/useKeyWithClickEvents: 键盘路径按 WAI-ARIA 组合框模式
          // 收在顶部输入框上（↑/↓/Enter），行本身不做焦点落点——每行挂 tabIndex 反而把
          // 「8 行 × 每行几个动作按钮」塞进 Tab 序列，破坏 ⌘K 直达的用法
          <div
            key={r.id}
            role="option"
            id={`rr-palette-opt-${i}`}
            tabIndex={-1}
            aria-selected={i === selectedIndex}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(r)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              borderRadius: 8,
              cursor: "pointer",
              background: i === selectedIndex ? "var(--seg-sel)" : "transparent",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: sev(r), flex: "none" }} />
            <span className="mono" style={{ color: "var(--hi)", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.name}
            </span>
            <span
              style={{
                color: "var(--dim)",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {r.description ?? r.displayName ?? ""}
            </span>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: 这层只是把按钮群的点击与行的
                「直接用编辑器打开」隔开，交互全在内部的真 Button / 下拉菜单项上 */}
            <span style={{ display: "flex", gap: 4, flex: "none" }} role="presentation" onClick={(e) => e.stopPropagation()}>
              {/* 主按钮「编辑器」直出（与 Enter 同义），其余四颗收进 ⋯ 下拉（B-U2）——
                  五颗文字按钮把行高撑大、把描述挤到 ~10 字，而描述正是搜索后确认「找对仓了吗」的关键 */}
              <Button size="small" type="primary" ghost onClick={() => { onOpen(r.id, "editor"); onClose() }}>
                {t("card.editor")}
              </Button>
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "terminal", label: t("card.terminal") },
                    { key: "explorer", label: t("card.dir") },
                    { key: "copy", label: t("card.copy") },
                    ...(remoteWeb(r.remotes) ? [{ key: "remote", label: t("palette.remote") }] : []),
                  ],
                  onClick: ({ key }) => {
                    if (key === "terminal") onOpen(r.id, "terminal")
                    else if (key === "explorer") onOpen(r.id, "explorer")
                    else if (key === "copy") onCopyPath(r.path)
                    else if (key === "remote") {
                      const web = remoteWeb(r.remotes)
                      if (web) window.open(web.url, "_blank", "noreferrer")
                    }
                    if (key !== "copy") onClose() // 复制不关面板，就地再选
                  },
                }}
              >
                <Button size="small" className="rr-palette-more" aria-label={t("palette.more")} title={t("palette.more")}>
                  ⋯
                </Button>
              </Dropdown>
            </span>
          </div>
          // biome-ignore-end lint/a11y/useKeyWithClickEvents: 行的豁免块结束
        ))}
      </div>
      <div
        className="mono"
        style={{ padding: "8px 16px", borderTop: "1px solid var(--line)", color: "var(--dim)", fontSize: 10.5 }}
      >
        {t("palette.hint")}
      </div>
    </Modal>
  )
}
