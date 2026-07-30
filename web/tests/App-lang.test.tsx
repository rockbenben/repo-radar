/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import App from "../src/App"
import { I18nProvider, type LangCode } from "../src/i18n"
import type { BatchProgress, RepoStatus } from "../src/types"

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

/**
 * 假 WebSocket：connectEvents 直接 `new WebSocket(...)` 并把 onmessage 挂在实例上，
 * 测试要能从外面把服务端事件推进去，所以把最近一个实例存下来。
 * 不触发 onopen——onopen 会额外拉一轮 /api/repos + /api/scan，与本文件要验的东西无关。
 */
class FakeWebSocket {
  static last: FakeWebSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(_url: string) {
    FakeWebSocket.last = this
  }
  close() {}
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const CONFIG = { roots: ["D:\\repos"], manualRepos: [], autoWatch: true, autoScanMinutes: 30, watchLimit: 200, autoFetchMinutes: 0, notifications: false }

function stubFetch(repos: RepoStatus[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      // POST /api/scan 是 rescan（返回整份 repos），GET 是扫描时刻 + 监听覆盖数
      if (url.includes("/api/scan")) return (init?.method ?? "GET").toUpperCase() === "POST" ? json(repos) : json({ lastScanAt: null, watch: { watched: 0, total: 0 } })
      if (url.includes("/api/repos")) return json(repos)
      if (url.includes("/api/config")) return json(CONFIG)
      if (url.includes("/api/version")) return json({ version: "test", canQuit: false, port: 17420 })
      if (url.includes("/api/autostart")) return json({ supported: false, enabled: false })
      return json({})
    }),
  )
}

const repo = (over: Partial<RepoStatus>): RepoStatus => ({
  id: "r1", path: "D:\\repos\\demo", name: "demo", group: "repos", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null,
  mergedBranches: [], dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: 0, behind: 0, upstream: null, stashCount: 0, stashOldest: null, release: null,
  remotes: [{ name: "origin", url: "https://github.com/u/demo.git" }], lastCommit: null,
  health: [], githubInbox: null, error: null, scannedAt: "2026-01-01T00:00:00Z",
  ...over,
})

/** 外壳把语言状态提到 App 之上，用一个按钮切换——复刻 main.tsx 的 Root，
 *  只有经过真实的 I18nProvider，t 才会像线上那样在语言变化时被 useMemo 重建。 */
function Harness() {
  const [lang, setLang] = useState<LangCode>("zh-Hans")
  return (
    <ConfigProvider>
      <I18nProvider lang={lang} setLang={setLang}>
        <AntApp>
          <button type="button" onClick={() => setLang("en")}>
            switch-to-en
          </button>
          <App themeMode="dark" onToggleTheme={() => {}} />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

const switchToEnglish = () => act(() => void screen.getByText("switch-to-en").click())
const textsOf = (sel: string): string[] => [...document.querySelectorAll(sel)].map((e) => e.textContent ?? "")
// 活动日志的条目文本；不用 getByText 是因为同一句话还会出现在批量进度条上（那处直接用 t()
// 渲染，本来就跟随语言），只查日志列表才验得准
const logTexts = () => textsOf(".rr-actlist .nm")
// 分组标题；仓库卡片上也有语言名 chip，同样要按选择器限定范围
const groupNames = () => textsOf(".rr-ghd .nm")

beforeEach(() => {
  localStorage.clear()
  FakeWebSocket.last = null
  vi.stubGlobal("WebSocket", FakeWebSocket)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/**
 * C3：WebSocket 事件处理器定义在依赖数组为空的 effect 里（连接要活整个会话，t 不能进依赖，
 * 否则每切一次语言就重连），于是 t 被永久闭包在挂载时那个语言上。批量操作的完成回执因此
 * 用旧语言写进活动日志，而日志会落 localStorage 长期留着——一条永久的混语言记录。
 */
describe("活动日志的批量完成回执跟随当前界面语言", () => {
  const finished: BatchProgress = {
    taskId: "task-1", action: "push", done: 1, total: 1, current: null, finished: true,
    results: [{ repoId: "r1", name: "demo", ok: true, message: "ok" }],
  }
  const emitFinished = () =>
    act(() => {
      FakeWebSocket.last!.onmessage!({ data: JSON.stringify({ type: "batch:progress", payload: finished }) })
    })

  it("中文进页面 → 切成英文 → 批量完成：日志是英文", async () => {
    localStorage.setItem("rr.view", "log") // 直接停在活动日志视图，日志文本才渲染得出来
    stubFetch([repo({})])
    render(<Harness />)
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())

    switchToEnglish()
    emitFinished()

    expect(logTexts()).toEqual(["Batch push done: 1 ok"])
  })

  it("对照：不切语言时仍然是中文（修复不能把正常路径一起改掉）", async () => {
    localStorage.setItem("rr.view", "log")
    stubFetch([repo({})])
    render(<Harness />)
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())

    emitFinished()

    expect(logTexts()).toEqual(["批量 push 完成：1 成功"])
  })
})

/**
 * C4：「按语言」分组时，没有 language 的仓库那一组的**组名**来自 t("group.unidentified")，
 * 而 sections 的依赖数组里没有 t——切换界面语言后这个组名会一直停在旧语言，
 * 只有下次仓库更新（repo:updated / 重扫）才纠正，没有 git 活动时就是永久错。
 */
describe("「按语言」分组的「未识别语言」组名跟随当前界面语言", () => {
  it("切成英文后组名变成 Unidentified", async () => {
    localStorage.setItem("rr.group", "language")
    stubFetch([repo({ language: null })])
    render(<Harness />)
    await waitFor(() => expect(groupNames()).toEqual(["未识别语言"]))

    switchToEnglish()

    expect(groupNames()).toEqual(["Unidentified"])
  })

  it("对照：有 language 的仓库组名是语言名本身，不受界面语言影响", async () => {
    localStorage.setItem("rr.group", "language")
    stubFetch([repo({ language: "TypeScript" })])
    render(<Harness />)
    await waitFor(() => expect(groupNames()).toEqual(["TypeScript"]))

    switchToEnglish()

    expect(groupNames()).toEqual(["TypeScript"])
  })
})
