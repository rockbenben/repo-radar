import { describe, expect, it } from "vitest"
import { createSerialQueue } from "../src/serial"

/** 手动可控的 promise，用来精确摆出「上一轮还没结束」的时序 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createSerialQueue", () => {
  it("串行执行：前一轮没结束，后一轮不开跑", async () => {
    const q = createSerialQueue<string>()
    const first = deferred<string>()
    const order: string[] = []

    const a = q.chain(async () => {
      order.push("a-start")
      const v = await first.promise
      order.push("a-end")
      return v
    })
    const b = q.chain(async () => {
      order.push("b-start")
      return "b"
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(["a-start"]) // b 还没开跑
    first.resolve("a")
    expect(await Promise.all([a, b])).toEqual(["a", "b"])
    expect(order).toEqual(["a-start", "a-end", "b-start"])
  })

  it("share：已排队未开跑的一轮被共乘，任务只跑一次", async () => {
    const q = createSerialQueue<number>()
    const gate = deferred<void>()
    let runs = 0

    const blocking = q.chain(async () => {
      await gate.promise
      return 0
    })
    // 上一轮卡着，这三次触发排的是同一轮 —— 重复点「重扫」不该排三次全量扫描
    const p1 = q.share(async () => ++runs)
    const p2 = q.share(async () => ++runs)
    const p3 = q.share(async () => ++runs)
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)

    gate.resolve()
    await blocking
    expect(await p1).toBe(1)
    expect(runs).toBe(1)
  })

  it("share：一轮开跑后再触发要另排一轮（本轮目标集已定死）", async () => {
    const q = createSerialQueue<number>()
    const gate = deferred<void>()
    let runs = 0

    const running = q.share(async () => {
      runs++
      await gate.promise
      return runs
    })
    await new Promise((r) => setTimeout(r, 10)) // 让它真正开跑
    expect(q.queued).toBeNull() // 开跑即出队，之后的触发不能再共乘它

    const later = q.share(async () => ++runs)
    expect(later).not.toBe(running)
    gate.resolve()
    await Promise.all([running, later])
    expect(runs).toBe(2)
  })

  // chain 排的轮次任务各不相同，不能被后来的 share 骑上去——那等于「我的任务永远不跑，
  // 还拿了别人的返回值」，是会静默出错的混用
  it("share 不会共乘 chain 排的轮次", async () => {
    const q = createSerialQueue<string>()
    const gate = deferred<void>()
    const ran: string[] = []

    const chained = q.chain(async () => {
      await gate.promise
      ran.push("chained")
      return "chained"
    })
    const shared = q.share(async () => {
      ran.push("shared")
      return "shared"
    })
    expect(shared).not.toBe(chained)

    gate.resolve()
    expect(await Promise.all([chained, shared])).toEqual(["chained", "shared"])
    expect(ran).toEqual(["chained", "shared"]) // 两个任务都真的跑了
  })

  it("chain：每次都排新的一轮，绝不共乘（watch(A) 之后 watch(B) 两份都要生效）", async () => {
    const q = createSerialQueue<string>()
    const gate = deferred<void>()
    const applied: string[] = []

    const blocking = q.chain(async () => {
      await gate.promise
      return "block"
    })
    const a = q.chain(async () => {
      applied.push("A")
      return "A"
    })
    const b = q.chain(async () => {
      applied.push("B")
      return "B"
    })
    expect(a).not.toBe(b)

    gate.resolve()
    await Promise.all([blocking, a, b])
    expect(applied).toEqual(["A", "B"]) // 顺序也要对：后到的 B 是最终生效的那份
  })

  // 链保存的是「上一轮何时结束」。一轮失败若把 rejection 留在链上，之后每一轮都会跟着
  // reject —— 整个队列永久卡死。但调用方拿到的 promise 仍必须如实 reject，不能把错藏起来
  it("一轮失败不拖垮后续，同时错误照常抛给调用方", async () => {
    const q = createSerialQueue<string>()
    await expect(q.chain(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(await q.chain(async () => "still works")).toBe("still works")
    await expect(q.share(async () => Promise.reject(new Error("again")))).rejects.toThrow("again")
    expect(await q.share(async () => "fine")).toBe("fine")
  })
})
