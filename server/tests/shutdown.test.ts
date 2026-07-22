import { describe, expect, it, vi } from "vitest"
import { createShutdown, type ShutdownSteps } from "../src/shutdown"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function steps(over: Partial<ShutdownSteps> = {}) {
  const calls: string[] = []
  const base: ShutdownSteps = {
    stopListening: () => void calls.push("stopListening"),
    drainOps: async () => (calls.push("drainOps"), true),
    pendingOps: () => 0,
    closeWatcher: async () => void calls.push("closeWatcher"),
    flushCaches: () => void calls.push("flushCaches"),
    closeConnections: () => void calls.push("closeConnections"),
    log: () => {},
    ...over,
  }
  return { calls, base }
}

describe("createShutdown — 退出编排", () => {
  it("按固定顺序收尾：先停监听、再排空、最后才断连接", async () => {
    const { calls, base } = steps()
    await createShutdown(base)("SIGTERM")
    expect(calls).toEqual(["stopListening", "drainOps", "closeWatcher", "flushCaches", "closeConnections"])
  })

  it("连接必须最后断：/api/shutdown 的响应要在停止监听之后才送得出去", async () => {
    const { calls, base } = steps()
    await createShutdown(base)("api")
    expect(calls.indexOf("closeConnections")).toBe(calls.length - 1)
    expect(calls.indexOf("stopListening")).toBeLessThan(calls.indexOf("closeConnections"))
  })

  it("幂等：重复调用共用同一次收尾（连按两次 Ctrl-C 不能打断第一次）", async () => {
    const { calls, base } = steps({ drainOps: async () => (await sleep(30), calls.push("drainOps"), true) })
    const shutdown = createShutdown(base)
    const a = shutdown("SIGINT")
    const b = shutdown("SIGINT")
    expect(a).toBe(b) // 同一个 promise，不是两条并行的收尾
    await Promise.all([a, b])
    expect(calls.filter((c) => c === "flushCaches")).toHaveLength(1)
  })

  it("某一步抛出不影响后续步骤——尤其不能让刷缓存跑不到", async () => {
    const { calls, base } = steps({
      stopListening: () => {
        throw new Error("close boom")
      },
      closeWatcher: async () => {
        throw new Error("watcher boom")
      },
    })
    await expect(createShutdown(base)("SIGTERM")).resolves.toBeUndefined()
    expect(calls).toContain("flushCaches")
    expect(calls).toContain("closeConnections")
  })

  it("排空超时也要走完剩下的步骤，并明确留下一句可解释 index.lock 的日志", async () => {
    const logs: string[] = []
    const { calls, base } = steps({ drainOps: async () => false, pendingOps: () => 2, log: (m) => void logs.push(m) })
    await createShutdown(base)("SIGTERM")
    expect(calls).toContain("flushCaches")
    expect(logs.join("\n")).toContain("index.lock")
    expect(logs.join("\n")).toContain("等待 2 个仓库操作收尾")
  })

  it("没有待办操作时不打「等待」的噪音", async () => {
    const logs: string[] = []
    const { base } = steps({ log: (m) => void logs.push(m) })
    await createShutdown(base)("SIGINT")
    expect(logs.join("\n")).not.toContain("等待")
  })

  it("drainOps 本身 reject 也按「没等到」处理，不把退出卡死", async () => {
    const { calls, base } = steps({ drainOps: () => Promise.reject(new Error("boom")) })
    await expect(createShutdown(base)("SIGTERM")).resolves.toBeUndefined()
    expect(calls).toContain("closeConnections")
  })

  it("退出原因写进日志（事后要能分清是信号还是 UI 点的退出）", async () => {
    const log = vi.fn()
    await createShutdown(steps({ log }).base)("SIGHUP")
    expect(log.mock.calls[0][0]).toContain("SIGHUP")
  })
})
