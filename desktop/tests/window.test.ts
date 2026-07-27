import { describe, expect, it, vi } from "vitest"
import { decideCrashReload, isAllowedExternalUrl, isSameOrigin, resolveShortcut } from "../src/window"

// mock electron，避免加载真实 electron 二进制。desktop 单测只验纯函数、不需要 electron 运行时；
// 多个测试文件并行 import 真 electron 会同时解压二进制到 node_modules/electron/dist，CI windows 上
// 撞车报 os error 183「文件已存在」而随机失败。与 autostart.test.ts 同一手法。
vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [] },
  shell: { openExternal: () => {} },
}))

// 缺陷 4：will-navigate 与 setWindowOpenHandler 拦下来的导航之前被原样交给
// shell.openExternal——它会按系统协议关联启动对应程序，不做协议限制的话，恶意页面里的
// file:/ms-msdt:/smb: 等自定义协议会被原样交给操作系统处理。修法是只放行 http/https
// （这个应用的外链全是 GitHub 网页），两个入口共用同一个判定函数，不写两份。
describe("isAllowedExternalUrl — 是否可以放行给 shell.openExternal（缺陷 4）", () => {
  it("http/https 放行", () => {
    expect(isAllowedExternalUrl("https://github.com/rockbenben/repo-radar")).toBe(true)
    expect(isAllowedExternalUrl("http://example.com")).toBe(true)
  })

  it("file: 协议拒绝——否则页面能诱导打开本地任意文件", () => {
    expect(isAllowedExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false)
  })

  it("自定义协议拒绝——比如 Windows 上臭名昭著的 ms-msdt:，或任意其它协议处理程序", () => {
    expect(isAllowedExternalUrl("ms-msdt:some-payload")).toBe(false)
    expect(isAllowedExternalUrl("smb://evil.example/share")).toBe(false)
  })

  it("畸形字符串拒绝——解析不出协议就不能放行,\"看不懂就当作允许\"是把守卫开了个后门", () => {
    expect(isAllowedExternalUrl("not a url at all")).toBe(false)
    expect(isAllowedExternalUrl("")).toBe(false)
  })
})

// will-navigate 判断"是否离开了站内"要比较解析后的 origin，不能用字符串前缀比较——
// 那种写法会被 `http://127.0.0.1:17420@evil.example/` 这类带 userinfo 的地址骗过去
// （@ 前面只是用户信息，真正的 host 是 evil.example）
describe("isSameOrigin — will-navigate 的同源判定（缺陷 4 覆盖要求之一）", () => {
  const baseOrigin = "http://127.0.0.1:17420"

  it("完全同源：协议+host+端口都一致", () => {
    expect(isSameOrigin("http://127.0.0.1:17420/some/path", baseOrigin)).toBe(true)
  })

  it("带 userinfo 的地址被判定为非同源，即使前缀看起来像本站", () => {
    expect(isSameOrigin("http://127.0.0.1:17420@evil.example/login", baseOrigin)).toBe(false)
  })

  it("端口不同（哪怕只多一位数字）判定为非同源", () => {
    expect(isSameOrigin("http://127.0.0.1:174209/", baseOrigin)).toBe(false)
  })

  it("host 不同判定为非同源", () => {
    expect(isSameOrigin("http://evil.example/", baseOrigin)).toBe(false)
  })

  it("畸形字符串解析失败 -> 判定为非同源（拦下当外部处理，不能因解析失败就放行）", () => {
    expect(isSameOrigin("not a url at all", baseOrigin)).toBe(false)
  })
})

// 应用菜单被去掉后，View 菜单默认提供的缩放（Ctrl/Cmd +/-/0）与 F12 开发者工具一并失去入口，
// 由 before-input-event + resolveShortcut 补回（①③）。这里覆盖平台差异与"未按修饰键"的边界。
describe("resolveShortcut — 补回被去掉菜单后失去的快捷键", () => {
  const key = (over: Partial<{ type: string; key: string; control: boolean; meta: boolean }>) => ({
    type: "keyDown",
    key: "a",
    control: false,
    meta: false,
    ...over,
  })

  it("F12 → 开发者工具（任意平台，不需要修饰键）", () => {
    expect(resolveShortcut(key({ key: "F12" }), "win32")).toBe("devtools")
    expect(resolveShortcut(key({ key: "F12" }), "darwin")).toBe("devtools")
  })

  it("keyUp 一律忽略——否则一次按键触发两遍", () => {
    expect(resolveShortcut(key({ type: "keyUp", key: "F12" }), "win32")).toBeNull()
  })

  it("非 macOS 上 Ctrl +/-/0 触发缩放（'=' 与小键盘 '+' 都算放大）", () => {
    expect(resolveShortcut(key({ control: true, key: "=" }), "win32")).toBe("zoom-in")
    expect(resolveShortcut(key({ control: true, key: "+" }), "win32")).toBe("zoom-in")
    expect(resolveShortcut(key({ control: true, key: "-" }), "win32")).toBe("zoom-out")
    expect(resolveShortcut(key({ control: true, key: "0" }), "win32")).toBe("zoom-reset")
  })

  it("macOS 认 Cmd（meta），不认 Ctrl", () => {
    expect(resolveShortcut(key({ meta: true, key: "=" }), "darwin")).toBe("zoom-in")
    expect(resolveShortcut(key({ control: true, key: "=" }), "darwin")).toBeNull()
  })

  it("没有修饰键的 +/-/0 是正常输入，不当快捷键", () => {
    expect(resolveShortcut(key({ key: "=" }), "win32")).toBeNull()
    expect(resolveShortcut(key({ key: "0" }), "win32")).toBeNull()
  })
})

// 渲染进程崩溃自动重载 + 防抖（①）：救回空白窗口，但短时间反复崩就停手，避免重载死循环打满 CPU。
describe("decideCrashReload — 崩溃自动重载与防抖", () => {
  it("首次崩溃：重载，并记下时间戳", () => {
    const r = decideCrashReload([], 1000)
    expect(r.reload).toBe(true)
    expect(r.recent).toEqual([1000])
  })

  it("窗口内累计不超过 max（默认 3）都重载，第 4 次停手", () => {
    let times: number[] = []
    for (const t of [0, 100, 200]) {
      const r = decideCrashReload(times, t)
      times = r.recent
      expect(r.reload).toBe(true)
    }
    expect(decideCrashReload(times, 300).reload).toBe(false)
  })

  it("超出 windowMs 的旧记录被裁掉，不计入次数——崩溃间隔够久就不算连环崩", () => {
    const r = decideCrashReload([0, 100, 200], 100_000)
    expect(r.reload).toBe(true)
    expect(r.recent).toEqual([100_000])
  })
})
