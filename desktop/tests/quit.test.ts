import { describe, expect, it, vi } from "vitest"
import { createQuit } from "../src/quit"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("createQuit — 唯一退出出口", () => {
  it("顺序：先停后端，再销毁托盘/窗口，最后退出", async () => {
    const calls: string[] = []
    await createQuit({
      stopBackend: async () => void calls.push("stopBackend"),
      beforeExit: () => void calls.push("beforeExit"),
      exit: () => void calls.push("exit"),
    })()
    expect(calls).toEqual(["stopBackend", "beforeExit", "exit"])
  })

  // 托盘退出、窗口关闭、系统关机可能同时到达
  it("幂等：并发调用只收尾一次", async () => {
    const stopBackend = vi.fn(async () => void (await sleep(20)))
    const exit = vi.fn()
    const quit = createQuit({ stopBackend, beforeExit: () => {}, exit })
    await Promise.all([quit(), quit(), quit()])
    expect(stopBackend).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it("后端收尾抛错也要退出（卡在半路不退比丢一点缓存更糟）", async () => {
    const exit = vi.fn()
    await createQuit({
      stopBackend: () => Promise.reject(new Error("boom")),
      beforeExit: () => {},
      exit,
    })()
    expect(exit).toHaveBeenCalledOnce()
  })

  // 缺陷 5：main.ts 的 whenReady .catch（backend.start() 已成功之后才可能抛出的异常，
  // 比如打包时图标缺失导致 new Tray() 抛出）要能走完整收尾、同时仍然用退出码 1 表示失败，
  // 不能为了收尾而悄悄把失败伪装成正常退出（0）
  it("退出码可传参：完整收尾后仍能以非 0 退出码退出", async () => {
    const calls: string[] = []
    const exit = vi.fn((code: number) => void calls.push(`exit(${code})`))
    await createQuit({
      stopBackend: async () => void calls.push("stopBackend"),
      beforeExit: () => void calls.push("beforeExit"),
      exit,
    })(1)
    expect(calls).toEqual(["stopBackend", "beforeExit", "exit(1)"])
  })

  it("不传退出码时默认为 0（正常退出路径不受影响）", async () => {
    const exit = vi.fn()
    await createQuit({ stopBackend: async () => {}, beforeExit: () => {}, exit })()
    expect(exit).toHaveBeenCalledWith(0)
  })
})
