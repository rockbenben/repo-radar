/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import App from "../src/App"
import { I18nProvider } from "../src/i18n"
import type { GithubInbox, RepoStatus } from "../src/types"

/**
 * 「该你了」队列里计数类「已处理」的重现口径。
 *
 * 这条规则原本只由浏览器 localStorage 的水位维护，而**把水位往下调只发生在渲染进程活着、
 * 并且恰好观察到那一轮下探的时候**。托盘常驻（--tray / 开机自启）恰恰是「没有渲染进程」的形态，
 * 而通知功能存在的全部理由就是「面板关着」：
 *   ① 面板里 X 的「该你了」显示 PR 4，点 ✓ → 水位记 4
 *   ② 托盘退出 / 自启常驻，全程无窗口
 *   ③ 那 4 个 PR 被合掉，某轮拿到 prs:0——差值 ≤ 0 不弹通知，也没有任何人下调水位
 *   ④ 来了 2 个新 PR，0 → 2 差值为正 → 弹出系统通知「X · PR +2」
 *   ⑤ 用户点通知 → 面板打开 → 从 localStorage 读回水位 4 → 2 ≤ 4 判定为已处理
 * 结果：用户被通知叫过来，「该你了」里却没有这条；紧接着清理 effect 把水位降到 2，
 * 2 ≤ 2 仍然成立——除非 PR 数涨过 2，否则再也不出现，界面上还没有「撤销已处理」的入口。
 *
 * 修法是把「下探」挪到服务端记账：InboxCache 每轮累加 prsAdded/issuesAdded（只增不减，
 * 面板关着的轮次照记，见 server/tests/inbox-cache.test.ts 里同一条 4 → 0 → 2 序列），
 * 点「已处理」时把当时的累计数一并存成基线，之后只要累计数涨过基线就重现。
 */

// jsdom 不实现这两个；antd 的 Select/Segmented/Popover 内部会用到
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
globalThis.matchMedia ??= ((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia

class FakeWebSocket {
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(_url: string) {}
  close() {}
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const CONFIG = { roots: ["D:\\repos"], manualRepos: [], autoWatch: true, autoScanMinutes: 30, watchLimit: 200, autoFetchMinutes: 0, notifications: true }

function stubFetch(repos: RepoStatus[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      if (url.includes("/api/scan")) return (init?.method ?? "GET").toUpperCase() === "POST" ? json(repos) : json({ lastScanAt: null, watch: { watched: 0, total: 0 } })
      if (url.includes("/api/repos")) return json(repos)
      if (url.includes("/api/config")) return json(CONFIG)
      if (url.includes("/api/version")) return json({ version: "test", canQuit: false, port: 17420 })
      if (url.includes("/api/autostart")) return json({ supported: false, enabled: false })
      return json({})
    }),
  )
}

const repo = (inbox: GithubInbox): RepoStatus => ({
  id: "r1", path: "D:\\repos\\demo", name: "demo", group: "repos", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null,
  mergedBranches: [], dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: 0, behind: 0, upstream: null, stashCount: 0, stashOldest: null, release: null,
  remotes: [{ name: "origin", url: "https://github.com/u/demo.git" }],
  lastCommit: { hash: "aaa", message: "m", author: "a", date: "2026-01-01T00:00:00Z" },
  health: [], githubInbox: inbox, error: null, scannedAt: "2026-01-01T00:00:00Z",
})
const inbox = (prs: number, prsAdded: number): GithubInbox => ({ prs, issues: 0, ciFailed: false, ciSha: "sha1", prsAdded, issuesAdded: 0 })

const view = () => (
  <ConfigProvider>
    <I18nProvider lang="zh-Hans" setLang={() => {}}>
      <AntApp>
        <App themeMode="dark" onToggleTheme={() => {}} />
      </AntApp>
    </I18nProvider>
  </ConfigProvider>
)
const queueReasons = () => [...document.querySelectorAll(".queue-list .why")].map((e) => e.textContent ?? "")
const storedMark = () => (JSON.parse(localStorage.getItem("rr.dismissed") ?? "{}") as Record<string, string>)["r1:pr"]

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("WebSocket", FakeWebSocket)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("计数类「已处理」在面板关着期间也不会被静默压制", () => {
  it("完整序列：PR 4 点 ✓ →（无渲染进程）掉到 0 → 涨到 2 → 打开面板：这条重新出现在队列里", async () => {
    // ① 面板里显示 PR 4，用户点 ✓（此时服务端累计新到达为 0）
    stubFetch([repo(inbox(4, 0))])
    render(view())
    await waitFor(() => expect(queueReasons()).toEqual(["4 个 PR 等你"]))
    fireEvent.click(screen.getByTitle("标记已处理（有新变化再提醒）"))
    await waitFor(() => expect(queueReasons()).toEqual([]))

    // ② 托盘退出 / 自启常驻：渲染进程没了，localStorage 里的水位留在原地
    cleanup()
    // ③④ 全程无窗口：那 4 个被合掉（prs 0，差值 ≤ 0 不弹通知、也没人下调水位），
    //     随后来了 2 个新的 → 服务端累计新到达记到 2，通知弹出「demo · PR +2」
    stubFetch([repo(inbox(2, 2))])

    // ⑤ 用户点通知，面板打开
    render(view())

    // 被叫来了，队列里就必须有这条——而不是「2 ≤ 4，已处理」
    await waitFor(() => expect(queueReasons()).toEqual(["2 个 PR 等你"]))
  })

  it("对照：合掉 2 个只剩 2、没有新的到达 → 仍然保持已处理（不能一改就全冒出来）", async () => {
    localStorage.setItem("rr.dismissed", JSON.stringify({ "r1:pr": "4@0" }))
    stubFetch([repo(inbox(2, 0))]) // 累计新到达仍是 0：这 2 个是原来那 4 个里剩下的

    render(view())

    await waitFor(() => expect(screen.getByText("✓ 全部干净，无需处理")).toBeTruthy())
    expect(queueReasons()).toEqual([])
  })

  it("点「已处理」时把服务端的累计数一并存成基线，下次才比得了", async () => {
    stubFetch([repo(inbox(2, 7))])
    render(view())
    await waitFor(() => expect(queueReasons()).toEqual(["2 个 PR 等你"]))

    fireEvent.click(screen.getByTitle("标记已处理（有新变化再提醒）"))

    await waitFor(() => expect(queueReasons()).toEqual([]))
    expect(storedMark()).toBe("2@7")
  })

  // 服务端那个累计数**会被重置**：InboxCache 见 origin url 变了就把 carry 置空从 0 重记
  //（HTTPS 换 SSH、GitHub 上改仓库名后更新远程、加/去 .git 后缀都算这一类普通 git 操作），
  // github-inbox.json 损坏（onCorrupt 重置）或被剪枝同理。而基线存在 localStorage、键是
  // repoId，身份账本保证改远程不换 id——旧基线原地不动。
  // 把「累计数比基线小」当成「没有新到达」的话，上面那条完整序列的症状原样复现：通知照弹
  // 「PR +2」，用户点进来队列里没有这条，还要再攒够 8 次新到达才解除
  it("改过 origin url（服务端累计数从 0 重记）之后，新到达仍然要能把这条叫回来", async () => {
    localStorage.setItem("rr.dismissed", JSON.stringify({ "r1:pr": "4@7" })) // 点 ✓ 时服务端已累计 7 次
    stubFetch([repo(inbox(2, 2))]) // 换了远程 → 计数器从 0 重记，随后来了 2 个新的

    render(view())

    await waitFor(() => expect(queueReasons()).toEqual(["2 个 PR 等你"]))
  })

  it("旧格式（纯水位，没有基线）退回原口径，不会因为读不到基线就乱冒", async () => {
    localStorage.setItem("rr.dismissed", JSON.stringify({ "r1:pr": "4" }))
    stubFetch([repo(inbox(2, 2))])

    render(view())

    await waitFor(() => expect(screen.getByText("✓ 全部干净，无需处理")).toBeTruthy())
    expect(queueReasons()).toEqual([])
    // 面板开着时的降档照常跑（水位跟着降到 2），格式不变——基线要等用户下次点「已处理」才补上
    await waitFor(() => expect(storedMark()).toBe("2"))
  })
})

// `git remote -v` 这一次 spawn 失败/被杀软锁住/在网络盘上超时时，getRepoHeavy 会 degrade 成
// remotes: []，而 error 仍是 null（降级结果本轮照常广播，只是不落盘）。前端的「未知就别清」
// 判据只挡了 error !== null，遇到这个形状会判定「确认已解决」，把用户点过的 ✓ 从 localStorage
// **永久删掉**——下一轮远程恢复、PR 一个没变，条目原样复活在「该你了」里
describe("远程读不到时不把「已处理」当成「已解决」清掉", () => {
  const noRemotes = (): RepoStatus => ({ ...repo(inbox(3, 0)), remotes: [], githubInbox: null })

  it("remotes 读不到（degrade 成空）时保留已处理记录", async () => {
    localStorage.setItem("rr.dismissed", JSON.stringify({ "r1:pr": "3@0" }))
    stubFetch([noRemotes()])
    render(view())
    await waitFor(() => expect(document.querySelector(".rr-card")).toBeTruthy())
    expect(queueReasons()).toEqual([]) // 不因为「未知」就把条目冒出来
    expect(storedMark()).toBe("3@0") // 更要紧的是：记录还在
  })

  it("对照：真的没有 GitHub 远程时照常清掉（防永久堆积）", async () => {
    localStorage.setItem("rr.dismissed", JSON.stringify({ "r1:pr": "3@0" }))
    const local = { ...repo(inbox(3, 0)), remotes: [{ name: "origin", url: "https://gitlab.com/u/demo.git" }], githubInbox: null }
    stubFetch([local])
    render(view())
    await waitFor(() => expect(document.querySelector(".rr-card")).toBeTruthy())
    await waitFor(() => expect(storedMark()).toBeUndefined())
  })
})
