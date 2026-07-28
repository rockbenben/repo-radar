import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { IdentityLedger, matchClaims, normalizePath, type ClaimCandidate } from "../src/repo-identity"
import { repoId } from "../src/git"

const dirs: string[] = []
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-id-"))
  dirs.push(d)
  return join(d, "repo-identity.json")
}

// 账本的 debounceMs 是 1000：不收尾的话待写定时器会在 rmSync 之后才醒来，
// 而 JsonStore.write 会 mkdirSync 重建目录——临时目录被重新造出来，tmpdir 里留一地垃圾
const ledgers: IdentityLedger[] = []
function makeLedger(file: string): IdentityLedger {
  const led = new IdentityLedger(file)
  ledgers.push(led)
  return led
}

afterAll(() => {
  for (const led of ledgers.splice(0)) led.flush()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const cand = (dev: number, ino: number, rootCommit: string | null = null): ClaimCandidate => ({ dev, ino, rootCommit })
const noRootCommit = async () => null

describe("matchClaims", () => {
  it("dev+ino 一一对应 → 认领", () => {
    const lost = new Map([["oldId", cand(1, 100)]])
    const found = new Map([["D:/new-name", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/new-name", "oldId"]]))
  })

  it("dev 不同（跨卷）→ ino 判据不匹配，退到根提交", () => {
    const lost = new Map([["oldId", cand(1, 100, "rootA")]])
    const found = new Map([["E:/moved", cand(2, 100, "rootA")]])
    expect(matchClaims(lost, found)).toEqual(new Map([["E:/moved", "oldId"]]))
  })

  // FAT32/exFAT/部分网络盘上 Node 拿不到稳定文件 id，stat().ino 全是 0。
  // 拿 0 参与匹配会让所有仓库互相「相等」，把身份认串——这是最危险的一条
  it("ino 为 0 → 该判据整体作废，不得互相认领", () => {
    const lost = new Map([["a", cand(1, 0)], ["b", cand(1, 0)]])
    const found = new Map([["D:/x", cand(1, 0)], ["D:/y", cand(1, 0)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("ino 为 0 但有根提交 → 按根提交认领", () => {
    const lost = new Map([["a", cand(1, 0, "rootA")]])
    const found = new Map([["D:/x", cand(1, 0, "rootA")]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"]]))
  })

  // 空串是 ino===0 的同类陷阱：一个哨兵值让两个无关仓库「相等」。
  // rootCommitOf 在空仓库 / git 读失败时很容易返回 ""，老版本或被改坏的账本条目里也可能是 ""
  it("根提交为空串（空仓库 / 读失败的返回值）→ 该判据作废，不得互相认领", () => {
    const lost = new Map([["a", cand(1, 0, "")]])
    const found = new Map([["D:/x", cand(1, 0, "")]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  // 宁可不认，也不要认错：认错产生的是错误数据，不认只是退回现状
  it("同一判据值出现多于一次 → 全部放弃，不猜", () => {
    const lost = new Map([["a", cand(1, 100)], ["b", cand(1, 100)]])
    const found = new Map([["D:/x", cand(1, 100)], ["D:/y", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("多个仓库同时改名，各自 ino 不同 → 全部正确认领，不串", () => {
    const lost = new Map([["a", cand(1, 100)], ["b", cand(1, 200)]])
    const found = new Map([["D:/y", cand(1, 200)], ["D:/x", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"], ["D:/y", "b"]]))
  })

  it("根提交为 null 的一方不参与根提交匹配", () => {
    const lost = new Map([["a", cand(1, 100, null)]])
    const found = new Map([["D:/x", cand(2, 300, null)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("ino 已配对的不再参与根提交匹配", () => {
    const lost = new Map([["a", cand(1, 100, "shared")], ["b", cand(1, 999, "shared")]])
    const found = new Map([["D:/x", cand(1, 100, "shared")]])
    // a 靠 ino 被认领；b 与 D:/x 不该再因为 rootCommit 相同而二次配对
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"]]))
  })

  it("没有丢失的 id → 空结果", () => {
    expect(matchClaims(new Map(), new Map([["D:/x", cand(1, 1)]]))).toEqual(new Map())
  })

  // resolve 会拿同一组候选跑两轮（先只用 ino，不够再补根提交），第一轮若改坏了入参，
  // 第二轮的判据就不再是调用方给的那份
  it("不修改入参（纯函数）", () => {
    const lost = new Map([["a", cand(1, 100)]])
    const found = new Map([["D:/x", cand(1, 100)]])
    matchClaims(lost, found)
    expect(lost).toEqual(new Map([["a", cand(1, 100)]]))
    expect(found).toEqual(new Map([["D:/x", cand(1, 100)]]))
  })
})

describe("normalizePath", () => {
  it("统一分隔符与大小写", () => {
    expect(normalizePath("D:\\Repo\\A")).toBe(normalizePath("d:/repo/a"))
  })
})

describe("IdentityLedger", () => {
  it("首次见到的路径按 repoId(path) 铸造 —— 与现有 config.json 里的 id 完全一致", async () => {
    const led = makeLedger(tmpFile())
    const p = join("D:", "projects", "demo")
    const ids = await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    expect(ids.get(p)).toBe(repoId(p))
  })

  it("已知路径复用账本里的 id", async () => {
    const file = tmpFile()
    const p = join("D:", "projects", "demo")
    const led = makeLedger(file)
    const first = await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    led.flush() // 防抖 1s：不 flush 的话第二个实例读到的是空文件
    const second = await makeLedger(file).resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    expect(second.get(p)).toBe(first.get(p))
  })

  it("改名后沿用老 id（这是整个杠杆 4 的目的）", async () => {
    const file = tmpFile()
    const oldP = join("D:", "projects", "demo")
    const newP = join("D:", "projects", "demo-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(oldP)
    const after = (await led.resolve([newP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(newP)
    expect(after).toBe(before)
  })

  // 真实场景里改名多半发生在两次运行之间（关掉应用改名再打开），认领必须跨实例走落盘的账本
  it("改名发生在两次运行之间（另起实例读盘）→ 仍沿用老 id", async () => {
    const file = tmpFile()
    const oldP = join("D:", "projects", "restart")
    const newP = join("D:", "projects", "restart-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(oldP)
    led.flush()
    const after = (await makeLedger(file).resolve([newP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(newP)
    expect(after).toBe(before)
    expect(after).toBe(repoId(oldP))
  })

  it("复制出一份副本（原仓库还在）→ 副本铸造新 id", async () => {
    const led = makeLedger(tmpFile())
    const a = join("D:", "p", "a")
    const b = join("D:", "p", "b")
    await led.resolve([a], noRootCommit, () => ({ dev: 1, ino: 1 }))
    const ids = await led.resolve([a, b], noRootCommit, (p) => ({ dev: 1, ino: p === a ? 1 : 2 }))
    expect(ids.get(b)).toBe(repoId(b))
    expect(ids.get(b)).not.toBe(ids.get(a))
  })

  // 路径命中即同一仓库，不再比对 ino。理由：「删掉重新 clone 同一个仓库到原路径」很常见
  // （ino 会变），若因此作废身份，用户的标签/收藏/归档会莫名消失；而「删掉后在同一路径
  // 新建一个无关仓库」罕见得多。路径命中就用老 id，也符合「这个文件夹就是我那个项目」的直觉
  it("同一路径上 ino 变了（重新 clone / 从备份恢复）→ 仍是同一仓库，身份不变", async () => {
    const file = tmpFile()
    const p = join("D:", "p", "same-name")
    const led = makeLedger(file)
    const before = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)
    // 路径没变但 ino 变了：这条路径在账本里已知，直接命中——根本不进认领流程
    const after = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 2 }))).get(p)
    expect(after).toBe(before)
  })

  // 仓库改名后 newP 用着 repoId(oldP)，此时用户又在 oldP 新建一个无关仓库，
  // 按路径铸造算出的正是这个已被占用的 id。两条活路径共用一个 id 会让 store 把
  // 标签/归档直接串到另一个仓库头上——是「产生错误数据」，比丢数据严重
  it("改名后原路径又新建仓库 → 两条活路径不得共用同一个 id", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "proj")
    const newP = join("D:", "p", "proj-2026")
    const led = makeLedger(file)
    await led.resolve([oldP], noRootCommit, () => ({ dev: 1, ino: 7 }))
    const renamed = (await led.resolve([newP], noRootCommit, () => ({ dev: 1, ino: 7 }))).get(newP)
    expect(renamed).toBe(repoId(oldP))
    const ids = await led.resolve([newP, oldP], noRootCommit, (p) => ({ dev: 1, ino: p === newP ? 7 : 8 }))
    expect(ids.get(newP)).toBe(renamed)
    expect(ids.get(oldP)).not.toBe(renamed)
  })

  it("stat 失败（仓库不可读）不影响其它仓库的解析", async () => {
    const led = makeLedger(tmpFile())
    const a = join("D:", "p", "a")
    const ids = await led.resolve([a], noRootCommit, () => null)
    expect(ids.get(a)).toBe(repoId(a))
  })

  it("prune 带年龄护栏：刚见过的条目不剪", async () => {
    const file = tmpFile()
    const led = makeLedger(file)
    const p = join("D:", "p", "a")
    const id = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)!
    led.prune(new Set())
    expect((await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)).toBe(id)
  })

  it("账本损坏 → 当空账本，按路径重新铸造（退化成改造前行为）", async () => {
    const file = tmpFile()
    const { writeFileSync } = await import("node:fs")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "{{{broken")
    const p = join("D:", "p", "a")
    expect((await makeLedger(file).resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)).toBe(repoId(p))
  })
})
