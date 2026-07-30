import { afterAll, describe, expect, it } from "vitest"
import { GitError, repoId, runGit } from "../src/git"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

describe("runGit", () => {
  it("resolves stdout on success", async () => {
    const repo = makeRepo()
    const { stdout } = await runGit(repo, ["rev-parse", "--is-inside-work-tree"])
    expect(stdout.trim()).toBe("true")
  })

  it("rejects GitError with stderr on non-zero exit", async () => {
    const repo = makeRepo()
    await expect(runGit(repo, ["checkout", "no-such-branch"])).rejects.toThrowError(GitError)
    await expect(runGit(repo, ["checkout", "no-such-branch"])).rejects.toMatchObject({
      stderr: expect.stringContaining("no-such-branch"),
    })
  })

  it("rejects on timeout", async () => {
    const repo = makeRepo()
    // 用一个必然超过 1ms 的命令验证超时路径
    await expect(runGit(repo, ["status"], 1)).rejects.toThrowError(/timed out/)
  })
})

describe("repoId", () => {
  it("is stable and separator/case insensitive", () => {
    expect(repoId("D:\\A\\b")).toBe(repoId("d:/a/B"))
    expect(repoId("D:\\A\\b")).toMatch(/^[0-9a-f]{12}$/)
    expect(repoId("D:\\A\\b")).not.toBe(repoId("D:\\A\\c"))
  })
})

// cwd 超过 Windows MAX_PATH(260) 时 spawn 是在**管道已建立之后**才失败的，stdout/stderr 各 emit
// 一次 `read ENOTCONN`。无人监听的流 'error' 会被 Node 升级成进程级 uncaughtException，而
// desktop/src/main.ts 的兜底会据此弹「repo-radar 遇到问题」并 app.exit(1)。这条路径在启动扫描里
// 必经——扫描根下只要有一个超长路径的仓库，应用每次启动都在同一处死掉，对话框里只有
// `read ENOTCONN`，面板起不来也没法移除它。实测阈值精确为 260：259 干净，260 起必现两条。
// 只在 win32 上跑：POSIX 的 PATH_MAX 是 4096 且 spawn 的失败时机不同，那边造不出这个形状
it.runIf(process.platform === "win32")("cwd 超长时 spawn 失败不会升级成进程级未捕获异常", async () => {
  const uncaught: string[] = []
  const onUncaught = (e: Error) => uncaught.push(String(e.message))
  process.on("uncaughtException", onUncaught)
  try {
    await expect(runGit("D:\\" + "x".repeat(300), ["--version"])).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 250)) // 管道的 error 是异步 emit 的，等它到
    expect(uncaught).toEqual([])
  } finally {
    process.off("uncaughtException", onUncaught)
  }
})
