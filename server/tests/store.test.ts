import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { deriveGroup, RepoStore } from "../src/store"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

describe("deriveGroup", () => {
  it("uses first path segment under root", () => {
    expect(deriveGroup("D:\\proj\\365\\027", ["D:\\proj"])).toBe("365")
  })
  it("uses (root) for repos directly under root", () => {
    expect(deriveGroup("D:\\proj\\solo", ["D:\\proj"])).toBe("(root)")
  })
  it("uses (manual) for paths outside all roots", () => {
    expect(deriveGroup("E:\\elsewhere\\x", ["D:\\proj"])).toBe("(manual)")
  })
  it("uses (root) when the repo is itself a configured root", () => {
    expect(deriveGroup("D:\\proj", ["D:\\proj"])).toBe("(root)")
  })
})

function makeRoot(): { root: string; repoA: string; repoB: string } {
  // 把两个 fixture 仓库移到同一个可扫描的 root 下
  const root = mkdtempSync(join(tmpdir(), "rr-store-root-"))
  const a = makeRepo()
  const b = makeRepo({ dirty: true })
  mkdirSync(join(root, "grp"), { recursive: true })
  const repoA = join(root, basename(a))
  const repoB = join(root, "grp", basename(b))
  renameSync(a, repoA)
  renameSync(b, repoB)
  return { root, repoA, repoB }
}

describe("RepoStore", () => {
  it("refreshAll discovers repos, applies groups and config decorations", async () => {
    const { root, repoA, repoB } = makeRoot()
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    const repos = await store.refreshAll()
    expect(repos).toHaveLength(2)
    const a = repos.find((r) => r.path === repoA)!
    const b = repos.find((r) => r.path === repoB)!
    expect(a.group).toBe("(root)")
    expect(b.group).toBe("grp")
    expect(b.dirty.untracked).toBe(1)
    expect(store.get(a.id)?.path).toBe(repoA)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it("decorate populates health issues", async () => {
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), manualRepos: [makeRepo({ dirty: true })] }
    const store = new RepoStore(() => cfg)
    const repos = await store.refreshAll()
    expect(repos[0].health.map((h) => h.rule)).toContain("dirty")
    expect(repos[0].health.map((h) => h.rule)).toContain("no-remote")
  })

  it("produces error status for a broken manual repo instead of throwing", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "rr-broken-"))
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), manualRepos: [notARepo] }
    const store = new RepoStore(() => cfg)
    const repos = await store.refreshAll()
    expect(repos).toHaveLength(1)
    expect(repos[0].error).toBeTruthy()
    expect(repos[0].group).toBe("(manual)")
    rmSync(notARepo, { recursive: true, force: true, maxRetries: 3 })
  })

  it("list is sorted by name", async () => {
    const { root } = makeRoot()
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const names = store.list().map((r) => r.name)
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)))
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("github description override", () => {
  it("prefers the github description over the local one, and falls back when absent", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "package.json"), JSON.stringify({ description: "local desc" }))
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), manualRepos: [repo] }
    const ghDesc = new Map<string, string>()
    const store = new RepoStore(
      () => cfg,
      (id) => ghDesc.get(id) ?? null,
    )
    // 缓存空 → 用本地 package.json 描述
    const repos = await store.refreshAll()
    const id = repos[0].id
    expect(store.get(id)!.description).toBe("local desc")
    // 模拟后台补全写入缓存后 redecorate → GitHub 描述优先
    ghDesc.set(id, "github desc")
    expect(store.redecorate(id)!.description).toBe("github desc")
    // 再次全量扫描（decorate 覆盖新鲜的本地描述）仍保持 GitHub 优先
    await store.refreshAll()
    expect(store.get(id)!.description).toBe("github desc")
    // GitHub 描述被清空后应回退到本地，而非残留旧的 GitHub 描述（redecorate 复用已覆盖对象的场景）
    ghDesc.delete(id)
    expect(store.redecorate(id)!.description).toBe("local desc")
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("refreshOne", () => {
  it("re-reads a single repo and updates the map", async () => {
    const { root, repoA } = makeRoot()
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const id = store.list().find((r) => r.path === repoA)!.id
    expect(store.get(id)!.dirty.untracked).toBe(0)
    writeFileSync(join(repoA, "extra.txt"), "x")
    const updated = await store.refreshOne(id)
    expect(updated!.dirty.untracked).toBe(1)
    expect(store.get(id)!.dirty.untracked).toBe(1)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it("returns undefined for unknown id", async () => {
    const store = new RepoStore(() => structuredClone(DEFAULT_CONFIG))
    expect(await store.refreshOne("nope")).toBeUndefined()
  })

  it("does not resurrect a repo removed by a concurrent full rescan", async () => {
    const { root, repoA } = makeRoot()
    let cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const id = store.list().find((r) => r.path === repoA)!.id
    cfg = { ...structuredClone(DEFAULT_CONFIG), roots: [] } // 仓库不再被扫描
    await Promise.all([store.refreshOne(id), store.refreshAll()])
    expect(store.get(id)).toBeUndefined()
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("refreshAll concurrency", () => {
  it("reuses the in-flight promise and reports progress", async () => {
    const { root } = makeRoot()
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    const ticks: number[] = []
    const p1 = store.refreshAll((scanned) => ticks.push(scanned))
    const p2 = store.refreshAll()
    expect(p2).toBe(p1) // 同一个 in-flight promise
    const repos = await p1
    expect(ticks[ticks.length - 1]).toBe(repos.length)
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("redecorate", () => {
  it("reapplies config (group/tags/favorite) without touching git", async () => {
    const { root, repoA } = makeRoot()
    let cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const id = store.list().find((r) => r.path === repoA)!.id
    expect(store.get(id)!.favorite).toBe(false)
    expect(store.get(id)!.tags).toEqual([])
    cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      roots: [root],
      favorites: [id],
      tags: { [id]: ["web", "tool"] },
      groupOverrides: { [id]: "手动组" },
    }
    const updated = store.redecorate(id)
    expect(updated!.favorite).toBe(true)
    expect(updated!.tags).toEqual(["web", "tool"])
    expect(updated!.group).toBe("手动组")
    expect(store.get(id)!.favorite).toBe(true) // 已写回 map
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it("returns undefined for unknown id", () => {
    const store = new RepoStore(() => structuredClone(DEFAULT_CONFIG))
    expect(store.redecorate("nope")).toBeUndefined()
  })
})
