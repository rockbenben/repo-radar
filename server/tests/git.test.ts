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
