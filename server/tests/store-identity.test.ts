import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { repoId } from "../src/git"
import { IdentityLedger } from "../src/repo-identity"
import { RepoStore } from "../src/store"

const dirs: string[] = []
function isolatedDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

// 账本的 debounceMs 是 1000：不收尾的话待写定时器会在 rmSync 之后才醒来，
// 而 JsonStore.write 会 mkdirSync 重建目录——临时目录被重新造出来，tmpdir 里留一地垃圾
const ledgers: IdentityLedger[] = []
function makeLedger(): IdentityLedger {
  const led = new IdentityLedger(join(isolatedDir("rr-sid-"), "repo-identity.json"))
  ledgers.push(led)
  return led
}

afterAll(() => {
  for (const led of ledgers.splice(0)) led.flush()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

// structuredClone 而非 { ...DEFAULT_CONFIG }：展开只拷一层，tags/notes/favorites/archived
// 仍与 DEFAULT_CONFIG 共享引用，下面往里塞标签就等于改全局默认配置，污染同文件后续用例
function configWithRoot(parent: string): Config {
  return { ...structuredClone(DEFAULT_CONFIG), roots: [parent] }
}

/**
 * 在一个**专属**父目录里建一个仓库，返回 [父目录, 仓库路径]。
 *
 * 绝对不要用 `dirname(makeRepo())` 当 scan root——`makeRepo` 建在 `tmpdir()` 下，
 * 它的 dirname 就是 `tmpdir()` 本身。拿它当 root，整套测试并行跑时会把**其它测试的
 * 临时仓库全部扫进来**：既慢又互相干扰，任何针对数量或内容的断言都会随机挂掉。
 */
function repoInOwnRoot(name = "demo"): [string, string] {
  const parent = isolatedDir("rr-root-")
  const repo = join(parent, name)
  execFileSync("git", ["init", "-b", "main", repo])
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo })
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo })
  writeFileSync(join(repo, "a.txt"), "1")
  execFileSync("git", ["add", "-A"], { cwd: repo })
  execFileSync("git", ["commit", "-m", "c0"], { cwd: repo })
  return [parent, repo]
}

describe("RepoStore + 身份账本", () => {
  // 现有用户升级时账本为空。这一条挂了就意味着所有人的标签/收藏/归档在升级瞬间全丢
  it("账本为空时，id 与 repoId(路径) 完全一致（向后兼容）", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())
    const list = await store.refreshAll()
    expect(list.find((r) => r.path === repo)?.id).toBe(repoId(repo))
  })

  it("改名后 id 不变，标签/收藏/归档/便签全部保留", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())

    const before = (await store.refreshAll()).find((r) => r.path === repo)!
    // 用户给它打上标签、收藏、归档、便签
    cfg.tags[before.id] = ["app"]
    cfg.favorites.push(before.id)
    cfg.archived.push(before.id)
    cfg.notes[before.id] = "记一笔"

    const renamed = join(parent, "demo-renamed")
    renameSync(repo, renamed)

    const after = (await store.refreshAll()).find((r) => r.path === renamed)!
    expect(after.id).toBe(before.id)
    expect(after.tags).toEqual(["app"])
    expect(after.favorite).toBe(true)
    expect(after.archived).toBe(true)
    expect(after.note).toBe("记一笔")
  })

  // 不传账本时必须完全退化成改造前的行为，便于回退与嵌入式用法
  it("未提供账本时按路径算 id（旧行为）", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg = configWithRoot(parent)
    const list = await new RepoStore(() => cfg).refreshAll()
    expect(list.find((r) => r.path === repo)?.id).toBe(repoId(repo))
  })

  // 改名后的仓库用的是账本认回的老 id。git 读失败（仓库正被删、被杀软锁住）走的是
  // errorStatus 分支，那条状态若按新路径重算 id，就与它在 repos 里的键对不上——
  // 界面上这个仓库的标签/收藏/归档当场全没
  it("改名后 refreshOne 出错，错误状态仍用老 id", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())
    const before = (await store.refreshAll()).find((r) => r.path === repo)!
    const renamed = join(parent, "demo-moved")
    renameSync(repo, renamed)
    const after = (await store.refreshAll()).find((r) => r.path === renamed)!
    expect(after.id).toBe(before.id)

    rmSync(renamed, { recursive: true, force: true, maxRetries: 3 }) // 仓库没了 → git 读必然失败
    const errored = await store.refreshOne(after.id)
    expect(errored?.error).toBeTruthy()
    expect(errored?.id).toBe(before.id)
  })

  // 两条活路径共用一个 id，会让其中一个仓库从看板上凭空消失（store 按 id 建 Map），
  // 比丢标签严重得多
  it("同一轮里改名 + 原路径新建仓库 → 两个仓库都在，id 不撞", async () => {
    const [parent, repo] = repoInOwnRoot("proj")
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())
    const before = (await store.refreshAll()).find((r) => r.path === repo)!

    renameSync(repo, join(parent, "proj-2026"))
    execFileSync("git", ["init", "-b", "main", repo]) // 原路径上又出现一个无关仓库

    const list = await store.refreshAll()
    expect(list.length).toBe(2)
    expect(new Set(list.map((r) => r.id)).size).toBe(2)
    // 路径命中优先于 ino（见 repo-identity 的「同一路径上 ino 变了 → 仍是同一仓库」：
    // 「删掉重新 clone 回原路径」远比「原路径新建无关仓库」常见）。要紧的是两者不共用 id
    expect(list.find((r) => r.path === repo)!.id).toBe(before.id)
  })

  it("新增一个仓库不影响已有仓库的 id", async () => {
    const [parent, a] = repoInOwnRoot("a")
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())
    const idA = (await store.refreshAll()).find((r) => r.path === a)!.id
    execFileSync("git", ["init", "-b", "main", join(parent, "b")])
    expect((await store.refreshAll()).find((r) => r.path === a)!.id).toBe(idA)
  })
})
