import { App as AntdApp, AutoComplete, Button, Checkbox, Input, Modal, Select, Tag } from "antd"
import { useEffect, useState } from "react"
import { type TFunc, useT } from "../i18n"
import { cleanStashMessage, isSideBranch, langColor, remoteWeb } from "../lib/meta"
import { runStashApplyPop } from "../lib/stash"
import { relativeTime } from "../lib/time"
import type { CommitInfo, GithubStatus, HealthIssue, HeatmapDay, RepoStatus, StashEntry } from "../types"
import { Heatmap } from "./Heatmap"
import { StashActions } from "./StashActions"
import { useStashDiff } from "./useStashDiff"

const NEW_BRANCH = " new-branch" // 分支下拉里「新建分支」选项的哨兵值（不会与真实分支名撞）

type DetailData = { recentCommits: CommitInfo[]; stashes: StashEntry[]; branches: string[]; remoteBranches: string[] }
const EMPTY_DETAIL: DetailData = { recentCommits: [], stashes: [], branches: [], remoteBranches: [] }
type MutRes = { ok: boolean; message: string; empty?: boolean } // 变更端点 { result } 的归一形状

// 体检明细：把服务端的健康规则译成当前语言的完整描述（数字从原文取）
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
function healthMessage(t: TFunc, h: HealthIssue): string {
  const key = HEALTH_KEY[h.rule]
  return key ? t(`healthMsg.${key}`, { n: h.message.match(/\d+/)?.[0] ?? "" }) : h.message
}

export function DetailPanel({
  repo,
  groups,
  allTags,
  onPatchMeta,
  onOpen,
  onCopyPath,
  onSync,
  onLog,
  onClose,
}: {
  repo: RepoStatus
  groups: string[]
  allTags: string[]
  onPatchMeta: (
    id: string,
    patch: { favorite?: boolean; tags?: string[]; group?: string | null; note?: string | null; archived?: boolean },
  ) => void
  onOpen: (id: string, target: "editor" | "terminal" | "explorer") => void
  onCopyPath: (path: string) => void
  onSync: (action: "fetch" | "pull" | "push") => Promise<{ ok: boolean; message: string } | null>
  onLog: (ok: boolean, text: string) => void
  onClose: () => void
}) {
  const { message, modal } = AntdApp.useApp()
  const t = useT()
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [switching, setSwitching] = useState(false)
  const [stashing, setStashing] = useState(false) // 正在「收进 stash」
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState("")
  const [discarding, setDiscarding] = useState(false)
  const [stashBusy, setStashBusy] = useState<string | null>(null) // 正在处理的 stash sha
  const { view: viewStashDiffModal, node: stashDiffNode } = useStashDiff(t, 780)
  const [heat, setHeat] = useState<HeatmapDay[] | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [groupInput, setGroupInput] = useState(repo.group)
  const [noteInput, setNoteInput] = useState(repo.note ?? "")
  const [diff, setDiff] = useState<{ diff: string; untracked: string[] } | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState("")
  const [pushToo, setPushToo] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [gh, setGh] = useState<GithubStatus | "loading" | null>(null)
  const [syncing, setSyncing] = useState<"fetch" | "pull" | "push" | null>(null)
  // ok: null = 结果未知（60s 没等到 WS 回执，操作可能已在服务端完成）——不能按失败报，用户会对已推送的仓库做错误的补救
  const [syncResult, setSyncResult] = useState<{ action: string; ok: boolean | null; message: string } | null>(null)

  const changes = repo.dirty.staged + repo.dirty.unstaged + repo.dirty.untracked

  // 单仓库同步：起任务并等真正跑完（onSync 由 WS 回执兑现），期间显示「进行中」，完成后就地显示 ✓/✗ 与 git 输出
  const doSync = async (action: "fetch" | "pull" | "push") => {
    setSyncing(action)
    setSyncResult(null)
    try {
      const r = await onSync(action)
      if (r === null) setSyncResult({ action, ok: null, message: t("detail.syncUnknown") })
      else setSyncResult({ action, ok: r.ok, message: r.message })
    } catch (err) {
      setSyncResult({ action, ok: false, message: String(err) })
    } finally {
      setSyncing(null)
    }
  }

  const loadDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false)
      return
    }
    setDiffOpen(true)
    if (diff === null) {
      try {
        const r = await fetch(`/api/repos/${repo.id}/diff`)
        setDiff(r.ok ? await r.json() : { diff: "", untracked: [] })
      } catch {
        setDiff({ diff: "", untracked: [] })
      }
    }
  }
  const doCommit = async () => {
    const msg = commitMsg.trim()
    if (!msg) return
    setCommitting(true)
    try {
      const r = await fetch(`/api/repos/${repo.id}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg, push: pushToo }),
      })
      const data = (await r.json()) as { ok: boolean; code?: string; message: string; detail?: string }
      if (data.ok) {
        const toast =
          data.code === "committedPushed"
            ? t("msg.commitOkPush")
            : data.code === "pushFailed"
              ? t("msg.commitPushFailed", { err: data.detail ?? "" })
              : t("msg.commitOk")
        if (data.code === "pushFailed") message.warning(toast)
        else message.success(toast)
        onLog(true, t("msg.commitLog", { name: repo.name, msg }) + (pushToo ? t("msg.commitPush") : ""))
        setCommitMsg("")
        setDiff(null)
        setDiffOpen(false)
      } else {
        message.error(`${t("msg.commitFail")}: ${data.detail ?? data.message}`)
        onLog(false, t("msg.commitFailLog", { name: repo.name, msg: data.detail ?? data.message }))
      }
    } catch (err) {
      message.error(`${t("msg.commitFail")}: ${String(err)}`)
    } finally {
      setCommitting(false)
    }
  }

  const loadGithub = async () => {
    setGh("loading")
    try {
      const r = await fetch(`/api/repos/${repo.id}/github`)
      setGh(r.ok ? ((await r.json()) as GithubStatus) : { ok: false, error: t("detail.queryFail"), prs: [], run: null })
    } catch {
      setGh({ ok: false, error: t("detail.queryFail"), prs: [], run: null })
    }
  }

  const pruneBranches = async () => {
    setPruning(true)
    try {
      const r = await fetch(`/api/repos/${repo.id}/prune-branches`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      const data = (await r.json()) as { results: { name: string; ok: boolean; message: string }[] }
      const okCount = data.results.filter((x) => x.ok).length
      const failed = data.results.filter((x) => !x.ok)
      if (failed.length === 0) message.success(t("msg.pruneOk", { n: okCount }))
      else message.warning(t("msg.pruneSome", { ok: okCount, fail: failed.length, names: failed.map((f) => f.name).join("、") }))
      onLog(failed.length === 0, t("msg.pruneLog", { name: repo.name, ok: okCount }))
    } catch (err) {
      message.error(t("msg.pruneFail", { err: String(err) }))
    } finally {
      setPruning(false)
    }
  }

  // 取详情：失败/非 200 返回 null，让调用方决定「显示空」还是「保留旧数据」
  const fetchDetail = async (): Promise<DetailData | null> => {
    try {
      const r = await fetch(`/api/repos/${repo.id}/detail`)
      return r.ok ? ((await r.json()) as DetailData) : null
    } catch {
      return null
    }
  }
  // stash/分支等处理后重取详情；重取失败就保留现有列表，别把有效数据整片抹成空
  const refreshDetail = async () => {
    const d = await fetchDetail()
    if (d) setDetail(d)
  }
  // 变更请求统一收发：POST /api/repos/:id/<path>，把 { result } / { error } / 网络异常归一成 MutRes，绝不抛
  const postResult = async (path: string, body?: unknown): Promise<MutRes> => {
    try {
      const r = await fetch(`/api/repos/${repo.id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      const j = (await r.json()) as { result?: MutRes; error?: string }
      return j.result ?? { ok: false, message: j.error ?? "" }
    } catch (err) {
      return { ok: false, message: String(err) }
    }
  }
  const doSwitch = async (branch: string) => {
    if (branch === repo.branch) return
    setSwitching(true)
    const res = await postResult("switch", { branch })
    if (res.ok) {
      message.success(t("msg.switchOk", { branch }))
      onLog(true, t("msg.switchLog", { name: repo.name, branch }))
      await refreshDetail() // 提交/工作区随分支变化，重取详情
    } else {
      message.error(t("msg.switchFail", { err: res.message }))
      onLog(false, t("msg.switchFail", { err: `${repo.name}: ${res.message}` }))
    }
    setSwitching(false)
  }
  // 把当前改动收进 stash（用提交框里的文字作可选备注）
  const doCreateStash = async () => {
    setStashing(true)
    const res = await postResult("stash/create", { message: commitMsg.trim() })
    if (res.ok) {
      message.success(t("msg.stashPushOk"))
      onLog(true, t("msg.stashPushLog", { name: repo.name }))
      setCommitMsg("")
      await refreshDetail()
    } else if (res.empty) {
      message.info(t("msg.stashPushEmpty"))
    } else {
      message.error(t("msg.stashPushFail", { err: res.message }))
    }
    setStashing(false)
  }
  const doCreateBranch = async () => {
    const name = newBranchName.trim()
    if (name === "") return
    setCreatingBranch(true)
    const res = await postResult("branch", { name })
    if (res.ok) {
      message.success(t("msg.branchCreateOk", { branch: name }))
      onLog(true, t("msg.branchCreateLog", { name: repo.name, branch: name }))
      setNewBranchOpen(false)
      setNewBranchName("")
      await refreshDetail()
    } else {
      message.error(t("msg.branchCreateFail", { err: res.message }))
    }
    setCreatingBranch(false)
  }
  const doDiscard = async () => {
    setDiscarding(true)
    const res = await postResult("discard")
    if (res.ok) {
      message.success(t("msg.discardOk"))
      onLog(true, t("msg.discardLog", { name: repo.name }))
      setDiscardOpen(false)
      setDiscardConfirm("")
      await refreshDetail()
    } else {
      message.error(t("msg.discardFail", { err: res.message }))
    }
    setDiscarding(false)
  }
  const viewStashDiff = (s: StashEntry) => viewStashDiffModal(repo.id, s.sha, t("stash.diffTitle", { repo: titleName }))
  const stashAct = async (s: StashEntry, action: "apply" | "pop") => {
    setStashBusy(s.sha)
    try {
      await runStashApplyPop(repo.id, s.sha, action, repo.name, { t, message, onLog })
    } finally {
      setStashBusy(null)
      await refreshDetail()
    }
  }
  const dropStash = (s: StashEntry) => {
    modal.confirm({
      title: t("stash.dropConfirmTitle", { n: 1 }),
      content: t("stash.dropConfirmBody"),
      okText: t("stash.dropConfirmOk"),
      okButtonProps: { danger: true },
      cancelText: t("modal.cancel"),
      onOk: async () => {
        setStashBusy(s.sha)
        try {
          const res = await postResult("stash", { action: "drop", sha: s.sha })
          if (res.ok) {
            message.success(t("stash.dropOk", { n: 1 }))
            onLog(true, t("stash.log.drop", { name: repo.name, n: 1 }))
          } else {
            message.error(t("stash.actionFail", { err: res.message }))
          }
        } finally {
          setStashBusy(null)
          await refreshDetail()
        }
      },
    })
  }

  const addTagValue = (raw: string) => {
    const val = raw.trim()
    if (val !== "" && !repo.tags.includes(val)) onPatchMeta(repo.id, { tags: [...repo.tags, val] })
    setTagInput("")
  }
  const addTag = () => addTagValue(tagInput)
  const removeTag = (name: string) => onPatchMeta(repo.id, { tags: repo.tags.filter((x) => x !== name) })
  const commitNote = () => {
    const v = noteInput.trim()
    if (v !== (repo.note ?? "")) onPatchMeta(repo.id, { note: v === "" ? null : v })
  }
  const commitGroup = (value: string) => {
    if (value !== repo.group) onPatchMeta(repo.id, { group: value })
  }

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setHeat(null)
    setTagInput("")
    setGroupInput(repo.group)
    setNoteInput(repo.note ?? "")
    setDiff(null)
    setDiffOpen(false)
    setCommitMsg("")
    setPushToo(false)
    setGh(null)
    fetchDetail().then((d) => {
      // 首次加载失败退化为空态（而非一直转圈）；后续动作重取失败才保留旧数据
      if (!cancelled) setDetail(d ?? EMPTY_DETAIL)
    })
    fetch(`/api/stats/heatmap?days=182&repoId=${repo.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setHeat(d ? d.days : [])
      })
      .catch(() => {
        if (!cancelled) setHeat([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id])

  const web = remoteWeb(repo.remotes)
  const nameMatch = /^(\d{3})-(.+)$/.exec(repo.name)
  const slot = nameMatch ? nameMatch[1] : ""
  const titleName = nameMatch ? nameMatch[2] : (repo.displayName ?? repo.name)
  const sev = repo.error || repo.health.some((h) => h.severity === "error")
    ? "crit"
    : repo.health.some((h) => h.severity === "warn")
      ? "warn"
      : "ok"

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={880}
      rootClassName="rr-detail"
      styles={{ body: { padding: 0, maxHeight: "76vh", overflowY: "auto" } }}
      title={
        <span className="rr-d-title">
          <button
            className={`rr-d-fav${repo.favorite ? " on" : ""}`}
            onClick={() => onPatchMeta(repo.id, { favorite: !repo.favorite })}
            title={repo.favorite ? t("card.favOff") : t("card.favOn")}
          >
            ★
          </button>
          {slot && <span className="rr-c-slot">{slot}</span>}
          <span className="mono nm">{titleName}</span>
          {repo.archived && <span className="rr-d-arch">{t("card.excluded")}</span>}
        </span>
      }
    >
      <div className="rr-d">
        <div className={`rr-d-head ${sev}`}>
          <div className="path">{repo.path}</div>
          <div className="rr-d-readout">
            {detail && detail.branches.length > 0 ? (
              // 切换器旁保留分支状态告警：游离 HEAD 前置红标、非 main 后置提示，避免下拉遮盖状态
              <span className="rr-d-branchwrap">
                {repo.branch === null && <span className="br det">✖ {t("card.detached")}</span>}
                <Select
                  size="small"
                  variant="borderless"
                  className="rr-d-branchsel"
                  value={repo.branch ?? undefined}
                  placeholder={`⎇ ${t("detail.switchBranch")}`}
                  loading={switching}
                  disabled={switching}
                  popupMatchSelectWidth={false}
                  onChange={(v) => (v === NEW_BRANCH ? setNewBranchOpen(true) : doSwitch(v))}
                  title={t("detail.switchTip")}
                  options={[
                    {
                      label: t("detail.localBranches"),
                      options: [...detail.branches.map((b) => ({ value: b, label: `⎇ ${b}` })), { value: NEW_BRANCH, label: `＋ ${t("detail.newBranch")}` }],
                    },
                    ...(detail.remoteBranches.length > 0
                      ? [{ label: t("detail.remoteBranches"), options: detail.remoteBranches.map((b) => ({ value: b, label: `↧ ${b}` })) }]
                      : []),
                  ]}
                />
                {repo.branch !== null && isSideBranch(repo.branch) && <span className="side">({t("card.nonMain")})</span>}
              </span>
            ) : repo.branch === null ? (
              <span className="br det">✖ {t("card.detached")}</span>
            ) : (
              <span className="br">
                ⎇ {repo.branch}
                {isSideBranch(repo.branch) && <span className="side"> ({t("card.nonMain")})</span>}
              </span>
            )}
            {changes === 0 && repo.branch !== null ? (
              <span className="clean">✓ clean</span>
            ) : (
              <>
                {repo.dirty.staged > 0 && <span className="stg">+{repo.dirty.staged}</span>}
                {repo.dirty.unstaged > 0 && <span className="mod">~{repo.dirty.unstaged}</span>}
                {repo.dirty.untracked > 0 && <span className="mod">?{repo.dirty.untracked}</span>}
              </>
            )}
            {repo.ahead > 0 && <span className="ahead">↑{repo.ahead}</span>}
            {repo.behind > 0 && <span className="behind">↓{repo.behind}</span>}
            {repo.stashCount > 0 && <span className="stash">stash {repo.stashCount}</span>}
            {repo.language && (
              <span className="lang">
                <span className="ld" style={{ background: langColor(repo.language) }} />
                {repo.language}
              </span>
            )}
          </div>
          {repo.description !== null && <div className="desc">{repo.description}</div>}
        </div>

        {/* 操作台：把卡片上最常用的动作（在编辑器/终端/资源管理器打开、复制路径、远程）搬进弹窗，与卡片底部导轨呼应 */}
        <div className="rr-d-console">
          <div className="rr-d-rail">
            <button className="seg" onClick={() => onOpen(repo.id, "editor")} title={t("card.openWith", { label: t("card.editor") })}>
              {t("card.editor")}
            </button>
            <button className="seg" onClick={() => onOpen(repo.id, "terminal")} title={t("card.openWith", { label: t("card.terminal") })}>
              {t("card.terminal")}
            </button>
            <button className="seg" onClick={() => onOpen(repo.id, "explorer")} title={t("card.openWith", { label: t("card.dir") })}>
              {t("card.dir")}
            </button>
            <button className="seg" onClick={() => onCopyPath(repo.path)} title={t("card.copyTip", { path: repo.path })}>
              {t("card.copy")}
            </button>
          </div>
          {web && (
            <a className="rr-d-remote" href={web.url} target="_blank" rel="noreferrer" title={web.url}>
              ↗ {web.host}
            </a>
          )}
        </div>

        <div className="rr-d-cols">
        <div className="rr-d-col">
        <section>
          <h3>{t("detail.sync")}</h3>
          <div className="rr-d-syncrow">
            {(["fetch", "pull", "push"] as const).map((a) => (
              <Button key={a} size="small" className="mono" loading={syncing === a} disabled={syncing !== null} onClick={() => doSync(a)}>
                {a}
              </Button>
            ))}
            {(repo.ahead > 0 || repo.behind > 0) && (
              <span className="rr-d-syncstate mono">
                {repo.ahead > 0 && <span className="ahead">↑{repo.ahead}</span>}
                {repo.behind > 0 && <span className="behind">↓{repo.behind}</span>}
              </span>
            )}
          </div>
          {(syncing || syncResult) && (
            <div className={`rr-d-syncmsg mono ${syncing ? "running" : syncResult!.ok === null ? "unknown" : syncResult!.ok ? "ok" : "fail"}`}>
              <span className="ic">{syncing ? "⟳" : syncResult!.ok === null ? "?" : syncResult!.ok ? "✓" : "✗"}</span>
              <span className="act">{syncing ?? syncResult!.action}</span>
              {!syncing && syncResult!.message && <span className="d" title={syncResult!.message}>· {syncResult!.message}</span>}
            </div>
          )}
        </section>

        <section>
          <h3>{t("detail.health")}</h3>
          {repo.error !== null && <div className="issue error">{t("detail.readFail", { err: repo.error })}</div>}
          {repo.error === null && repo.health.length === 0 && (
            <div className="issue" style={{ color: "var(--ok)" }}>
              {t("detail.allGood")}
            </div>
          )}
          {repo.health.map((h) => (
            <div key={h.rule} className={`issue ${h.severity}`}>
              · {healthMessage(t, h)}
            </div>
          ))}
        </section>

        {repo.mergedBranches.length > 0 && (
          <section>
            <h3>{t("detail.cleanBranches", { n: repo.mergedBranches.length })}</h3>
            {repo.mergedBranches.map((b) => (
              <div key={b} className="kv" style={{ color: "var(--text)" }}>
                ⎇ {b} <span style={{ color: "var(--dim)" }}>· {t("detail.branchMerged")}</span>
              </div>
            ))}
            <Button size="small" danger loading={pruning} style={{ marginTop: 8 }} onClick={pruneBranches}>
              {t("detail.pruneBtn", { n: repo.mergedBranches.length })}
            </Button>
          </section>
        )}

        {changes > 0 && (
          <section>
            <h3>{t("detail.changes", { n: changes })}</h3>
            <Button size="small" onClick={loadDiff}>
              {diffOpen ? t("detail.hideDiff") : t("detail.viewDiff")}
            </Button>
            {diffOpen && (
              <>
                {diff && diff.untracked.length > 0 && (
                  <div className="kv" style={{ marginTop: 8 }}>
                    {t("detail.untracked", { files: diff.untracked.join("、") })}
                  </div>
                )}
                <div className="rr-diff">
                  {diff === null ? (
                    <div className="ln" style={{ color: "var(--dim)" }}>
                      {t("detail.diffLoading")}
                    </div>
                  ) : diff.diff === "" ? (
                    <div className="ln" style={{ color: "var(--dim)" }}>
                      {t("detail.diffEmpty")}
                    </div>
                  ) : (
                    diff.diff.split("\n").map((ln, i) => (
                      <div
                        key={i}
                        className="ln"
                        style={{
                          color:
                            ln.startsWith("+") && !ln.startsWith("+++")
                              ? "var(--ok)"
                              : ln.startsWith("-") && !ln.startsWith("---")
                                ? "var(--crit)"
                                : ln.startsWith("@@")
                                  ? "var(--sig)"
                                  : "var(--dim)",
                        }}
                      >
                        {ln || " "}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            <div className="rr-d-commitrow">
              <Input
                size="small"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onPressEnter={doCommit}
                placeholder={t("detail.commitPlaceholder")}
                style={{ flex: 1 }}
              />
              <Checkbox checked={pushToo} onChange={(e) => setPushToo(e.target.checked)}>
                <span className="rr-d-pushlbl">{t("detail.push")}</span>
              </Checkbox>
              <Button size="small" type="primary" ghost loading={committing} disabled={commitMsg.trim() === ""} onClick={doCommit}>
                {t("detail.commit")}
              </Button>
            </div>
            <div className="rr-d-actrow">
              <Button size="small" loading={stashing} onClick={doCreateStash} title={t("detail.stashPushTip")}>
                {t("detail.stashPush")}
              </Button>
              <Button size="small" type="text" danger className="rr-d-pushend" onClick={() => setDiscardOpen(true)}>
                {t("detail.discard")}
              </Button>
            </div>
          </section>
        )}

        <section>
          <h3>{t("detail.tagsGroup")}</h3>
          <div className="rr-d-tags">
            {repo.tags.map((tag) => (
              <Tag key={tag} closable onClose={() => removeTag(tag)} className="mono">
                {tag}
              </Tag>
            ))}
            <AutoComplete
              size="small"
              style={{ width: 110 }}
              value={tagInput}
              options={allTags.filter((tag) => !repo.tags.includes(tag)).map((tag) => ({ value: tag }))}
              onChange={setTagInput}
              onSelect={addTagValue}
              onKeyDown={(e) => e.key === "Enter" && addTag()}
              onBlur={addTag}
              placeholder={t("detail.addTag")}
            />
          </div>
          <div className="rr-d-metarow">
            <AutoComplete
              size="small"
              style={{ width: 180 }}
              value={groupInput}
              options={groups.map((g) => ({ value: g }))}
              onChange={setGroupInput}
              onBlur={() => commitGroup(groupInput)}
              onKeyDown={(e) => e.key === "Enter" && commitGroup(groupInput)}
              placeholder={t("detail.group")}
            />
            <Button size="small" onClick={() => onPatchMeta(repo.id, { group: null })} title={t("detail.autoTip")}>
              {t("detail.auto")}
            </Button>
            <Button
              size="small"
              type={repo.archived ? "primary" : "default"}
              ghost={repo.archived}
              className="rr-d-pushend"
              onClick={() => onPatchMeta(repo.id, { archived: !repo.archived })}
              title={t("detail.excludeTip")}
            >
              {repo.archived ? t("detail.unexclude") : t("detail.exclude")}
            </Button>
          </div>
        </section>

        <section>
          <h3>{t("detail.note")}</h3>
          <Input.TextArea
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            onBlur={commitNote}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t("detail.notePlaceholder")}
          />
        </section>
        </div>
        <div className="rr-d-col">
        <section>
          <h3>{t("detail.heatmap")}</h3>
          {heat === null ? <div className="issue info">{t("detail.loading")}</div> : <Heatmap days={heat} weeks={26} legend fill />}
        </section>

        <section>
          <h3>{t("detail.recentCommits")}</h3>
          {detail === null ? (
            <div className="issue info">{t("detail.loading")}</div>
          ) : detail.recentCommits.length === 0 ? (
            <div className="issue info">{t("detail.emptyRepo")}</div>
          ) : (
            detail.recentCommits.map((c) => (
              <div key={c.hash} className="commit">
                <span className="t">{relativeTime(c.date)}</span> · {c.message}
              </div>
            ))
          )}
        </section>

        {detail !== null && detail.stashes.length > 0 && (
          <section>
            <h3>Stash</h3>
            {detail.stashes.map((s, i) => (
              // key 带序号：极罕见地两条 stash 撞同一 sha 时也不会 React key 重复
              <div key={`${s.sha}:${i}`} className="rr-d-stash">
                <div className="line">
                  {s.branch && <span className="br">{t("stash.onBranch", { branch: s.branch })}</span>}
                  <span className="msg" title={s.message}>
                    {cleanStashMessage(s.message)}
                  </span>
                  <span className="stat">{t("stash.files", { files: s.files, ins: s.insertions, del: s.deletions })}</span>
                </div>
                <div className="acts">
                  <StashActions
                    t={t}
                    busy={stashBusy !== null}
                    loading={stashBusy === s.sha}
                    onDiff={() => viewStashDiff(s)}
                    onApply={() => stashAct(s, "apply")}
                    onPop={() => stashAct(s, "pop")}
                    onDrop={() => dropStash(s)}
                  />
                </div>
              </div>
            ))}
          </section>
        )}

        {repo.remotes.length > 0 && (
          <section>
            <h3>{t("detail.remote")}</h3>
            {repo.remotes.map((r) => (
              <div key={r.name} className="kv" title={r.url}>
                {r.name} · {r.url}
              </div>
            ))}
            {web && (
              <a href={web.url} target="_blank" rel="noreferrer" className="rem" style={{ color: "var(--sig)", fontSize: 11 }}>
                {t("detail.openHost", { host: web.host })}
              </a>
            )}
          </section>
        )}

        {web?.host === "github.com" && (
          <section>
            <h3>{t("detail.github")}</h3>
            {gh === null ? (
              <Button size="small" onClick={loadGithub}>
                {t("detail.queryGithub")}
              </Button>
            ) : gh === "loading" ? (
              <div className="issue info">{t("detail.querying")}</div>
            ) : !gh.ok ? (
              <div className="issue warn">{gh.error ?? t("detail.queryFail")}</div>
            ) : (
              <>
                <div className="kv" style={{ color: "var(--text)" }}>{t("detail.openPRs", { n: gh.prs.length })}</div>
                {gh.prs.map((p) => (
                  <div key={p.number} className="kv">
                    <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "var(--sig)" }}>
                      #{p.number} {p.title}
                    </a>
                    {p.isDraft && <span style={{ color: "var(--dim)" }}> · {t("detail.draft")}</span>}
                  </div>
                ))}
                {gh.run && (
                  <div className="kv" style={{ marginTop: 4 }}>
                    {t("detail.latestCI", { workflow: gh.run.workflowName })}{" "}
                    <span
                      style={{
                        color:
                          gh.run.status !== "completed"
                            ? "var(--warn)"
                            : gh.run.conclusion === "success"
                              ? "var(--ok)"
                              : "var(--crit)",
                      }}
                    >
                      {gh.run.status !== "completed" ? gh.run.status : (gh.run.conclusion ?? "?")}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        </div>
        </div>
      </div>

      {stashDiffNode}

      <Modal
        open={newBranchOpen}
        title={t("detail.newBranchTitle")}
        okText={t("detail.newBranch")}
        cancelText={t("modal.cancel")}
        confirmLoading={creatingBranch}
        okButtonProps={{ disabled: newBranchName.trim() === "" }}
        onOk={doCreateBranch}
        onCancel={() => setNewBranchOpen(false)}
      >
        <Input
          autoFocus
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
          onPressEnter={doCreateBranch}
          placeholder={t("detail.newBranchPlaceholder")}
          style={{ marginTop: 12 }}
        />
      </Modal>

      <Modal
        open={discardOpen}
        title={<span style={{ color: "var(--crit)" }}>{t("detail.discardTitle")}</span>}
        okText={t("detail.discard")}
        cancelText={t("modal.cancel")}
        confirmLoading={discarding}
        okButtonProps={{ danger: true, disabled: discardConfirm.trim().toLowerCase() !== "discard" }}
        onOk={doDiscard}
        onCancel={() => {
          setDiscardOpen(false)
          setDiscardConfirm("")
        }}
      >
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>
          {t("detail.discardBody", { n: changes })}
          <Input
            style={{ marginTop: 10 }}
            value={discardConfirm}
            onChange={(e) => setDiscardConfirm(e.target.value)}
            onPressEnter={() => discardConfirm.trim().toLowerCase() === "discard" && doDiscard()}
            placeholder="discard"
          />
        </div>
      </Modal>
    </Modal>
  )
}
