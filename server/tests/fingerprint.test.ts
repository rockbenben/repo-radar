import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitFingerprint } from "../src/fingerprint"
import { cleanupFixtures, git, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

/**
 * 「每一个改动仓库的 git 写操作都必须让指纹变化」——这条不变量可以被穷举，探针集合不能。
 *
 * 当初 PROBES 只有六条，缺 `config` 与 `refs/heads` / `refs/tags` / `refs/remotes` 三个目录，
 * 于是 tag / branch / branch -d / remote add / remote set-url 之后指纹**逐字节不变**：
 * 重字段命中缓存，发版雷达、可清理分支列表、remotes 全部冻结，而且没有上界——一直错到
 * 某次无关的 commit/fetch 为止。最刺眼的是 `prune-branches` 删完分支立刻读到旧分支列表。
 * 这张表当初一天之内就能抓到那个洞，以后还能白抓下一个。
 *
 * 每条用例都传**同一个假 oid**：oid 是 core 顺带给的，会把 commit/checkout 这类操作
 * 单独救活，从而掩盖掉探针本身的漏判。要测的是 stat 那一半。
 */
const OID = "fixed-oid-so-only-probes-can-notice"

interface FingerprintCase {
  name: string
  make?: () => string // 默认 makeRepo()
  prep?: (repo: string) => void // 在取 before 之前做，不参与断言
  op: (repo: string) => void
}

const WRITE_OPS: FingerprintCase[] = [
  {
    name: "commit",
    op: (r) => {
      writeFileSync(join(r, "x.txt"), "x")
      git(r, "add", "-A")
      git(r, "commit", "-m", "c")
    },
  },
  { name: "checkout", prep: (r) => git(r, "branch", "other"), op: (r) => git(r, "checkout", "other") },
  { name: "fetch", make: makeRepoWithUpstream, op: (r) => git(r, "fetch") },
  {
    name: "stash",
    prep: (r) => writeFileSync(join(r, "f0.txt"), "dirty"),
    op: (r) => git(r, "stash"),
  },
  { name: "tag", op: (r) => git(r, "tag", "v1.0.0") },
  { name: "branch", op: (r) => git(r, "branch", "feature") },
  { name: "branch -d", prep: (r) => git(r, "branch", "feature"), op: (r) => git(r, "branch", "-d", "feature") },
  // 嵌套的松散引用：refs/heads 下多一层目录，`refs/heads` 本身的 mtime 仍然要动
  {
    name: "branch -d（嵌套 refs/heads/nested/deep）",
    prep: (r) => git(r, "branch", "nested/deep"),
    op: (r) => git(r, "branch", "-D", "nested/deep"),
  },
  { name: "remote add", op: (r) => git(r, "remote", "add", "origin", "https://example.invalid/a.git") },
  {
    name: "remote set-url",
    prep: (r) => git(r, "remote", "add", "origin", "https://example.invalid/a.git"),
    op: (r) => git(r, "remote", "set-url", "origin", "https://example.invalid/b.git"),
  },
  { name: "gc", op: (r) => git(r, "gc", "--prune=now") },
]

describe("gitFingerprint —— 每个 git 写操作都必须让指纹变化（表驱动）", () => {
  for (const c of WRITE_OPS) {
    it(`${c.name} 之后指纹变化`, () => {
      const repo = (c.make ?? makeRepo)()
      c.prep?.(repo)
      const before = gitFingerprint(repo, OID)
      expect(before).not.toBeNull() // 前提：这个仓库本来就是可缓存的，否则下面的断言没有意义
      c.op(repo)
      expect(gitFingerprint(repo, OID)).not.toBe(before)
    })
  }
})

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
