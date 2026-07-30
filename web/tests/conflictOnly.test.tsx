/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { DetailPanel } from "../src/components/DetailPanel"
import { RepoCard } from "../src/components/RepoCard"
import { I18nProvider } from "../src/i18n"
import type { DirtyCounts, RepoStatus } from "../src/types"

/**
 * 「只有冲突文件」的仓库：一次普通的 merge 冲突、且冲突文件是唯一改动时，
 * `git status --porcelain=v2` 只有一行 `u`，于是 staged/unstaged/untracked 全是 0。
 * 卡片与详情面板各自算的 `changes` 若漏掉 conflicted，这个仓库就会被当成干净的。
 */
const conflictOnly: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 }
const allZero: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }

const stub = (dirty: DirtyCounts): RepoStatus => ({
  id: "r1", path: "D:\\repos\\demo", name: "demo", group: "", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null,
  mergedBranches: [], dirty, ahead: 0, behind: 0, upstream: null, stashCount: 0, stashOldest: null, release: null,
  remotes: [], lastCommit: null, health: [], githubInbox: null, error: null, scannedAt: "",
})

function wrap(node: ReactNode) {
  return render(
    <ConfigProvider>
      <I18nProvider lang="zh-Hans" setLang={() => {}}>
        <AntApp>{node}</AntApp>
      </I18nProvider>
    </ConfigProvider>,
  )
}

const noop = () => {}
const card = (dirty: DirtyCounts) => (
  <RepoCard
    repo={stub(dirty)}
    clock={0}
    selected={false}
    onToggleSelect={noop}
    onOpen={noop}
    onShowDetail={noop}
    onToggleFavorite={noop}
    onQuickFilter={noop}
    onFilterTag={noop}
    onCopyPath={noop}
  />
)

const panel = (dirty: DirtyCounts) => (
  <DetailPanel
    repo={stub(dirty)}
    groups={[]}
    allTags={[]}
    onPatchMeta={noop}
    onOpen={noop}
    onCopyPath={noop}
    onSync={async () => null}
    onLog={noop}
    onClose={noop}
  />
)

// jsdom 不实现 ResizeObserver，而 antd 的 Select/Input 内部会 observe 尺寸。
// 直接赋值而不是 vi.stubGlobal：afterEach 的 unstubAllGlobals 会把 stub 撤掉
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// DetailPanel 挂载时会取详情与热力图；给出形状正确的空数据，别让组件在解构处炸掉
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const body = String(url).includes("/heatmap")
        ? { days: [] }
        : { recentCommits: [], stashes: [], branches: [], remoteBranches: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("只有冲突文件的仓库", () => {
  it("卡片不显示「✓ clean」（同一张卡不能一边说干净、一边挂着冲突 chip）", () => {
    wrap(card(conflictOnly))
    expect(screen.queryByText("✓ clean")).toBeNull()
  })

  it("对照：真正干净的仓库仍显示「✓ clean」", () => {
    wrap(card(allZero))
    expect(screen.getByText("✓ clean")).toBeTruthy()
  })

  it("详情面板仍渲染改动区（查看改动 / 提交 / 收进 stash / 丢弃改动）", async () => {
    stubFetch()
    wrap(panel(conflictOnly))
    // 漏掉 conflicted 时 `changes > 0` 恒假，整块 section 不渲染，用户正在解冲突却一个操作都点不了
    expect(await screen.findByText("改动 / 提交（1）")).toBeTruthy()
    expect(screen.getByText("查看 diff")).toBeTruthy()
  })

  it("对照：真正干净的仓库详情面板不渲染改动区", async () => {
    stubFetch()
    wrap(panel(allZero))
    expect(await screen.findByText("D:\\repos\\demo")).toBeTruthy() // 面板确实渲染出来了
    expect(screen.queryByText("查看 diff")).toBeNull()
  })
})
