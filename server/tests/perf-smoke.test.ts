import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import * as git from "../src/git"
import { RepoCache } from "../src/repo-cache"
import { IdentityLedger } from "../src/repo-identity"
import { RepoStore } from "../src/store"

// 端到端冒烟：不 mock git，跑真实仓库，证明缓存 + 身份账本这两条杠杆接在一起时
// 确实起作用——单元测试各自证明过缓存跳过 heavy、账本认领改名，但没有一个用例
// 把它们接在同一个 RepoStore 实例上，从「首次扫描」走到「改名后的第二轮」。

const dirs: string[] = []
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
// 缓存/账本落盘是防抖的（debounceMs 1000）：不 flush 就 rmSync，待写定时器会在目录
// 已删除之后才醒来，JsonStore.write 又会 mkdirSync 把目录重新造出来，在 tmpdir 里留一地垃圾。
// maxRetries: 3 与套件里其余「异步写盘 + 清理」用例一致（store-cache.test.ts 等）：
// 并发 I/O 下 rmSync 偶发因文件正被写入而失败，重试几次就过去了
const flushables: { flush(): void }[] = []
afterAll(() => {
  for (const f of flushables.splice(0)) f.flush()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

/**
 * 在一个专属父目录下建 n 个仓库。绝对不能拿 `dirname(makeRepo())` 当 scan root——
 * fixtures.ts 的 makeRepo() 建在 tmpdir() 下，它的 dirname 就是 tmpdir() 本身，
 * 拿它当 root 会把测试进程里其它并发用例的临时仓库一并扫进来
 */
function makeRepos(parent: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = join(parent, `repo-${i}`)
    execFileSync("git", ["init", "-b", "main", d])
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: d })
    execFileSync("git", ["config", "user.name", "t"], { cwd: d })
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: d })
    writeFileSync(join(d, "a.txt"), "1")
    execFileSync("git", ["add", "-A"], { cwd: d })
    execFileSync("git", ["commit", "-m", "c0"], { cwd: d })
    return d
  })
}

describe("端到端：缓存 + 身份账本接在同一个 RepoStore 上", () => {
  it("10 个仓库第二轮重扫的 heavy 调用降为 0，且改名后身份保留", async () => {
    const parent = tmpDir("rr-e2e-")
    const repos = makeRepos(parent, 10)
    // structuredClone 而非 { ...DEFAULT_CONFIG }：展开只拷一层，tags 仍与 DEFAULT_CONFIG
    // 共享引用，下面往里塞标签就等于改全局默认配置，污染同进程里其它用例
    const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [parent] }
    const cache = new RepoCache(join(tmpDir("rr-e2ec-"), "c.json"))
    const identity = new IdentityLedger(join(tmpDir("rr-e2ei-"), "i.json"))
    flushables.push(cache, identity)
    const store = new RepoStore(() => cfg, undefined, undefined, cache, identity)

    const first = await store.refreshAll()
    expect(first.length).toBe(10)

    // 第二轮：10 个仓库都没动过，六个 heavy 字段应全部命中指纹缓存，一个 heavy 都不跑
    const spy = vi.spyOn(git, "getRepoHeavy")
    await store.refreshAll()
    expect(spy.mock.calls.length).toBe(0)
    spy.mockRestore()

    // 给第 0 个仓库打标签，然后改名——身份账本应当认回同一个 id，标签跟着走
    const target = first.find((r) => r.path === repos[0])!
    cfg.tags[target.id] = ["e2e"]
    const renamed = join(parent, "repo-0-renamed")
    renameSync(repos[0], renamed)

    const after = await store.refreshAll()
    expect(after.length).toBe(10) // 改名不是增删，仓库数不变
    const moved = after.find((r) => r.path === renamed)!
    expect(moved.id).toBe(target.id)
    expect(moved.tags).toEqual(["e2e"])
  })
})
