import type { BrowserWindow } from "electron"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadState } from "../src/window-state"
import { saveWindowState } from "../src/window"

// mock electron，避免加载真实 electron 二进制（见 window.test.ts 的说明）：saveWindowState 只调用
// 传入的窗口对象方法，不用到 import 进来的 electron 运行时，mock 掉即可绕过二进制解压竞态。
vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [] },
  shell: { openExternal: () => {} },
}))

// 缺陷 6：窗口尺寸在真正的退出路径（quit() -> app.exit()）上从不保存，因为持久化原先只挂在
// close 事件上，而 app.exit() 是强制终止、根本不触发 close。main.ts 现在会在 beforeExit 里
// 主动调用这里导出的 saveWindowState() 补存一次——这条测试锁住 saveWindowState 本身的行为：
// 不依赖 electron 的 BrowserWindow 构造函数（那需要真正的 Electron 运行时），只用一个
// 满足所需方法的最小 fake 对象，因为 saveWindowState 只调用传入 win 上的方法，不引用模块顶层
// 从 "electron" 导入的任何值。
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-winsave-"))
  dirs.push(d)
  return join(d, "window-state.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function fakeWindow(
  bounds: { x: number; y: number; width: number; height: number },
  maximized: boolean,
  options: { minimized?: boolean; destroyed?: boolean } = {},
) {
  return {
    isMaximized: () => maximized,
    isMinimized: () => options.minimized ?? false,
    isDestroyed: () => options.destroyed ?? false,
    getBounds: () => bounds,
    getNormalBounds: () => bounds,
  } as unknown as BrowserWindow
}

describe("saveWindowState", () => {
  it("非最大化：存 getBounds() 的当前几何尺寸", () => {
    const f = tmp()
    saveWindowState(fakeWindow({ x: 10, y: 20, width: 900, height: 600 }, false), f)
    expect(loadState(f, [{ x: 0, y: 0, width: 1920, height: 1080 }])).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 600,
      maximized: false,
    })
  })

  it("最大化：存 getNormalBounds()（还原后的尺寸），并标记 maximized", () => {
    const f = tmp()
    saveWindowState(fakeWindow({ x: 0, y: 0, width: 1100, height: 800 }, true), f)
    const state = loadState(f, [{ x: 0, y: 0, width: 1920, height: 1080 }])
    expect(state.maximized).toBe(true)
    expect(state.width).toBe(1100)
  })

  // 缺陷 3：最小化的窗口在 Windows 上 getBounds()/getNormalBounds() 常返回占位坐标
  // （如 x=-32000,y=-32000,width=160,height=28），isMaximized() 也是 false——直接存下来会把
  // window-state.json 写成垃圾，下次加载时 sanitizeState 因尺寸小于 MIN_WIDTH/MIN_HEIGHT
  // 丢弃它，窗口回退到默认 1280x860 居中，用户之前精心摆好的布局被无声抹掉。
  // 修法：最小化时直接跳过，保留上一次（未最小化时）已经存下的好状态。
  it("最小化：跳过保存，不覆盖磁盘上已有的状态", () => {
    const f = tmp()
    // 先存一份"好"的状态，模拟用户之前调整过窗口、已经落盘
    saveWindowState(fakeWindow({ x: 10, y: 20, width: 1100, height: 800 }, false), f)
    // 用户最小化后从托盘退出：bounds 是 Windows 最小化时的典型占位值
    saveWindowState(fakeWindow({ x: -32000, y: -32000, width: 160, height: 28 }, false, { minimized: true }), f)
    expect(loadState(f, [{ x: 0, y: 0, width: 1920, height: 1080 }])).toEqual({
      x: 10,
      y: 20,
      width: 1100,
      height: 800,
      maximized: false,
    })
  })

  // 窗口已销毁时任何 bounds 查询都不可信（也可能直接抛异常）——同样跳过，不动磁盘上的状态
  it("已销毁：跳过保存，不覆盖磁盘上已有的状态", () => {
    const f = tmp()
    saveWindowState(fakeWindow({ x: 5, y: 5, width: 950, height: 650 }, false), f)
    saveWindowState(fakeWindow({ x: 0, y: 0, width: 0, height: 0 }, false, { destroyed: true }), f)
    expect(loadState(f, [{ x: 0, y: 0, width: 1920, height: 1080 }])).toEqual({
      x: 5,
      y: 5,
      width: 950,
      height: 650,
      maximized: false,
    })
  })

  it("最小化且磁盘上还没有任何状态：跳过保存，不会创建文件", () => {
    const f = tmp()
    saveWindowState(fakeWindow({ x: -32000, y: -32000, width: 160, height: 28 }, false, { minimized: true }), f)
    expect(existsSync(f)).toBe(false)
  })
})
