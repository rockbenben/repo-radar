/** @vitest-environment jsdom */
import { App as AntApp, ConfigProvider } from "antd"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ScanConfigEditor } from "../src/components/ScanConfigEditor"
import { I18nProvider, type LangCode } from "../src/i18n"

// ScanConfigEditor 的加载 effect 读的是全局 fetch（loadScanConfig(fetch)），不是注入实现——
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
 * ScanConfigEditor 的加载 effect 不会因为 t 变成新引用而重新触发。
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
          <ScanConfigEditor open={open} onClose={() => {}} onSaved={() => {}} />
        </AntApp>
      </I18nProvider>
    </ConfigProvider>
  )
}

afterEach(() => {
  // 这里没开 vitest globals，RTL 的自动清理不生效——不手动 cleanup 的话上一个用例的
  // 弹窗会留在 document 里，下一个用例的 getBy* 撞上两份同样的节点直接报「找到多个」
  cleanup()
  vi.unstubAllGlobals()
})

// 这个组件要防的回归：之前加载 effect 的依赖数组里带着 t，而 t 由 I18nProvider 在语言变化时
// 重建——切换界面语言会让这个 effect 重跑，它第一件事就是 setRoots([])，用户在对话框里已经
// 加载好（甚至正在编辑）的扫描目录列表会被无声清空。修复后 effect 只认 open/reloadTick。
describe("ScanConfigEditor — 切换界面语言不清空已加载的 roots", () => {
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

// 回归锁定：此前修的"重新打开对话框要重置 roots"不能被后续改动带回去——
// 关闭再打开必须清掉上一次打开时加载到的旧列表，改用新一轮加载的结果，不能两次结果混在一起。
describe("ScanConfigEditor — 重新打开对话框仍然要重置 roots（回归锁定）", () => {
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

/**
 * 弹窗现在编辑三段配置（roots / excludes / open），保存是一次整体 PUT。
 *
 * 危险不在「漏带某一段」——服务端是 mergeConfig(loadConfig(file), body)，base 先铺开，
 * 请求里没有的字段原样保留（server/src/config.ts:71）。危险在**带上了但内容不对**：
 * roots 和 excludes 是整体替换，弹窗这一份就是最终结果。加载解析、编辑、回填三步里任何一处
 * 少一项，保存就把它从磁盘上删了，而用户以为自己只是加了个扫描目录。
 * 这两条用例把「用户没动过的段落原样回去」钉死在 PUT 的请求体上。
 */
describe("ScanConfigEditor — 保存把三段配置一起写回", () => {
  const CONFIG = {
    roots: ["D:\\a"],
    excludes: ["node_modules", "dist"],
    open: { editor: 'code "{path}"', terminal: 'wt -d "{path}"', explorer: 'explorer "{path}"' },
  }

  /** 返回一个数组，测试结束时里面是所有 PUT /api/config 的请求体 */
  function mockConfigApi(): Record<string, unknown>[] {
    const puts: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? "GET").toUpperCase() === "PUT") {
          puts.push(JSON.parse(init!.body!) as Record<string, unknown>)
          return new Response("{}", { status: 200 })
        }
        return new Response(JSON.stringify(CONFIG), { status: 200 })
      }),
    )
    return puts
  }

  const clickSave = () => act(() => void fireEvent.click(screen.getByText("保存并重新扫描")))

  it("什么都不改直接保存：三段原样回去，没有任何一段被清空", async () => {
    const puts = mockConfigApi()
    render(<Harness open={true} />)
    await waitFor(() => expect(screen.getByText("D:\\a")).toBeTruthy())
    expect(screen.getByText("node_modules")).toBeTruthy() // 排除目录确实加载进来了

    clickSave()

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual(CONFIG)
  })

  it("改一条打开方式命令：只有它变，roots / excludes 不受影响", async () => {
    const puts = mockConfigApi()
    render(<Harness open={true} />)
    await waitFor(() => expect(screen.getByText("D:\\a")).toBeTruthy())

    const editorInput = screen.getByDisplayValue('code "{path}"')
    act(() => void fireEvent.change(editorInput, { target: { value: 'subl "{path}"' } }))
    clickSave()

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ ...CONFIG, open: { ...CONFIG.open, editor: 'subl "{path}"' } })
  })

  // 配置文件是手改的，里面完全可能有两条一模一样的排除项。按值删会把重名的全删掉：
  // 用户点的是其中一行，消失的是两行，保存还会把这次「顺手」的删除落盘
  it("列表里有重复项时，✕ 只删掉点中的那一行", async () => {
    const dup = { ...CONFIG, excludes: ["node_modules", "dist", "node_modules"] }
    const puts: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? "GET").toUpperCase() === "PUT") {
          puts.push(JSON.parse(init!.body!) as Record<string, unknown>)
          return new Response("{}", { status: 200 })
        }
        return new Response(JSON.stringify(dup), { status: 200 })
      }),
    )
    render(<Harness open={true} />)
    await waitFor(() => expect(screen.getAllByText("node_modules")).toHaveLength(2))

    // 排除目录那一段的第一行（前面 roots 只有一条，所以整页第 2 个 ✕ 就是它）
    const removes = document.querySelectorAll<HTMLButtonElement>(".rr-roots-list .rm")
    act(() => void fireEvent.click(removes[1]))
    clickSave()

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ ...dup, excludes: ["dist", "node_modules"] })
  })
})
