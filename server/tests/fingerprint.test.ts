import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitFingerprint } from "../src/fingerprint"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

describe("gitFingerprint", () => {
  it("同一仓库、无改动 → 指纹稳定", () => {
    const repo = makeRepo()
    expect(gitFingerprint(repo, "abc")).toBe(gitFingerprint(repo, "abc"))
  })

  it("oid 变化 → 指纹变化", () => {
    const repo = makeRepo()
    expect(gitFingerprint(repo, "abc")).not.toBe(gitFingerprint(repo, "def"))
  })

  it("提交后指纹变化（HEAD/index/logs 至少一项动了）", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "same-oid")
    writeFileSync(join(repo, "x.txt"), "x")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "c")
    // 故意传同一个 oid：证明即使 oid 没告诉我们变化，stat 也能发现
    expect(gitFingerprint(repo, "same-oid")).not.toBe(before)
  })

  it("stash 后指纹变化", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "o")
    writeFileSync(join(repo, "f0.txt"), "changed")
    git(repo, "stash")
    expect(gitFingerprint(repo, "o")).not.toBe(before)
  })

  // .git 是文件（worktree / submodule）时六个 stat 全失败。若返回恒定字符串，
  // 这类仓库会永远命中缓存、heavy 永不刷新——必须显式表达「不可缓存」
  it(".git 不是目录 → 返回 null（不可缓存）", () => {
    const fake = makeRepo()
    rmSync(join(fake, ".git"), { recursive: true, force: true })
    writeFileSync(join(fake, ".git"), "gitdir: /somewhere/else")
    expect(gitFingerprint(fake, "o")).toBeNull()
  })

  it("路径根本不存在 → 返回 null", () => {
    expect(gitFingerprint(join("Z:", "no", "such", "repo"), "o")).toBeNull()
  })

  it("空仓库（oid 为 null）也能算出指纹", () => {
    const repo = makeRepo({ commits: 0 })
    expect(gitFingerprint(repo, null)).not.toBeNull()
  })

  it("FETCH_HEAD 从无到有 → 指纹变化", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "o")
    mkdirSync(join(repo, ".git"), { recursive: true })
    writeFileSync(join(repo, ".git", "FETCH_HEAD"), "deadbeef\n")
    expect(gitFingerprint(repo, "o")).not.toBe(before)
  })
})
