import { describe, expect, it } from "vitest"
import { mergeRepo } from "../src/lib/repos"
import type { RepoStatus } from "../src/types"

const stub = (id: string, name: string): RepoStatus => ({
  id, path: id, name, group: "g", tags: [], favorite: false, branch: "main",
  displayName: null, description: null, language: null, archived: false, note: null, lastOpened: null, mergedBranches: [],
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  ahead: -1, behind: -1, stashCount: 0, remotes: [], lastCommit: null,
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
