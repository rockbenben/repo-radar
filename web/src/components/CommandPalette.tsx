import { Button, Modal } from "antd"
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
      styles={{ body: { padding: 0 } }}
      style={{ top: 120 }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, results.length - 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === "Enter") {
              pick(results[sel])
            }
          }}
          placeholder={t("palette.placeholder")}
          className="mono"
          style={{
            width: "100%",
            background: "transparent",
            border: 0,
            outline: 0,
            color: "var(--hi)",
            fontSize: 15,
          }}
        />
      </div>
      <div style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
        {results.length === 0 && (
          <div style={{ padding: "28px 0", textAlign: "center", color: "var(--dim)", fontSize: 13 }}>{t("palette.noMatch")}</div>
        )}
        {results.map((r, i) => (
          <div
            key={r.id}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(r)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              borderRadius: 8,
              cursor: "pointer",
              background: i === sel ? "var(--panel)" : "transparent",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: sev(r), flex: "none" }} />
            <span className="mono" style={{ color: "var(--hi)", fontSize: 13, flex: "none" }}>
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
            <span style={{ display: "flex", gap: 4, flex: "none" }} onClick={(e) => e.stopPropagation()}>
              {(["editor", "terminal", "explorer"] as const).map((tgt) => (
                <Button
                  key={tgt}
                  size="small"
                  onClick={() => {
                    onOpen(r.id, tgt)
                    onClose()
                  }}
                >
                  {t(tgt === "editor" ? "card.editor" : tgt === "terminal" ? "card.terminal" : "card.dir")}
                </Button>
              ))}
              <Button size="small" title={r.path} onClick={() => onCopyPath(r.path)}>
                {t("card.copy")}
              </Button>
              {remoteWeb(r.remotes) && (
                <Button
                  size="small"
                  onClick={() => {
                    const web = remoteWeb(r.remotes)
                    if (web) window.open(web.url, "_blank", "noreferrer")
                  }}
                >
                  {t("palette.remote")}
                </Button>
              )}
            </span>
          </div>
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
