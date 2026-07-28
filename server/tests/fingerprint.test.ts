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
  // ↓ 带斜杠的 ref 名。这四条各自打在一个**不同**的位置上，别把它们当同一条的重复：
  //   父目录不存在时，新建第一个嵌套 ref 要先创建 refs/heads/<ns> 这个目录，于是顶层
  //   refs/heads 的 mtime 会动；父目录**已经存在**时变的只有 refs/heads/<ns> 自己，
  //   顶层纹丝不动。只 stat 三个顶层目录的实现恰好能过前者、栽在后者上——
  //   而 feature/* 正是最主流的分支命名。删除侧同理：删掉命名空间里最后一个 ref 会让 git
  //   顺手把空父目录也删掉（顶层因此变化），同级还有兄弟 ref 存活时则不会
  {
    name: "branch nested/deep（父目录不存在，新建第一个）",
    op: (r) => git(r, "branch", "nested/deep"),
  },
  {
    name: "branch -D nested/deep（删掉后空父目录被 git 一并清掉）",
    prep: (r) => git(r, "branch", "nested/deep"),
    op: (r) => git(r, "branch", "-D", "nested/deep"),
  },
  {
    name: "branch feature/c（父目录已存在）",
    prep: (r) => git(r, "branch", "feature/a"),
    op: (r) => git(r, "branch", "feature/c"),
  },
  {
    name: "tag rel/z（父目录已存在）",
    prep: (r) => git(r, "tag", "rel/x"),
    op: (r) => git(r, "tag", "rel/z"),
  },
  {
    name: "tag -d rel/z（同级还有兄弟 ref 存活，父目录不会被清掉）",
    prep: (r) => {
      git(r, "tag", "rel/x")
      git(r, "tag", "rel/z")
    },
    op: (r) => git(r, "tag", "-d", "rel/z"),
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

  // refs/ 下的命名空间目录多到超出上界时，宁可每轮全价刷新，也不要「只遍历前 N 个」——
  // 那等于给漏判开了一个既随机又不可解释的口子
  it("refs/ 下的目录数超出上界 → 返回 null（不可缓存）", () => {
    const repo = makeRepo()
    expect(gitFingerprint(repo, "o")).not.toBeNull() // 前提：正常仓库当然是可缓存的
    for (let i = 0; i < 300; i++) mkdirSync(join(repo, ".git", "refs", `ns${i}`), { recursive: true })
    expect(gitFingerprint(repo, "o")).toBeNull()
  })

  // readdirSync 的返回顺序不保证跨调用稳定；不排序的话指纹会在内容根本没变时抖动，
  // 表现为缓存永远不命中——这套机制整个失效，且没有任何报错
  it("嵌套命名空间下反复求值仍然稳定（遍历顺序不得泄漏进指纹）", () => {
    const repo = makeRepo()
    git(repo, "branch", "feature/a")
    git(repo, "branch", "release/1.0/rc")
    git(repo, "tag", "rel/x")
    expect(gitFingerprint(repo, "o")).toBe(gitFingerprint(repo, "o"))
  })

  it("FETCH_HEAD 从无到有 → 指纹变化", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "o")
    mkdirSync(join(repo, ".git"), { recursive: true })
    writeFileSync(join(repo, ".git", "FETCH_HEAD"), "deadbeef\n")
    expect(gitFingerprint(repo, "o")).not.toBe(before)
  })
})
