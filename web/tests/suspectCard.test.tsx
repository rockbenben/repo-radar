/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { RepoCard } from "../src/components/RepoCard"
import { I18nProvider } from "../src/i18n"
import type { RepoStatus } from "../src/types"

const stub = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  id: "new-id", path: "D:\\repos\\app-copy", name: "app-copy", group: "", tags: [], favorite: false,
  branch: "main", displayName: null, description: null, language: null, archived: false, note: null,
  lastOpened: null, mergedBranches: [], dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: 0, behind: 0, upstream: null, stashCount: 0, stashOldest: null, release: null, remotes: [],
  lastCommit: null, committedAt: null, lastActivity: null, health: [], githubInbox: null, error: null,
  scannedAt: "", ...over,
})

const noop = () => {}
function card(over: Partial<RepoStatus> = {}, onRebind: (id: string) => void = noop, onDismiss: (id: string) => void = noop) {
  return (
    <ConfigProvider>
      <I18nProvider lang="zh-Hans" setLang={() => {}}>
        <AntApp>
          <RepoCard
            repo={stub(over)}
            clock={0}
            selected={false}
            onToggleSelect={noop}
            onOpen={noop}
            onShowDetail={noop}
            onToggleFavorite={noop}
            onQuickFilter={noop}
            onFilterTag={noop}
            onCopyPath={noop}
            onRebindSuspect={onRebind}
            onDismissSuspect={onDismiss}
          />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

describe("疑似旧身份提示条（搬移确认）", () => {
  it("带 suspect 的卡片显示提示条，含老路径与迁移/忽略两个动作", () => {
    const { container } = render(card({ suspect: { oldId: "old-id", oldPath: "D:\\repos\\app" } }))
    const strip = container.querySelector(".rr-c-suspect")
    expect(strip).not.toBeNull()
    expect((strip as HTMLElement).textContent).toContain("D:\\repos\\app")
    expect(within(strip as HTMLElement).getByText("迁移")).toBeTruthy()
    expect(within(strip as HTMLElement).getByText("忽略")).toBeTruthy()
  })

  it("点「迁移」以新卡片 id 调 onRebindSuspect；点「忽略」调 onDismissSuspect", () => {
    const calls: string[] = []
    const { container } = render(
      card(
        { suspect: { oldId: "old-id", oldPath: "D:\\x" } },
        (id: string) => calls.push("rebind:" + id),
        (id: string) => calls.push("dismiss:" + id),
      ),
    )
    const strip = container.querySelector(".rr-c-suspect") as HTMLElement
    fireEvent.click(within(strip).getByText("迁移"))
    fireEvent.click(within(strip).getByText("忽略"))
    expect(calls).toEqual(["rebind:new-id", "dismiss:new-id"])
  })

  it("无 suspect 的卡片没有提示条（回归护栏）", () => {
    const { container } = render(card())
    expect(container.querySelector(".rr-c-suspect")).toBeNull()
    const { container: c2 } = render(card({ suspect: null }))
    expect(c2.querySelector(".rr-c-suspect")).toBeNull()
  })
})
