import { describe, expect, it } from "vitest"
import { mergeRepo, parentOf } from "../src/lib/repos"
import type { RepoStatus } from "../src/types"

const stub = (id: string, name: string): RepoStatus => ({
  id, path: id, name, group: "g", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null, mergedBranches: [],
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: -1, behind: -1, upstream: null, stashCount: 0, remotes: [], lastCommit: null,
  health: [], githubInbox: null, stashOldest: null, release: null, error: null, scannedAt: "",
})

describe("mergeRepo", () => {
  it("replaces by id keeping order", () => {
    const out = mergeRepo([stub("1", "a"), stub("2", "b")], stub("1", "a2"))
    expect(out.map((r) => r.name)).toEqual(["a2", "b"])
  })
  it("appends unknown repos", () => {
    expect(mergeRepo([stub("1", "a")], stub("3", "c"))).toHaveLength(2)
  })
})

describe("parentOf", () => {
  it("keeps the separator when the parent is a volume root", () => {
    // 切掉分隔符会得到 `D:`（盘符相对路径）和 ``（空串），服务端的 isAbsolute 两种都判假，
    // 于是对着一块真实存在的盘回「父目录不存在」
    expect(parentOf("D:\\015-foo", "015-foo")).toBe("D:\\")
    expect(parentOf("/015-foo", "015-foo")).toBe("/")
  })
  it("drops the separator everywhere else", () => {
    expect(parentOf("D:\\365\\015-foo", "015-foo")).toBe("D:\\365")
    expect(parentOf("/home/me/code/015-foo", "015-foo")).toBe("/home/me/code")
    expect(parentOf("\\\\server\\share\\015-foo", "015-foo")).toBe("\\\\server\\share")
  })
})
