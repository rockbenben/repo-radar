/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RootsEditor } from "../src/components/RootsEditor"
import { I18nProvider, type LangCode } from "../src/i18n"

// RootsEditor 的加载 effect 读的是全局 fetch（loadRoots(fetch)），不是注入实现——
// 测试里整体替换掉 window.fetch，每次返回固定的一份 roots
function mockFetchOnce(roots: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ roots }), { status: 200 })),
  )
}

/**
 * 测试外壳：把语言状态提到外面，通过按钮切换语言，复刻真实场景里 I18nProvider 在语言变化时
 * 用 useMemo 重建 t（见 web/src/i18n/index.tsx）——只有经过真实的 I18nProvider，才能验证
 * RootsEditor 的加载 effect 不会因为 t 变成新引用而重新触发。
 */
function Harness({ open, initialLang = "zh-Hans" }: { open: boolean; initialLang?: LangCode }) {
  const [lang, setLang] = useState<LangCode>(initialLang)
  return (
    <ConfigProvider>
      <I18nProvider lang={lang} setLang={setLang}>
        <AntApp>
          <button type="button" onClick={() => setLang((l) => (l === "zh-Hans" ? "en" : "zh-Hans"))}>
            switch-lang
          </button>
          <RootsEditor open={open} onClose={() => {}} onSaved={() => {}} />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// 本轮修复的核心场景：之前加载 effect 的依赖数组里带着 t，而 t 由 I18nProvider 在语言变化时
// 重建——切换界面语言会让这个 effect 重跑，它第一件事就是 setRoots([])，用户在对话框里已经
// 加载好（甚至正在编辑）的扫描目录列表会被无声清空。修复后 effect 只认 open/reloadTick。
describe("RootsEditor — 切换界面语言不清空已加载的 roots", () => {
  it("加载完成后切换语言，列表原样保留", async () => {
    mockFetchOnce(["D:\\repo-a", "D:\\repo-b"])
    render(<Harness open={true} />)

    await waitFor(() => expect(screen.getByText("D:\\repo-a")).toBeTruthy())
    expect(screen.getByText("D:\\repo-b")).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByText("switch-lang"))
    })

    // 语言切换后列表应仍然在，没有被清空成"暂无扫描目录"
    expect(screen.getByText("D:\\repo-a")).toBeTruthy()
    expect(screen.getByText("D:\\repo-b")).toBeTruthy()
  })
})

// 回归锁定：上一轮修的"重新打开对话框要重置 roots"不能被这一轮改动带回去——
// 关闭再打开必须清掉上一次打开时加载到的旧列表，改用新一轮加载的结果，不能两次结果混在一起。
describe("RootsEditor — 重新打开对话框仍然要重置 roots（回归锁定）", () => {
  it("关闭后用不同数据重新打开：不残留上一次打开的旧列表", async () => {
    mockFetchOnce(["D:\\old-repo"])
    const { rerender } = render(<Harness open={true} />)
    await waitFor(() => expect(screen.getByText("D:\\old-repo")).toBeTruthy())

    rerender(<Harness open={false} />)
    mockFetchOnce(["D:\\new-repo"])
    rerender(<Harness open={true} />)

    await waitFor(() => expect(screen.getByText("D:\\new-repo")).toBeTruthy())
    expect(screen.queryByText("D:\\old-repo")).toBeNull()
  })
})
