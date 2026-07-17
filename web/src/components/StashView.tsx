import { App as AntdApp, Button, Checkbox } from "antd"
import { useEffect, useMemo, useState } from "react"
import { gt, useT } from "../i18n"
import { cleanStashMessage } from "../lib/meta"
import { runStashApplyPop } from "../lib/stash"
import { relativeTime } from "../lib/time"
import type { RepoStashes, StashEntry } from "../types"
import { StashActions } from "./StashActions"
import { useStashDiff } from "./useStashDiff"

const JSON_HEADERS = { "content-type": "application/json" }
// 选择键：仓库 id + stash sha。sha 在仓库内唯一且不受丢弃/弹出后的重新编号影响（index 会漂移，故不用）
const skey = (repoId: string, sha: string) => `${repoId}:${sha}`

type DropItem = { repoId: string; sha: string; name: string }

export function StashView({ onLog }: { onLog: (ok: boolean, text: string) => void }) {
  const { message, modal } = AntdApp.useApp()
  const t = useT()
  const [data, setData] = useState<RepoStashes[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { view: viewStashDiff, node: diffNode } = useStashDiff(t, 820)

  const load = async (isInitial = false) => {
    try {
      const r = await fetch("/api/stashes")
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { repos: RepoStashes[] }
      setData(body.repos)
      setError(null)
      // 丢弃已消失的选择，避免残留幽灵选中
      setSel((prev) => {
        const live = new Set(body.repos.flatMap((g) => g.stashes.map((s) => skey(g.id, s.sha))))
        const next = new Set([...prev].filter((k) => live.has(k)))
        return next.size === prev.size ? prev : next
      })
    } catch (err) {
      // 初次加载失败才占满整屏；动作后重取失败只弹提示、保留现有列表，别把有效数据整片抹掉
      if (isInitial) setError(gt("stash.loadFail", { err: String(err) }))
      else message.warning(gt("stash.loadFail", { err: String(err) }))
    }
  }
  // 仅挂载时取一次；后续动作各自 await load() 刷新
  useEffect(() => {
    void load(true)
  }, [])

  const groups = data ?? []
  const total = useMemo(() => groups.reduce((s, g) => s + g.stashes.length, 0), [groups])
  const allKeys = useMemo(() => groups.flatMap((g) => g.stashes.map((s) => skey(g.id, s.sha))), [groups])

  const toggle = (k: string) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const viewDiff = (g: RepoStashes, sha: string) => viewStashDiff(g.id, sha, t("stash.diffTitle", { repo: g.displayName ?? g.name }))

  const single = async (g: RepoStashes, s: StashEntry, action: "apply" | "pop") => {
    setBusy(true)
    try {
      await runStashApplyPop(g.id, s.sha, action, g.displayName ?? g.name, { t, message, onLog })
    } finally {
      setBusy(false)
      await load()
    }
  }

  const confirmDrop = (items: DropItem[]) => {
    if (items.length === 0) return
    modal.confirm({
      title: t("stash.dropConfirmTitle", { n: items.length }),
      content: t("stash.dropConfirmBody"),
      okText: t("stash.dropConfirmOk"),
      okButtonProps: { danger: true },
      cancelText: t("modal.cancel"),
      onOk: async () => {
        setBusy(true)
        try {
          const r = await fetch("/api/stash/batch", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ action: "drop", items: items.map(({ repoId, sha }) => ({ repoId, sha })) }),
          })
          const body = (await r.json()) as { results: { repoId?: string; sha?: string; ok: boolean; message?: string }[] }
          const ok = body.results.filter((x) => x.ok).length
          const fails = body.results.filter((x) => !x.ok)
          const names = [...new Set(items.map((i) => i.name))].join("、")
          if (ok > 0) message.success(t("stash.dropOk", { n: ok }))
          if (fails.length > 0) {
            // 如实报「失败几条 + 首条原因」，别把批量失败说成只一条
            const err = fails.length > 1 ? `${fails.length} · ${fails[0].message ?? ""}` : (fails[0].message ?? "")
            message.warning(t("stash.actionFail", { err }))
          }
          onLog(ok > 0 && fails.length === 0, t("stash.log.drop", { name: names, n: ok }))
          // 只取消本次涉及的选择，别把用户在别处勾的也一并清空
          const requested = new Set(items.map((i) => skey(i.repoId, i.sha)))
          setSel((prev) => new Set([...prev].filter((k) => !requested.has(k))))
        } catch (err) {
          message.error(t("stash.actionFail", { err: String(err) }))
        } finally {
          setBusy(false)
          await load()
        }
      },
    })
  }

  const dropSelected = () =>
    confirmDrop(
      groups.flatMap((g) =>
        g.stashes.filter((s) => sel.has(skey(g.id, s.sha))).map((s) => ({ repoId: g.id, sha: s.sha, name: g.displayName ?? g.name })),
      ),
    )

  if (error) return <div className="rr-empty err">{error}</div>
  if (data === null) return <div className="rr-empty">{t("stash.loading")}</div>
  if (total === 0) return <div className="rr-empty">{t("stash.empty")}</div>

  const selCount = sel.size
  return (
    <div className="rr-stash">
      <div className="rr-stash-bar">
        <span className="sum">{t("stash.count", { n: total, repos: groups.length })}</span>
        <Checkbox
          checked={selCount > 0 && selCount === allKeys.length}
          indeterminate={selCount > 0 && selCount < allKeys.length}
          onChange={(e) => setSel(e.target.checked ? new Set(allKeys) : new Set())}
        >
          {t("stash.selectAll")}
        </Checkbox>
        <Button size="small" danger disabled={selCount === 0 || busy} onClick={dropSelected}>
          {t("stash.dropSelected", { n: selCount })}
        </Button>
      </div>

      {groups.map((g) => (
        <section key={g.id} className="rr-stash-repo">
          <div className="rr-ghd">
            <span className="nm">{g.displayName ?? g.name}</span>
            <span className="ct">{g.stashes.length}</span>
            <span className="ln" />
          </div>
          {g.stashes.map((s, i) => {
            const k = skey(g.id, s.sha)
            // key 带上序号：极罕见地两条 stash 撞同一 sha 时也不会 React key 重复（它们字节相同，勾选联动可接受）
            return (
              <div className={`rr-stash-row${sel.has(k) ? " on" : ""}`} key={`${s.sha}:${i}`}>
                <Checkbox checked={sel.has(k)} onChange={() => toggle(k)} />
                <span className="age">{s.date ? relativeTime(s.date) : ""}</span>
                {s.branch && <span className="br">{t("stash.onBranch", { branch: s.branch })}</span>}
                <span className="msg" title={s.message}>
                  {cleanStashMessage(s.message)}
                </span>
                <span className="stat">{t("stash.files", { files: s.files, ins: s.insertions, del: s.deletions })}</span>
                <span className="acts">
                  <StashActions
                    t={t}
                    busy={busy}
                    onDiff={() => viewDiff(g, s.sha)}
                    onApply={() => single(g, s, "apply")}
                    onPop={() => single(g, s, "pop")}
                    onDrop={() => confirmDrop([{ repoId: g.id, sha: s.sha, name: g.displayName ?? g.name }])}
                  />
                </span>
              </div>
            )
          })}
        </section>
      ))}

      {diffNode}
    </div>
  )
}
