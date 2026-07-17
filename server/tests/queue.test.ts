import { describe, expect, it } from "vitest"
import { withRepoLock } from "../src/queue"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("withRepoLock", () => {
  it("serializes ops on the same repo", async () => {
    const order: number[] = []
    const p1 = withRepoLock("a", async () => { await sleep(30); order.push(1) })
    const p2 = withRepoLock("a", async () => { order.push(2) })
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it("runs different repos concurrently", async () => {
    const order: string[] = []
    const p1 = withRepoLock("a", async () => { await sleep(30); order.push("a") })
    const p2 = withRepoLock("b", async () => { order.push("b") })
    await Promise.all([p1, p2])
    expect(order).toEqual(["b", "a"])
  })

  it("keeps the chain alive after a failure", async () => {
    await expect(withRepoLock("c", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(withRepoLock("c", async () => "ok")).resolves.toBe("ok")
  })
})
