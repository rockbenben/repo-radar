import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { RepoCache } from "../src/repo-cache"
import type { RepoHeavy } from "../src/git"

const dirs: string[] = []
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-cache-"))
  dirs.push(d)
  return join(d, "repo-cache.json")
}
afterAll(() => {
  // maxRetries: 3——与套件里其余「异步/防抖写盘 + force:true 清理」的文件一致（desc-cache.test.ts、
  // inbox-cache.test.ts、store.test.ts 等 20+ 处）：并发 I/O 下 rmSync 偶发因文件正被写入而失败，
  // 重试几次就过去了，不加则在负载高时表现为 EPERM
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const heavy: RepoHeavy = {
  stashCount: 2, stashOldest: "2026-01-01T00:00:00Z", release: null, remotes: [],
  lastCommit: null, mergedBranches: [], displayName: "x", description: null, language: "TypeScript",
}

describe("RepoCache", () => {
  it("指纹相同 → 命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", "fp-a")).toEqual(heavy)
    c.flush() // debounceMs 1000：不 flush 的话 setTimeout 会晚于本文件 afterAll 的目录删除才触发
  })

  it("指纹不同 → 未命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", "fp-b")).toBeNull()
    c.flush()
  })

  // gitFingerprint 对 worktree/submodule 返回 null，表示「不可缓存」
  it("指纹为 null → 永远未命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", null)).toBeNull()
    c.flush()
  })

  it("落盘后新实例能读回", () => {
    const file = tmpFile()
    const c = new RepoCache(file)
    c.set("id1", "fp-a", heavy)
    c.flush() // debounceMs 1000：不 flush 的话新实例读到的还是还没落盘的旧内容
    expect(new RepoCache(file).get("id1", "fp-a")).toEqual(heavy)
  })

  it("坏文件当作空缓存，不抛", () => {
    const file = tmpFile()
    writeFileSync(file, "}}}not json")
    expect(new RepoCache(file).get("id1", "fp-a")).toBeNull()
  })

  // 年龄护栏：网络盘瞬时掉线会让一整批仓库在某轮扫描里消失，立即剪会永久抹掉它们的缓存
  it("prune 保留仍在扫描里的条目", () => {
    const c = new RepoCache(tmpFile())
    c.set("keep", "fp", heavy)
    c.set("drop", "fp", heavy)
    c.prune(new Set(["keep"]), 0) // maxAgeMs=0：立刻过筛，测剪枝本身
    expect(c.get("keep", "fp")).toEqual(heavy)
    expect(c.get("drop", "fp")).toBeNull()
    c.flush()
  })

  it("prune 的年龄护栏：刚写入的条目即使不在扫描里也不剪", () => {
    const c = new RepoCache(tmpFile())
    c.set("gone", "fp", heavy)
    c.prune(new Set(), 30 * 86_400_000)
    expect(c.get("gone", "fp")).toEqual(heavy)
    c.flush()
  })
})
