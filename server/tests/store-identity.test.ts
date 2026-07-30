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

  // 「A 改名成 B」+「同一轮里原路径 A 上又出现一个无关仓库」：账本记的 (dev,ino) 现在挂在 B 上，
  // 身份必须跟着仓库走而不是跟着路径走——否则新仓库连人带标签继承 A 的身份、真正的 B 什么都
  // 不剩，且全程无报错。另外两条活路径若共用一个 id，还会让其中一个仓库从看板上凭空消失
  //（doRefreshAll 收尾按 id 建 Map）
  it("同一轮里改名 + 原路径新建仓库 → 身份跟着仓库走，两个都在且 id 不撞", async () => {
    const [parent, repo] = repoInOwnRoot("proj")
    const cfg = configWithRoot(parent)
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, makeLedger())
    const before = (await store.refreshAll()).find((r) => r.path === repo)!
    cfg.tags[before.id] = ["app"]
    cfg.archived.push(before.id)

    const renamed = join(parent, "proj-2026")
    renameSync(repo, renamed)
    execFileSync("git", ["init", "-b", "main", repo]) // 原路径上又出现一个无关仓库

    const list = await store.refreshAll()
    expect(list.length).toBe(2)
    expect(new Set(list.map((r) => r.id)).size).toBe(2)
    const moved = list.find((r) => r.path === renamed)!
    const fresh = list.find((r) => r.path === repo)!
    expect(moved.id).toBe(before.id) // 标签/归档跟着真正的那个仓库走
    expect(moved.tags).toEqual(["app"])
    expect(moved.archived).toBe(true)
    expect(fresh.id).not.toBe(before.id) // 新仓库拿全新 id
    expect(fresh.tags).toEqual([]) // 且不继承别人的标签/归档
    expect(fresh.archived).toBe(false)
  })

  /**
   * E3：`POST /api/new-project` 在 createProject 之后**立刻** rescanFresh，而 createProject
   * 只做 `git init` + 写 README、**不提交**——铸造那一刻仓库必然零提交，播种只能写下 null。
   * 此后这条路径每轮都走「路径命中」，永远不进 computedRoot，回写又是
   * `computedRoot.get(p) ?? prev?.rootCommit ?? null`：于是**经「+ 新建」创建的每一个项目**，
   * 账本里的根提交终身为 null（自己在扫描根里 git init 同理，watcher 2 秒内触发结构重扫）。
   * 判据②对它们等于不存在，而 `ino === "0"` 的文件系统上判据①也被整体作废——两条判据都没有，
   * 一次普通改名就丢标签/收藏/归档/便签。「ino 不可用时靠补算出来的根提交认回老 id」那条
   * 验收在 repo-identity.test.ts（那里才能把 ino 摁成 "0"），这里钉的是 store 这一侧的接线
   */
  it("新建的空仓库提交第一个 commit 后，账本补上根提交（E3）", async () => {
    const parent = isolatedDir("rr-root-")
    const repo = join(parent, "brand-new")
    // 与 createProject 一模一样：mkdir + git init + 写 README，**不提交**
    execFileSync("git", ["init", "-b", "main", repo])
    writeFileSync(join(repo, "README.md"), "# brand-new\n")
    const cfg = configWithRoot(parent)
    const led = makeLedger()
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, led)

    const id = (await store.refreshAll()).find((r) => r.path === repo)!.id
    expect(led.get(id)!.rootCommit).toBeNull() // 铸造那一刻确实一个提交都没有
    await store.refreshAll() // 还是空仓库的那些轮次：补不出东西，也不该白付 git 进程
    await store.refreshAll()
    expect(led.get(id)!.rootCommit).toBeNull()

    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo })
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo })
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo })
    execFileSync("git", ["add", "-A"], { cwd: repo })
    execFileSync("git", ["commit", "-m", "c0"], { cwd: repo })
    const expected = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()

    // 提交之后的轮次：refreshRepo 从 core.oid（status 顺带给的）看出它有提交了，补算一次
    await store.refreshAll()
    expect(led.get(id)!.rootCommit).toBe(expected)
    await store.refreshAll() // 补上之后就不再进补算分支了
    expect(led.get(id)!.rootCommit).toBe(expected)
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
