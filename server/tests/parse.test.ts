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
      dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    })
  })

  it("returns -1/-1 when no upstream (no branch.ab line)", () => {
    const out = ["# branch.oid abc", "# branch.head main", ""].join("\n")
    const p = parseStatus(out)
    expect(p.ahead).toBe(-1)
    expect(p.behind).toBe(-1)
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
