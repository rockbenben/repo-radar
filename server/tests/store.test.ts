import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { deriveGroup, pathGoneMessage, RepoStore } from "../src/store"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

describe("deriveGroup", () => {
  // 用原生路径（join 走当前平台分隔符）构造——deriveGroup 内部用 path.relative + path.sep，
  // 硬编码 Windows 的 "D:\\proj" 在 Linux/macOS 上反斜杠不算分隔符，会被判成 "(manual)"。
  // 目录无需真实存在：deriveGroup 是纯路径字符串运算。
  const root = join(tmpdir(), "rr-proj")
  it("uses first path segment under root", () => {
    expect(deriveGroup(join(root, "365", "027"), [root])).toBe("365")
  })
  it("uses (root) for repos directly under root", () => {
    expect(deriveGroup(join(root, "solo"), [root])).toBe("(root)")
  })
  it("uses (manual) for paths outside all roots", () => {
    expect(deriveGroup(join(tmpdir(), "rr-elsewhere", "x"), [root])).toBe("(manual)")
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

describe("manualRepos 路径失效", () => {
  it("路径不存在的 manualRepo 仍出现在列表里，并带错误说明", async () => {
    const gone = join(tmpdir(), "rr-definitely-not-here-" + Date.now())
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [], manualRepos: [gone] }
    const list = await new RepoStore(() => cfg).refreshAll()
    const entry = list.find((r) => r.path === gone)
    expect(entry).toBeDefined()
    expect(entry!.error).toContain(gone)
  })
})

/**
 * 路径失效的守卫最初只为 manualRepos 而写，但**同一个守卫也会对扫描根下的仓库触发**：
 * 仓库被删/改名，或网络盘在 `scan()` 枚举与 `mapLimit` 处理之间抖动（并发 8 处理几百个
 * 仓库时这个窗口是秒级的）。对这些仓库说「请在配置文件的 manualRepos 中更新这条路径」是
 * **无法执行的指示**——用户打开 config.json，manualRepos 里根本没有这条路径。
 */
describe("路径失效提示按仓库来源分文案", () => {
  const gone = join(tmpdir(), "rr-definitely-not-here-msg")

  it("manualRepo：指向配置文件的 manualRepos（那是唯一能改的地方）", () => {
    const msg = pathGoneMessage(gone, { ...DEFAULT_CONFIG, roots: [], manualRepos: [gone] })
    expect(msg).toContain(gone)
    expect(msg).toContain("manualRepos")
  })

  it("扫描根下的仓库：不得指向 manualRepos，而是说明下一轮扫描会自行更正", () => {
    const msg = pathGoneMessage(gone, { ...DEFAULT_CONFIG, roots: [tmpdir()], manualRepos: [] })
    expect(msg).toContain(gone)
    expect(msg).not.toContain("manualRepos")
    expect(msg).toContain("下一轮全量扫描")
  })

  // 归一化后比较而不是裸 includes：分隔符风格随手一改就对不上，比不上就退到「扫描根」文案，
  // 那对真正的 manualRepo 又成了另一句无法执行的指示（win32 上 join 给出反斜杠；
  // POSIX 上两种拼写本来就是同一个字符串，这条用例退化成恒等，无害）
  it("manualRepos 里分隔符风格不同也认得出是手动仓库", () => {
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [], manualRepos: [gone.replace(/\\/g, "/")] }
    expect(pathGoneMessage(gone, cfg)).toContain("manualRepos")
  })

  // 端到端：守卫真的会对扫描根下的仓库触发，且吐出来的是扫描根那句（H3 回归）
  it("扫描根下的仓库消失后，refreshOne 的错误文案不提 manualRepos", async () => {
    const root = mkdtempSync(join(tmpdir(), "rr-gone-root-"))
    const repo = makeRepo()
    const moved = join(root, basename(repo))
    renameSync(repo, moved)
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root], manualRepos: [] }
    const store = new RepoStore(() => cfg)
    const first = (await store.refreshAll()).find((r) => r.path === moved)!
    expect(first.error).toBeNull()

    rmSync(moved, { recursive: true, force: true, maxRetries: 3 })
    const after = await store.refreshOne(first.id)
    expect(after?.error).toContain(moved)
    expect(after?.error).not.toContain("manualRepos")
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
})
