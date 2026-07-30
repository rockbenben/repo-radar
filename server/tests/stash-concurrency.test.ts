import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

/**
 * 真正要守住的是「同时活着的 git 子进程数」，所以直接在 spawn 那一层数，而不是断言用了哪个工具函数。
 *
 * vi.hoisted：vi.mock 的工厂会被提升到 import 之前，引用普通的模块级变量会撞 TDZ。
 */
const probe = vi.hoisted(() => ({
  inflightShow: 0,
  peakShow: 0,
  versionCalls: 0,
  reset(): void {
    this.inflightShow = 0
    this.peakShow = 0
    this.versionCalls = 0
  },
}))

// 只包一层计数再转交真实 spawn：跑的仍是真 git，别把被测行为换成假的
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>()
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const isShow = args.includes("stash") && args.includes("show")
      if (args.includes("--version")) probe.versionCalls++
      if (isShow) probe.peakShow = Math.max(probe.peakShow, ++probe.inflightShow)
      const child = real.spawn(cmd, args, opts)
      if (isShow) child.on("close", () => probe.inflightShow--)
      return child
    },
  }
})

/** 在一个已有 1 次提交的仓库里压入 n 条 stash */
function repoWithStashes(n: number): string {
  const dir = makeRepo()
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, "f0.txt"), `s-${i}`)
    git(dir, "stash", "push", "-m", `m-${i}`)
  }
  return dir
}

// git.ts 的版本探测结论与 stash 统计缓存都是模块级的，每条用例都要一份干净的
beforeEach(() => {
  vi.resetModules()
  probe.reset()
})
afterAll(cleanupFixtures)

describe("listStashes 的 git 子进程扇出", () => {
  it("单仓库内 stash show 的并发有上界，不随 stash 条数线性增长", async () => {
    const { listStashes } = await import("../src/git")
    const entries = await listStashes(repoWithStashes(20))
    expect(entries).toHaveLength(20)
    expect(probe.peakShow).toBeGreaterThan(0) // 确实跑过 stash show（不是被缓存跳过了）
    // 裸 Promise.all 时峰值就是 stash 条数（这里 20）。routes.ts 那层的 mapLimit(repos, 8)
    // 只掐住仓库这一维，两维相乘才是用户点开「收纳箱」时真实铺开的 git 进程数
    expect(probe.peakShow).toBeLessThanOrEqual(8)
  })

  it("`git --version` 版本探测在飞去重，K 条 stash 只探一次", async () => {
    const { listStashes } = await import("../src/git")
    await listStashes(repoWithStashes(5))
    // 不去重时 5 条 stash 在同一 tick 里全看到 untrackedSupported === null，各 spawn 一次
    expect(probe.versionCalls).toBe(1)
  })
})
