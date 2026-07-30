/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DetailPanel } from "../src/components/DetailPanel"
import { RepoCard } from "../src/components/RepoCard"
import { I18nProvider } from "../src/i18n"
import type { RepoStatus } from "../src/types"

/**
 * 「当前分支未跟踪上游」这句话在服务端（health.ts 的 no-upstream 规则）与卡片上各有一份实现。
 * 两处判据必须逐条一致，否则同一个仓库会在卡片上挂着这句、体检区里却不列——用户看到两处直说矛盾。
 *
 * 游离 HEAD（`git checkout <sha>`、bisect、检出 tag）时 porcelain v2 只给 `# branch.head (detached)`，
 * 没有 branch.upstream 也没有 branch.ab，于是 branch=null、upstream=null、ahead=-1。服务端那份有
 * `branch !== null` 挡着，卡片那份一度漏了它。而游离时根本没有分支可跟踪，照这句提示去
 * `git push -u` 直接报错。
 */
const base: RepoStatus = {
  id: "r1", path: "D:\\repos\\demo", name: "demo", group: "", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null,
  mergedBranches: [], dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: -1, behind: -1, upstream: null, stashCount: 0, stashOldest: null, release: null,
  remotes: [{ name: "origin", url: "https://example.invalid/x.git" }],
  lastCommit: null, health: [], githubInbox: null, error: null, scannedAt: "",
}

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
const card = (repo: RepoStatus) =>
  wrap(
    <RepoCard
      repo={repo}
      clock={0}
      selected={false}
      onToggleSelect={noop}
      onOpen={noop}
      onShowDetail={noop}
      onToggleFavorite={noop}
      onQuickFilter={noop}
      onFilterTag={noop}
      onCopyPath={noop}
    />,
  )

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// DetailPanel 挂载时会取详情与热力图；给出形状正确的空数据，别让组件在解构处炸掉
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: unknown) =>
    new Response(JSON.stringify(String(url).includes("/heatmap") ? { days: [] } : { recentCommits: [], stashes: [], branches: [], remoteBranches: [] }), { status: 200 }),
  ),
)

afterEach(cleanup)

describe("card.noUpstream 与 health 的 no-upstream 判据一致", () => {
  it("有分支、有远程、没配上游时说这句", () => {
    card(base)
    expect(screen.queryByText("未跟踪上游")).not.toBeNull()
  })
  it("游离 HEAD 时不说这句（服务端那份有 branch !== null）", () => {
    card({ ...base, branch: null })
    expect(screen.queryByText("未跟踪上游")).toBeNull()
  })
  it("上游配着、只是远程分支被删时不说这句", () => {
    card({ ...base, upstream: "origin/feat" })
    expect(screen.queryByText("未跟踪上游")).toBeNull()
  })
})

/**
 * 「自动」按钮是 repo.group 的第二个写入者：它让服务端删掉 override、按目录重算分组并广播。
 * 面板不会因此重挂载（key 只是 repo.id），分组输入框若不跟着走就会停在旧 override 上——
 * 既与看板的分组同屏矛盾，随后一次**无操作的失焦**更会把旧值原样 PATCH 回去，
 * 用户刚点的「自动」被静默撤销，且没有任何提示。
 */
describe("分组输入框跟随服务端重算的分组", () => {
  it("点「自动」后不再停在旧 override，失焦也不会把它写回去", () => {
    const patch = vi.fn()
    const panel = (group: string) => (
      <DetailPanel
        repo={{ ...base, group }}
        groups={[]}
        allTags={[]}
        onPatchMeta={patch}
        onOpen={noop}
        onCopyPath={noop}
        onSync={async () => null}
        onLog={noop}
        onClose={noop}
      />
    )
    const { rerender } = wrap(panel("work"))
    const input = () => document.querySelector(".rr-d-metarow input") as HTMLInputElement
    expect(input().value).toBe("work")

    // 「自动」按钮 → 服务端删掉 override、按目录重算出 "365" 并广播回来
    rerender(
      <ConfigProvider>
        <I18nProvider lang="zh-Hans" setLang={() => {}}>
          <AntApp>{panel("365")}</AntApp>
        </I18nProvider>
      </ConfigProvider>,
    )
    expect(input().value).toBe("365")

    patch.mockClear()
    fireEvent.focus(input())
    fireEvent.blur(input())
    expect(patch).not.toHaveBeenCalled() // 不会把 "work" 写回去
  })
})
