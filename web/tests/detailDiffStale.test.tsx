/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DetailPanel } from "../src/components/DetailPanel"
import { RepoCard } from "../src/components/RepoCard"
import { I18nProvider } from "../src/i18n"
import type { DirtyCounts, RepoStatus } from "../src/types"

/**
 * 详情面板里「实时的改动计数」与「拉一次就冻住的 diff 正文」并排显示的那条链。
 *
 * 每一步单看都对：diff 按需拉取是对的，改动计数跟着 repo:updated 实时走也是对的，
 * 面板按 repo.id 重挂载同样是对的（切仓库不串台）。错在同一个仓库内部——面板不会重挂，
 * 而 diff 只在打开那一刻取过一次。屏幕上于是同时出现「改动 / 提交（4）」和一份两个文件的
 * diff，**而这块正下方就是提交输入框和「提交」按钮**：用户照着自己刚看过的 diff 写提交
 * 信息，提交进去的却是当前工作区的另一批内容。
 */
const stub = (dirty: DirtyCounts, hash = "aaa"): RepoStatus => ({
  id: "r1", path: "D:\\repos\\demo", name: "demo", group: "", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null,
  mergedBranches: [], dirty, ahead: 0, behind: 0, upstream: null, stashCount: 0, stashOldest: null, release: null,
  remotes: [], lastCommit: { hash, message: "m", author: "a", date: "2026-01-01T00:00:00Z" },
  health: [], githubInbox: null, error: null, scannedAt: "",
})
const dirty = (unstaged: number): DirtyCounts => ({ staged: 0, unstaged, untracked: 0, conflicted: 0 })

const noop = () => {}
const panel = (repo: RepoStatus) => (
  <ConfigProvider>
    <I18nProvider lang="zh-Hans" setLang={() => {}}>
      <AntApp>
        <DetailPanel
          repo={repo}
          groups={[]}
          allTags={[]}
          onPatchMeta={noop}
          onOpen={noop}
          onCopyPath={noop}
          onSync={async () => null}
          onLog={noop}
          onClose={noop}
        />
      </AntApp>
    </I18nProvider>
  </ConfigProvider>
)

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

/** 计数版 fetch 替身：diff 端点每次返回 diffBody() 当下的值，并记下被请求了几次 */
function stubFetch(diffBody: () => string): { diffCalls: () => number } {
  let diffCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes("/diff")) {
        diffCalls++
        return new Response(JSON.stringify({ diff: diffBody(), untracked: [] }), { status: 200 })
      }
      const body = u.includes("/heatmap") ? { days: [] } : { recentCommits: [], stashes: [], branches: [], remoteBranches: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return { diffCalls: () => diffCalls }
}

/**
 * 可控时序的 fetch 替身：diff 端点每次调用都挂起，把「兑现它」的函数按发出顺序收进 settle，
 * 由测试决定谁先返回。**不能用 sleep 撞运气**——要验的正是「先发后到」这个顺序本身。
 */
function stubDeferredFetch(): { settle: ((body: string) => void)[] } {
  const settle: ((body: string) => void)[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes("/diff")) {
        return new Promise<Response>((resolve) => {
          settle.push((body) => resolve(new Response(JSON.stringify({ diff: body, untracked: [] }), { status: 200 })))
        })
      }
      const body = u.includes("/heatmap") ? { days: [] } : { recentCommits: [], stashes: [], branches: [], remoteBranches: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return { settle }
}

/** 把已经兑现的响应链（Response → .json() → setState）彻底跑完：宏任务一定排在所有微任务之后 */
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("详情面板的 diff 不会与实时的改动计数脱节", () => {
  it("面板开着时仓库又变了 → diff 重取，不停在第一次那份", async () => {
    let body = "--- OLD DIFF ---"
    const calls = stubFetch(() => body)
    const view = render(panel(stub(dirty(2))))

    fireEvent.click(await screen.findByText("查看 diff"))
    expect(await screen.findByText("--- OLD DIFF ---")).toBeTruthy()
    expect(calls.diffCalls()).toBe(1)

    // 用户继续在编辑器里改文件 → watcher 推 repo:updated → 只有 repo 这个 prop 换掉
    body = "--- NEW DIFF ---"
    view.rerender(panel(stub(dirty(4))))

    expect(await screen.findByText("改动 / 提交（4）")).toBeTruthy()
    expect(await screen.findByText("--- NEW DIFF ---")).toBeTruthy()
    expect(screen.queryByText("--- OLD DIFF ---")).toBeNull() // 4 个改动配 2 个文件的 diff = 照着它写的提交信息是错的
  })

  it("收起再展开一定重取（记忆化过的版本全程只请求 1 次）", async () => {
    let body = "--- OLD DIFF ---"
    const calls = stubFetch(() => body)
    render(panel(stub(dirty(2))))

    fireEvent.click(await screen.findByText("查看 diff"))
    expect(await screen.findByText("--- OLD DIFF ---")).toBeTruthy()
    fireEvent.click(await screen.findByText("收起 diff"))
    body = "--- NEW DIFF ---"
    fireEvent.click(await screen.findByText("查看 diff"))

    expect(await screen.findByText("--- NEW DIFF ---")).toBeTruthy()
    expect(calls.diffCalls()).toBe(2)
  })

  it("改动清零（丢弃/入 stash）后再改文件，旧 diff 不会自己展开", async () => {
    const calls = stubFetch(() => "--- OLD DIFF ---")
    const view = render(panel(stub(dirty(2))))

    fireEvent.click(await screen.findByText("查看 diff"))
    expect(await screen.findByText("--- OLD DIFF ---")).toBeTruthy()

    // 「丢弃改动」/「收进 stash」→ changes 归 0 → 整块 section 卸载，但 diffOpen/diff 留在 state 里
    view.rerender(panel(stub(dirty(0))))
    await waitFor(() => expect(screen.queryByText("查看 diff")).toBeNull())

    // 之后随便改一个文件，section 回来——用户一次都没点，不能自动展开一份已经不存在的改动
    view.rerender(panel(stub(dirty(1))))
    expect(await screen.findByText("查看 diff")).toBeTruthy() // 按钮回到「查看」而不是「收起」
    expect(screen.queryByText("--- OLD DIFF ---")).toBeNull()
    expect(calls.diffCalls()).toBe(1) // 没人点就不该再发请求
  })
})

/**
 * 「每次都重取」把在途请求变成了常态，随之而来的是顺序问题：两次 diff 请求谁先返回没有保证
 * （同一台机器上仓库大小、git 的冷热缓存差一个数量级）。晚到的那份旧 diff 一旦覆盖上去，
 * 屏幕上就是「改动数是新的、diff 正文是旧的」——而这块正下方就是提交输入框和「提交」按钮，
 * 正是上面那三条用例要修的那类错配，只是换了个入口。
 * fetchDiff 里的 seq 令牌就是挡这个的；令牌全删掉时这两条必须转红，否则等于没有防线。
 */
describe("在途 diff 请求的令牌：晚到的旧响应不许覆盖新内容", () => {
  it("先发的后返回：屏幕上留下的是后发那次的 diff", async () => {
    const { settle } = stubDeferredFetch()
    const view = render(panel(stub(dirty(2))))

    fireEvent.click(await screen.findByText("查看 diff"))
    await waitFor(() => expect(settle.length).toBe(1)) // 第 1 次请求已发出，挂着不返回

    // 仓库又变了（watcher 推 repo:updated）→ 指纹变化触发第 2 次请求
    view.rerender(panel(stub(dirty(4), "bbb")))
    await waitFor(() => expect(settle.length).toBe(2))

    settle[1]("--- NEW DIFF ---") // 后发的先返回
    expect(await screen.findByText("--- NEW DIFF ---")).toBeTruthy()

    settle[0]("--- OLD DIFF ---") // 先发的姗姗来迟
    await flush()

    expect(screen.queryByText("--- OLD DIFF ---")).toBeNull() // 4 个改动配一份过期 diff = 照着它写的提交信息是错的
    expect(screen.getByText("--- NEW DIFF ---")).toBeTruthy()
  })

  it("已经收起（改动清零）之后才返回的那份，不会在下次展开时先闪出来", async () => {
    const { settle } = stubDeferredFetch()
    const view = render(panel(stub(dirty(2))))

    fireEvent.click(await screen.findByText("查看 diff"))
    await waitFor(() => expect(settle.length).toBe(1))

    // 「丢弃改动」/「收进 stash」：改动清零 → closeDiff 作废这份在途请求
    view.rerender(panel(stub(dirty(0), "bbb")))
    await waitFor(() => expect(screen.queryByText("查看 diff")).toBeNull())
    // 之后又改了一个文件，整块 section 回来（用户一次都没点，diff 仍是收起的）
    view.rerender(panel(stub(dirty(1), "ccc")))
    expect(await screen.findByText("查看 diff")).toBeTruthy()

    // 这份被作废的请求现在才返回——它描述的那批改动磁盘上已经不存在了
    settle[0]("--- OLD DIFF ---")
    await flush()

    // 用户点开：必须是「加载中」等新的那份，而不是先闪一下那份已经作废的旧正文
    fireEvent.click(screen.getByText("查看 diff"))
    await flush()

    expect(screen.queryByText("--- OLD DIFF ---")).toBeNull()
    expect(screen.getByText("加载中…")).toBeTruthy()
  })
})

// 同一模式的兄弟实例，后果轻些：卡片「⋯」预览的提交列表拉一次后永不重取，
// 而它就贴在实时更新的改动数旁边
describe("卡片「⋯」预览的最近提交", () => {
  it("每次点开都重取，不停在第一次那份", async () => {
    let subject = "旧提交"
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        seen.push(String(url))
        return new Response(JSON.stringify({ recentCommits: [{ hash: "h1", message: subject, author: "a", date: "2026-01-01T00:00:00Z" }] }), { status: 200 })
      }),
    )
    render(
      <ConfigProvider>
        <I18nProvider lang="zh-Hans" setLang={() => {}}>
          <AntApp>
            <RepoCard
              repo={stub(dirty(1))}
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
          </AntApp>
        </I18nProvider>
      </ConfigProvider>,
    )

    const peek = screen.getByTitle("最近提交")
    fireEvent.click(peek)
    expect(await screen.findByText("旧提交")).toBeTruthy()
    fireEvent.click(peek) // 收起
    subject = "新提交" // 期间用户在这个仓库里提交了
    fireEvent.click(peek)

    expect(await screen.findByText("新提交")).toBeTruthy()
    expect(seen.filter((u) => u.includes("basic=1")).length).toBe(2)
  })
})
