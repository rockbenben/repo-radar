import { describe, expect, it, vi } from "vitest"
import { loadRoots } from "../src/lib/rootsEditor"

// loadRoots 是 RootsEditor 弹窗"打开时拉取 config.roots"这段逻辑的纯函数版本：抽出来是因为
// web/ 目前没有组件渲染测试基建（无 jsdom/RTL），没法直接挂载 RootsEditor 断言它的 DOM。
// 三种结果都要能被调用方明确区分——调用方（RootsEditor 的 effect）据此决定是展示列表、
// 加载失败提示，还是（配合调用方自己的 cancelled 标记）丢弃一个过期的旧响应。

describe("loadRoots", () => {
  it("成功时返回 config.roots", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ roots: ["D:\\a", "D:\\b"] }), { status: 200 }))
    const res = await loadRoots(fetchImpl)
    expect(res).toEqual({ status: "loaded", roots: ["D:\\a", "D:\\b"] })
  })

  it("roots 字段缺失/不是数组时按空列表处理，不是 undefined/崩溃", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const res = await loadRoots(fetchImpl)
    expect(res).toEqual({ status: "loaded", roots: [] })
  })

  it("HTTP 非 2xx 返回 error 态，不冒充「加载成功、只是空列表」", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }))
    const res = await loadRoots(fetchImpl)
    expect(res.status).toBe("error")
  })

  it("fetch 本身抛错（网络层）也返回 error 态", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down")
    })
    const res = await loadRoots(fetchImpl)
    expect(res.status).toBe("error")
    expect((res as { status: "error"; message: string }).message).toMatch(/network down/)
  })

  it("JSON 解析失败也归为 error 态，不让调用方拿到半成品数据", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }))
    const res = await loadRoots(fetchImpl)
    expect(res.status).toBe("error")
  })
})
