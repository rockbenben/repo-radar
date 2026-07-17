import { afterAll, describe, expect, it } from "vitest"
import { buildManifest, importManifest, isManifest, type Manifest } from "../src/manifest"
import type { RepoStatus } from "../src/types"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const repo = (over: Partial<RepoStatus>): RepoStatus =>
  ({
    id: "x", path: "C:\\r", name: "r", displayName: null, description: null, language: null,
    group: "g", tags: [], favorite: false, archived: false, note: null, lastOpened: null, mergedBranches: [],
    branch: "main", dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ahead: 0, behind: 0, stashCount: 0, remotes: [], lastCommit: null, health: [], error: null, scannedAt: "",
    ...over,
  }) as RepoStatus

describe("manifest", () => {
  it("buildManifest records name, path, origin remote, group and tags", () => {
    const m = buildManifest(
      [repo({ name: "a", path: "D:\\p\\a", group: "365", tags: ["web"], remotes: [{ name: "origin", url: "git@x:a.git" }] })],
      "2026-07-15T00:00:00Z",
    )
    expect(m.version).toBe(1)
    expect(m.repos[0]).toEqual({ name: "a", path: "D:\\p\\a", remote: "git@x:a.git", group: "365", tags: ["web"] })
  })

  it("isManifest validates shape", () => {
    expect(isManifest({ repos: [{ path: "x" }] })).toBe(true)
    expect(isManifest({ repos: [{ nope: 1 }] })).toBe(false)
    expect(isManifest({})).toBe(false)
    expect(isManifest(null)).toBe(false)
  })

  it("importManifest adds existing repos to manualRepos and reports missing", () => {
    const present = makeRepo()
    const manifest: Manifest = {
      version: 1,
      exportedAt: "",
      repos: [
        { name: "present", path: present, remote: null, group: "", tags: [] },
        { name: "gone", path: "D:\\does\\not\\exist", remote: "git@x:gone.git", group: "", tags: [] },
      ],
    }
    const { manualRepos, summary } = importManifest(manifest, [])
    expect(manualRepos).toContain(present)
    expect(summary.added).toBe(1)
    expect(summary.missing.map((m) => m.name)).toEqual(["gone"])

    // 再次导入同一清单：已跟踪，不重复
    const second = importManifest(manifest, manualRepos)
    expect(second.summary.added).toBe(0)
    expect(second.summary.alreadyTracked).toBe(1)
  })
})
