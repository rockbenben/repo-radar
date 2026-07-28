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

// dev/ino 在落盘 schema 里是字符串（Windows 文件 ID 超 2^53，转 double 会串号）。
// 这两个构造器让用例照旧写数字，读起来仍是「ino 100」而不是一片引号噪音
const cand = (dev: number | string, ino: number | string, rootCommit: string | null = null): ClaimCandidate =>
  ({ dev: String(dev), ino: String(ino), rootCommit })
const st = (dev: number | string, ino: number | string) => ({ dev: String(dev), ino: String(ino) })
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

  // 上面那条其实是被「判据值重复」守卫顺带挡住的（四个候选全 key 成 "1:0"，两侧都被污染），
  // 删掉 ino 守卫它照样绿。这条是唯一能真正打到 ino 守卫的形状：两边各一条，不触发重复守卫
  it("ino 为 0 且两侧各只有一条 → 仍不得认领（打的是 ino 守卫本身）", () => {
    const lost = new Map([["a", cand(1, 0)]])
    const found = new Map([["D:/x", cand(1, 0)]])
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
    // ino 故意取两个不相等的真值，好让这条只打根提交守卫，不蹭 ino 守卫的覆盖
    const lost = new Map([["a", cand(1, 100, "")]])
    const found = new Map([["D:/x", cand(2, 300, "")]])
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

  // Windows 文件 ID 常常超过 2^53：这两个值 Number() 之后是同一个 double。
  // 判据键一旦退回数字，两个无关仓库就会凑出一个「干净的一一对应」错误认领
  it("ino 相差 1 但超出 double 精度 → 仍是两个仓库，不得认领", () => {
    expect(Number("50946970787919009")).toBe(Number("50946970787919010")) // 前提：转 double 后确实撞了
    const lost = new Map([["a", cand(1, "50946970787919009")]])
    const found = new Map([["D:/x", cand(1, "50946970787919010")]])
    expect(matchClaims(lost, found)).toEqual(new Map())
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

  // 上面那条同样是被「判据值重复」守卫挡住的（"shared" 在 lost 侧出现两次），删掉轮间扣除照样绿。
  // 换成两个不同的根提交，扣除逻辑就成了唯一防线：没有它，判据②会拿 b 覆盖掉①认定的 a——
  // 那是一个错误认领，也正是本模块最高危的失败模式
  it("ino 已配对的不再参与根提交匹配（根提交各不相同，打的是轮间扣除本身）", () => {
    const lost = new Map([["a", cand(1, 100, "rootA")], ["b", cand(1, 999, "rootB")]])
    const found = new Map([["D:/x", cand(1, 100, "rootB")]])
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

// normalizePath 是本模块唯一按 process.platform 分叉的地方，而 CI 跑 ubuntu + windows 两条腿
// （.github/workflows/ci.yml）。把平台钉死在断言里会让另一条腿必然红，所以这里在**调用现场**
// 临时改写 process.platform，两个分支在两个平台上都被完整验证。
// 只包住一次纯函数调用（无 I/O、无 import），finally 里按原描述符还原——不会污染其它用例
function withPlatform<T>(platform: string, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...desc, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, "platform", desc)
  }
}

describe("normalizePath", () => {
  // 分隔符折叠是无条件的，两个平台上都成立
  it("统一分隔符", () => {
    expect(normalizePath("D:\\Repo\\A")).toBe(normalizePath("D:/Repo/A"))
  })

  it("Windows 上大小写也归一化（同一目录换个壳不该变成两个仓库）", () => {
    withPlatform("win32", () => {
      expect(normalizePath("D:\\Repo\\A")).toBe(normalizePath("d:/repo/a"))
    })
  })

  // 非 Windows 上大小写有意义：/home/Repo 与 /home/repo 是两个真实目录，
  // 归一化到一起会让它们在账本里互相顶替
  it("非 Windows 上保留大小写", () => {
    withPlatform("linux", () => {
      expect(normalizePath("/home/Repo")).not.toBe(normalizePath("/home/repo"))
      expect(normalizePath("/home/a\\b")).toBe("/home/a/b") // 分隔符仍然折
    })
  })

  it("改写后如实还原（探针不会污染其它用例）", () => {
    const real = process.platform
    withPlatform("linux", () => undefined)
    expect(process.platform).toBe(real)
  })
})

describe("IdentityLedger", () => {
  it("首次见到的路径按 repoId(path) 铸造 —— 与现有 config.json 里的 id 完全一致", async () => {
    const led = makeLedger(tmpFile())
    const p = join("D:", "projects", "demo")
    const ids = await led.resolve([p], noRootCommit, () => st(1, 10))
    expect(ids.get(p)).toBe(repoId(p))
  })

  it("已知路径复用账本里的 id", async () => {
    const file = tmpFile()
    const p = join("D:", "projects", "demo")
    const led = makeLedger(file)
    const first = await led.resolve([p], noRootCommit, () => st(1, 10))
    led.flush() // 防抖 1s：不 flush 的话第二个实例读到的是空文件
    const second = await makeLedger(file).resolve([p], noRootCommit, () => st(1, 10))
    expect(second.get(p)).toBe(first.get(p))
  })

  it("改名后沿用老 id（这是整个杠杆 4 的目的）", async () => {
    const file = tmpFile()
    const oldP = join("D:", "projects", "demo")
    const newP = join("D:", "projects", "demo-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], noRootCommit, () => st(1, 42))).get(oldP)
    const after = (await led.resolve([newP], noRootCommit, () => st(1, 42))).get(newP)
    expect(after).toBe(before)
  })

  // 真实场景里改名多半发生在两次运行之间（关掉应用改名再打开），认领必须跨实例走落盘的账本
  it("改名发生在两次运行之间（另起实例读盘）→ 仍沿用老 id", async () => {
    const file = tmpFile()
    const oldP = join("D:", "projects", "restart")
    const newP = join("D:", "projects", "restart-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], noRootCommit, () => st(1, 42))).get(oldP)
    led.flush()
    const after = (await makeLedger(file).resolve([newP], noRootCommit, () => st(1, 42))).get(newP)
    expect(after).toBe(before)
    expect(after).toBe(repoId(oldP))
  })

  it("复制出一份副本（原仓库还在）→ 副本铸造新 id", async () => {
    const led = makeLedger(tmpFile())
    const a = join("D:", "p", "a")
    const b = join("D:", "p", "b")
    await led.resolve([a], noRootCommit, () => st(1, 1))
    const ids = await led.resolve([a, b], noRootCommit, (p) => st(1, p === a ? 1 : 2))
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
    const before = (await led.resolve([p], noRootCommit, () => st(1, 1))).get(p)
    // 路径没变但 ino 变了：这条路径在账本里已知，直接命中——根本不进认领流程
    const after = (await led.resolve([p], noRootCommit, () => st(1, 2))).get(p)
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
    await led.resolve([oldP], noRootCommit, () => st(1, 7))
    const renamed = (await led.resolve([newP], noRootCommit, () => st(1, 7))).get(newP)
    expect(renamed).toBe(repoId(oldP))
    const ids = await led.resolve([newP, oldP], noRootCommit, (p) => st(1, p === newP ? 7 : 8))
    expect(ids.get(newP)).toBe(renamed)
    expect(ids.get(oldP)).not.toBe(renamed)
  })

  // 同一个洞的「屏幕外」版本：改名后的 newP 这一轮压根没被扫到（删了 / 移动硬盘拔了 /
  // 没扫到），于是「本轮已分配的 id」是空集，只有账本知道 repoId(oldP) 名花有主。
  // 认错的后果是新仓库继承老仓库的标签，而老仓库回来时什么都不剩
  it("改名后 newP 本轮不在扫描范围内，原路径又新建仓库 → 仍不得铸造成老 id", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "off-screen")
    const newP = join("D:", "p", "off-screen-renamed")
    const led = makeLedger(file)
    await led.resolve([oldP], noRootCommit, () => st(1, 7))
    const renamed = (await led.resolve([newP], noRootCommit, () => st(1, 7))).get(newP)
    expect(renamed).toBe(repoId(oldP))
    // 本轮只扫到 oldP，且它是个全新的无关仓库（ino 变了，认领必然失败）
    const ids = await led.resolve([oldP], noRootCommit, () => st(1, 9))
    expect(ids.get(oldP)).not.toBe(renamed)
  })

  // 去重前置：同一仓库以两种拼写出现在同一轮时，两条会算出同一个 repoId，
  // 后一条被撞车守卫改成合成 id 又赢下归一化键，真 id 就成了孤儿——标签全丢
  it("同一路径以两种拼写出现在同一轮 → 去重，真 id 不被合成 id 顶掉", async () => {
    const file = tmpFile()
    const led = makeLedger(file)
    const p = join("D:", "p", "dup")
    const ids = await led.resolve([p, p.replace(/\\/g, "/")], noRootCommit, () => st(1, 5))
    expect([...new Set(ids.values())]).toEqual([repoId(p)])
    // 下一轮必须还认得它：合成 id 一旦赢下 byPath，这里返回的就是那个孤儿
    expect((await led.resolve([p], noRootCommit, () => st(1, 5))).get(p)).toBe(repoId(p))
  })

  it("stat 失败（仓库不可读）不影响其它仓库的解析", async () => {
    const led = makeLedger(tmpFile())
    const a = join("D:", "p", "a")
    const ids = await led.resolve([a], noRootCommit, () => null)
    expect(ids.get(a)).toBe(repoId(a))
  })

  // 杀软锁住 .git、硬盘刚休眠都会让 stat 瞬时失败。把好记录清成 "0" 会废掉判据①，
  // 而它是目前唯一真正在工作的判据——下一轮这个仓库改名就再也认不回来了
  it("stat 瞬时失败不清掉已记录的 dev/ino，改名仍能认领", async () => {
    const file = tmpFile()
    const p = join("D:", "p", "flaky")
    const renamed = join("D:", "p", "flaky-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([p], noRootCommit, () => st(1, 77))).get(p)
    await led.resolve([p], noRootCommit, () => null) // 这一轮 stat 挂了
    expect((await led.resolve([renamed], noRootCommit, () => st(1, 77))).get(renamed)).toBe(before)
  })

  // 根提交在一轮里只该算一次：判据②先为「认不上的新路径」算一次，铸造时必须复用那一次，
  // 不能再 spawn 一遍。（原先这条断言的是 0——那时铸造还不播种，判据②因 lost 侧恒为 null
  // 而整轮跳过；播种之后每个新路径本来就要付一个 git 进程，能防的回归变成了「付两次」）
  it("认不上的新路径本轮只算一次根提交（判据②与铸造共用同一次计算）", async () => {
    const file = tmpFile()
    const led = makeLedger(file)
    const oldP = join("D:", "p", "gone")
    const newP = join("D:", "p", "fresh")
    await led.resolve([oldP], async () => "rootOLD", () => st(1, 3)) // lost 侧带着根提交，判据②那道闸是开的
    let calls = 0
    const counting = async () => {
      calls++
      return "rootNEW" // 与 lost 侧不同 → 判据②认不上，落到铸造
    }
    await led.resolve([newP], counting, () => st(2, 4)) // ino 也认不上，会走到判据②的入口
    expect(calls).toBe(1)
  })

  it("prune 带年龄护栏：刚见过的条目不剪", async () => {
    const file = tmpFile()
    const led = makeLedger(file)
    const p = join("D:", "p", "a")
    const id = (await led.resolve([p], noRootCommit, () => st(1, 1))).get(p)!
    led.prune(new Set())
    expect((await led.resolve([p], noRootCommit, () => st(1, 1))).get(p)).toBe(id)
  })

  it("账本损坏 → 当空账本，按路径重新铸造（退化成改造前行为）", async () => {
    const file = tmpFile()
    const { writeFileSync } = await import("node:fs")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "{{{broken")
    const p = join("D:", "p", "a")
    expect((await makeLedger(file).resolve([p], noRootCommit, () => st(1, 1))).get(p)).toBe(repoId(p))
  })
})

describe("判据②的播种与同轮次约束", () => {
  // 约束 A：不在铸造时算根提交，判据②就是一段永远跑不到的死代码
  it("铸造新 id 时把根提交写进账本", async () => {
    const led = makeLedger(tmpFile())
    const p = join("D:", "p", "fresh")
    await led.resolve([p], async () => "rootXYZ", () => st(1, 10))
    expect(led.get((await led.resolve([p], async () => null, () => st(1, 10))).get(p)!)?.rootCommit).toBe("rootXYZ")
  })

  // 约束 A 的收益：播种之后，跨卷移动（dev 变了、ino 也变了）才认得出来
  it("播种过根提交后，跨卷移动仍能认领", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "movable")
    const newP = join("E:", "elsewhere", "movable")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], async () => "rootMOVE", () => st(1, 10))).get(oldP)
    const after = (await led.resolve([newP], async () => "rootMOVE", () => st(2, 99))).get(newP)
    expect(after).toBe(before)
  })

  // 每个新仓库一生只算一次根提交：已知路径零 git 进程，认领路径也不额外付钱
  it("已知路径不再重算根提交", async () => {
    const led = makeLedger(tmpFile())
    const p = join("D:", "p", "once")
    let calls = 0
    const counting = async () => {
      calls++
      return "rootONCE"
    }
    await led.resolve([p], counting, () => st(1, 11))
    expect(calls).toBe(1) // 铸造时播种
    await led.resolve([p], counting, () => st(1, 11))
    expect(calls).toBe(1) // 已知路径直接命中，不再 spawn
  })

  // 约束 B：上一轮还活着、这一轮没了的才可认领
  it("上一轮消失的可以认领（关掉应用改名再打开）", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "a")
    const newP = join("D:", "p", "a-renamed")
    const led = makeLedger(file)
    const before = (await led.resolve([oldP], async () => null, () => st(1, 42))).get(oldP)
    led.flush() // 防抖 1s：不 flush 的话下面这个实例读到的是空文件
    // 新实例 = 重启；代必须是持久化的，否则这条会挂
    const after = (await makeLedger(file).resolve([newP], async () => null, () => st(1, 42))).get(newP)
    expect(after).toBe(before)
  })

  it("连续两轮没扫到的仓库不再可认领（硬盘拔了很久）", async () => {
    const file = tmpFile()
    const gone = join("D:", "p", "on-usb")
    const other = join("D:", "p", "other")
    const led = makeLedger(file)
    const goneId = (await led.resolve([gone, other], async () => null, (p) => st(1, p === gone ? 42 : 7))).get(gone)
    await led.resolve([other], async () => null, () => st(1, 7)) // 第 1 轮不见
    await led.resolve([other], async () => null, () => st(1, 7)) // 第 2 轮仍不见 → 过期
    const back = join("D:", "p", "came-back")
    const newId = (await led.resolve([other, back], async () => null, (p) => st(1, p === back ? 42 : 7))).get(back)
    expect(newId).not.toBe(goneId) // 隔了太久，不认
  })

  // 约束 C：返回的 Map 对每个输入路径都要有条目
  it("重复拼写的路径都能取到同一个 id", async () => {
    const led = makeLedger(tmpFile())
    // 写死反斜杠而不是 join()：CI 跑 ubuntu + windows 两条腿，join 在 Linux 上给出的是
    // 正斜杠，a 与 b 会是同一个字符串，这条用例就退化成「同一个键取两次」什么也没测到。
    // 反斜杠在 Linux 上是合法文件名字符，normalizePath 照样把两种拼写折成同一个键
    const a = "D:\\p\\dup"
    const b = a.replace(/\\/g, "/")
    const ids = await led.resolve([a, b], async () => null, () => st(1, 5))
    expect(ids.get(a)).toBeDefined()
    expect(ids.get(b)).toBe(ids.get(a)) // 而不是 undefined
  })
})
