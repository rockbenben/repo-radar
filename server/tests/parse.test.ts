import { describe, expect, it } from "vitest"
import { parseLastCommit, parseRemotes, parseStatus } from "../src/git"

describe("parseStatus", () => {
  it("parses clean repo with upstream", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "",
    ].join("\n")
    expect(parseStatus(out)).toEqual({
      branch: "main",
      ahead: 2,
      behind: 1,
      upstream: "origin/main",
      dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      oid: "1234567890abcdef",
      paths: [],
    })
  })

  it("returns -1/-1 with upstream null when no upstream is configured", () => {
    const out = ["# branch.oid abc", "# branch.head main", ""].join("\n")
    const p = parseStatus(out)
    expect(p.ahead).toBe(-1)
    expect(p.behind).toBe(-1)
    expect(p.upstream).toBeNull()
  })

  // PR 合并后远程自动删分支 + fetch --prune：git 仍给 branch.upstream，但远程跟踪 ref 没了，
  // 算不出差距所以没有 branch.ab。只看 ahead 的话这与「没配上游」一模一样，而说这个分支
  // 「未跟踪上游」既与事实相反，又会把用户推向 git push -u（把刚删掉的远程分支推回去）
  it("keeps the upstream name when the remote branch is gone (no branch.ab line)", () => {
    const out = ["# branch.oid abc", "# branch.head feat", "# branch.upstream origin/feat", ""].join("\n")
    const p = parseStatus(out)
    expect(p.ahead).toBe(-1)
    expect(p.upstream).toBe("origin/feat")
  })

  it("detects detached HEAD", () => {
    const out = ["# branch.oid abc", "# branch.head (detached)", ""].join("\n")
    expect(parseStatus(out).branch).toBeNull()
  })

  it("counts staged/unstaged/untracked/conflicted entries", () => {
    const out = [
      "# branch.head main",
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt", // 仅 staged
      "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt", // 仅 unstaged
      "1 MM N... 100644 100644 100644 aaa bbb both.txt", // 两者都算
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt", // rename 记 staged
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
      "? untracked.txt",
      "",
    ].join("\n")
    expect(parseStatus(out).dirty).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1 })
  })

  // 路径要拿去 stat（worktreeTouchedAt），取错就是静默失效：stat 一个不存在的路径不报错，
  // 只是「最近活跃」永远不动。这一组是 git 2.48 的真实输出，四种记录路径前的字段数各不相同
  it("extracts the working-tree path from all four record types", () => {
    const out = [
      "# branch.oid 0320967b",
      "# branch.head main",
      "1 .D N... 100644 100644 000000 4bcfe98e 4bcfe98e gone.txt",
      "2 R. N... 100644 100644 100644 61780798 61780798 R100 renamed to.txt\tren ame.txt",
      "1 MM N... 100644 100644 100644 78981922 9ad2ebba sub dir/tracked file.txt",
      "u UU N... 100644 100644 100644 100644 df967b96 ba2906d0 e45c9c26 con flict.txt",
      "? node_modules/",
      "? top level untracked.txt",
      "",
    ].join("\n")
    expect(parseStatus(out).paths).toEqual([
      "gone.txt",
      "renamed to.txt", // rename 取**新**路径：旧路径已经不在磁盘上，stat 不到
      "sub dir/tracked file.txt", // 路径含空格，不能 split(" ") 取某一项
      "con flict.txt",
      "node_modules/", // 未跟踪目录带尾分隔符；由 worktreeTouchedAt 负责剔除，不在这里
      "top level untracked.txt",
    ])
  })
})

describe("parseRemotes", () => {
  it("dedupes fetch/push pairs", () => {
    const out = [
      "origin\thttps://github.com/u/r.git (fetch)",
      "origin\thttps://github.com/u/r.git (push)",
      "backup\tD:\\bare\\r (fetch)",
      "backup\tD:\\bare\\r (push)",
    ].join("\n")
    expect(parseRemotes(out)).toEqual([
      { name: "origin", url: "https://github.com/u/r.git" },
      { name: "backup", url: "D:\\bare\\r" },
    ])
  })

  it("returns empty for no remotes", () => {
    expect(parseRemotes("")).toEqual([])
  })
})

describe("parseLastCommit", () => {
  it("parses null-separated log output", () => {
    const out = ["abc123", "fix: message with spaces", "Alice", "2026-07-01T10:00:00+08:00"].join("\0")
    expect(parseLastCommit(out + "\n")).toEqual({
      hash: "abc123",
      message: "fix: message with spaces",
      author: "Alice",
      date: "2026-07-01T10:00:00+08:00",
    })
  })

  it("returns null for empty output", () => {
    expect(parseLastCommit("")).toBeNull()
  })
})

describe("parseStatus — branch.oid", () => {
  it("解析出 HEAD 的 oid", () => {
    const out = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head main",
      "# branch.ab +0 -0",
    ].join("\n")
    expect(parseStatus(out).oid).toBe("1234567890abcdef1234567890abcdef12345678")
  })

  it("空仓库的 (initial) 按缺失处理", () => {
    expect(parseStatus("# branch.oid (initial)\n# branch.head main").oid).toBeNull()
  })

  it("没有 branch.oid 行时为 null", () => {
    expect(parseStatus("# branch.head main").oid).toBeNull()
  })
})
