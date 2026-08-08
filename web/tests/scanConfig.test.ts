import { describe, expect, it, vi } from "vitest"
import { dirName, loadScanConfig } from "../src/lib/scanConfig"

// loadScanConfig 是 ScanConfigEditor 弹窗"打开时拉取配置"这段逻辑的纯函数版本：
// 解析与容错测在这里，组件那边只测它自己的事（见 ScanConfigEditor.test.tsx）。
// 三种结果都要能被调用方明确区分——调用方（ScanConfigEditor 的 effect）据此决定是展示列表、
// 加载失败提示，还是（配合调用方自己的 cancelled 标记）丢弃一个过期的旧响应。

const EMPTY_OPEN = { editor: "", terminal: "", explorer: "" }

describe("loadScanConfig", () => {
  it("成功时返回 roots / excludes / open 三段", async () => {
    const cfg = {
      roots: ["D:\\a", "D:\\b"],
      excludes: ["node_modules"],
      open: { editor: 'code "{path}"', terminal: 'wt -d "{path}"', explorer: 'explorer "{path}"' },
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(cfg), { status: 200 }))
    expect(await loadScanConfig(fetchImpl)).toEqual({ status: "loaded", ...cfg })
  })

  // 保存是整份写回，所以加载**不能**替用户"清理"数据：滤掉一个坏元素，点一次保存
  // 就把它从 config.json 里永久删了。原样带回去只会被服务端拒成 400，错误看得见、文件还在
  it("数组里混进非字符串时原样保留，不静默过滤", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ roots: ["D:\\a", null] }), { status: 200 }))
    const res = await loadScanConfig(fetchImpl)
    expect((res as { roots: string[] }).roots).toEqual(["D:\\a", null])
  })

  it("字段缺失/不是数组时按空列表处理，不是 undefined/崩溃", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    expect(await loadScanConfig(fetchImpl)).toEqual({ status: "loaded", roots: [], excludes: [], open: EMPTY_OPEN })
  })

  // open 里某一条缺失时必须留空串，不能顺手补上默认命令：弹窗显示什么、保存就写回什么，
  // 编回一条「猜的」默认值会把用户手改过、只是这次没读到的命令无声覆盖掉
  it("open 只有部分字段时，缺的那条是空串而不是默认命令", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ open: { editor: "vim {path}" } }), { status: 200 }))
    const res = await loadScanConfig(fetchImpl)
    expect(res).toEqual({ status: "loaded", roots: [], excludes: [], open: { editor: "vim {path}", terminal: "", explorer: "" } })
  })

  it("HTTP 非 2xx 返回 error 态，不冒充「加载成功、只是空列表」", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }))
    const res = await loadScanConfig(fetchImpl)
    expect(res.status).toBe("error")
  })

  it("fetch 本身抛错（网络层）也返回 error 态", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down")
    })
    const res = await loadScanConfig(fetchImpl)
    expect(res.status).toBe("error")
    expect((res as { status: "error"; message: string }).message).toMatch(/network down/)
  })

  it("JSON 解析失败也归为 error 态，不让调用方拿到半成品数据", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }))
    const res = await loadScanConfig(fetchImpl)
    expect(res.status).toBe("error")
  })
})

// 排除项按目录名匹配（server/src/scanner.ts 的 excludeSet.has(entry.name)）。用户最顺手的
// 输入却是从资源管理器粘一条完整路径——原样存下去界面上像是排除成功了，扫描却照进不误。
describe("dirName", () => {
  it("裸目录名原样返回", () => {
    expect(dirName("node_modules")).toBe("node_modules")
  })

  it("完整路径取末段（Windows 反斜杠 / POSIX 正斜杠都认）", () => {
    expect(dirName("D:\\code\\node_modules")).toBe("node_modules")
    expect(dirName("/home/me/code/.venv")).toBe(".venv")
  })

  it("末尾分隔符（资源管理器复制路径常带）不影响结果", () => {
    expect(dirName("node_modules\\")).toBe("node_modules")
    expect(dirName("D:/code/dist/")).toBe("dist")
  })

  it("空白输入归零，交给调用方忽略", () => {
    expect(dirName("   ")).toBe("")
  })

  // 大小写不折叠：Linux 上目录名区分大小写，折叠是错的
  it("不改大小写", () => {
    expect(dirName("Node_Modules")).toBe("Node_Modules")
  })
})
