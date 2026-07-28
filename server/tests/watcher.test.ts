import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { PerRepoStrategy, RecursiveRootStrategy, type StrategyHandlers, type WatchStrategy } from "../src/watch-strategy"
import { isStructuralPath, RepoWatcher, shouldIgnorePath, watcherErrorIsNoise } from "../src/watcher"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

// 扫描根必须是自己建的临时目录：拿 dirname(makeRepo()) 会得到 tmpdir() 本身，
// 那底下有别的用例正在跑的仓库，事件互相串台
const roots: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-e2e-"))
  roots.push(d)
  return d
}
afterAll(() => {
  // maxRetries：目录刚被监听过，Windows 上句柄释放晚于 close() 返回，头一次 rm 常撞 EBUSY
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")) }
    }, 100)
  })
}

describe("RepoWatcher", () => {
  it("fires once (debounced) for workdir changes and attributes the right repo", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 200, 2000, new PerRepoStrategy())
    await watcher.setRoots([], [
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    await new Promise((r) => setTimeout(r, 300)) // chokidar ready 缓冲
    writeFileSync(join(repoA, "watched.txt"), "1")
    writeFileSync(join(repoA, "watched2.txt"), "2") // 与上一条合并进同一次防抖
    await waitFor(() => fired.length > 0)
    expect(fired).toEqual(["A"])
    await watcher.close()
  })

  it("fires for git ref changes (commit)", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 200, 2000, new PerRepoStrategy())
    await watcher.setRoots([], [{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "c.txt"), "x")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "watched commit")
    await waitFor(() => fired.includes("R"))
    await watcher.close()
  })

  it("defers (not drops) changes arriving inside the cooldown window", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    // 防抖 100ms，冷却 1200ms —— 快速可测
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 1200, new PerRepoStrategy())
    await watcher.setRoots([], [{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1) // 第一次正常触发
    await new Promise((r) => setTimeout(r, 400)) // 仍在冷却期内
    writeFileSync(join(repo, "second.txt"), "2") // 冷却期内的真实变更
    await new Promise((r) => setTimeout(r, 300))
    expect(fired.length).toBe(1) // 尚未触发（被延迟，而非丢弃）
    await waitFor(() => fired.length === 2, 3000) // 冷却结束后补触发
    expect(fired).toEqual(["R", "R"])
    await watcher.close()
  })

  // setRoots 会先停掉旧监听再建新的。若它像以前那样连定时器一起整轮 close()，那些
  // 「已经收下、还没触发」的变更会连同定时器一起没掉——配置一改就吞一批事件，
  // 直接违背本类「任何真实变更都不会被丢弃」的承诺
  it("重建监听（同一批仓库）不丢弃已经收下、还没触发的变更", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 1500, new PerRepoStrategy())
    const list = [{ id: "R", path: repo }]
    await watcher.setRoots([], list)
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1) // 触发一次，进入冷却
    writeFileSync(join(repo, "second.txt"), "2") // 冷却期内的真实变更 → 挂上补票定时器
    await new Promise((r) => setTimeout(r, 200))
    expect(fired.length).toBe(1) // 还没补触发

    await watcher.setRoots([], list) // 兜底重扫在这一刻重建监听
    await waitFor(() => fired.length === 2, 4000) // 补票定时器活下来了，变更没丢
    await watcher.close()
  })

  it("重建监听时丢掉已经不在列表里的仓库的定时器", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 1500, new PerRepoStrategy())
    await watcher.setRoots([], [
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repoA, "first.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repoA, "second.txt"), "2") // A 挂上补票定时器
    await new Promise((r) => setTimeout(r, 200))

    await watcher.setRoots([], [{ id: "B", path: repoB }]) // A 被删除/排除，不再监听
    await new Promise((r) => setTimeout(r, 2200)) // 超过冷却窗口
    expect(fired).toEqual(["A"]) // A 的补票没有触发——它已经不在监听范围内了
    await watcher.close()
  })

  // setRoots()/close() 内部有 await 点：不串行化的话，两次重装交错时后者会把前者刚创建的
  // 监听实例引用置 null 而不关闭——孤儿实例永远在发事件（关了自动扫描看板还在刷新），
  // 句柄攒到 EMFILE
  it("并发的 setRoots() 与 close() 串行执行，不留下孤儿监听实例", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 2000, new PerRepoStrategy())
    // 同时发起两次 setRoots 和一个 close，全都不 await —— close 排在最后，赢家必须是它
    const p1 = watcher.setRoots([], [{ id: "R", path: repo }])
    const p2 = watcher.setRoots([], [{ id: "R", path: repo }])
    const p3 = watcher.close()
    await Promise.all([p1, p2, p3])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "after-close.txt"), "x")
    await new Promise((r) => setTimeout(r, 600))
    expect(fired).toEqual([]) // 关掉之后没有任何实例还在监听
  })

  it("close() 是彻底停止：待触发的变更一并丢弃（用户关掉自动扫描 / 进程退出）", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 1500, new PerRepoStrategy())
    await watcher.setRoots([], [{ id: "R", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "first.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repo, "second.txt"), "2")
    await new Promise((r) => setTimeout(r, 200))

    await watcher.close()
    await new Promise((r) => setTimeout(r, 2200)) // 超过冷却窗口
    expect(fired).toEqual(["R"]) // 关掉之后不该再有刷新
  })

  it("defers a change arriving immediately after a fire, never dropping it", async () => {
    const repo = makeRepo()
    const fired: string[] = []
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 100, 800, new PerRepoStrategy())
    await watcher.setRoots([], [{ id: "E", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "a.txt"), "1")
    await waitFor(() => fired.length === 1)
    writeFileSync(join(repo, "b.txt"), "2") // 紧跟在触发之后——旧的 echo 窗口会丢弃它
    await new Promise((r) => setTimeout(r, 200))
    expect(fired.length).toBe(1) // 仍在冷却期，尚未补触发
    await waitFor(() => fired.length === 2, 3000) // 冷却结束后补触发——没有被丢弃
    await watcher.close()
  })
})

// 构建产物目录的内容由构建工具高频重写，Windows 上这些临时文件还常带独占锁——chokidar 去
// watch 就是 EBUSY，日志被刷满跟仓库状态毫无关系的错误（实测：MSBuild 的
// app\obj\*_wpftmp.csproj.nuget.g.props）。这些目录基本都在 .gitignore 里，变化本来也不进 git status
describe("shouldIgnorePath — 监听时跳过的路径", () => {
  it("跳过 node_modules 与常见构建产物目录", () => {
    for (const seg of ["node_modules", "obj", "bin", "target", "dist", "build", ".next", "__pycache__", ".venv"]) {
      expect(shouldIgnorePath(join("D:", "repo", seg, "x.tmp"))).toBe(true)
    }
  })

  it("按路径段匹配，不做子串匹配", () => {
    // 仓库恰好放在名字含 node_modules 的目录下时，整个仓库都会被静默忽略
    expect(shouldIgnorePath(join("D:", "my node_modules stuff", "repo", "src", "a.ts"))).toBe(false)
    expect(shouldIgnorePath(join("D:", "repo", "obj-loader", "a.ts"))).toBe(false)
    expect(shouldIgnorePath(join("D:", "repo", "rebuild", "a.ts"))).toBe(false)
  })

  // 仓库自己或它的上级目录叫 build/vendor 完全合法，那不该让整个仓库停止刷新
  it("只看仓库根目录以下的段：根目录自身叫 build/vendor 也照常监听", () => {
    const roots = [join("D:", "projects", "build"), join("D:", "vendor", "myrepo")]
    expect(shouldIgnorePath(join("D:", "projects", "build"), roots)).toBe(false)
    expect(shouldIgnorePath(join("D:", "projects", "build", "src", "a.ts"), roots)).toBe(false)
    expect(shouldIgnorePath(join("D:", "vendor", "myrepo", "src", "a.ts"), roots)).toBe(false)
    // 但根目录**以下**的 build/ 依然跳过
    expect(shouldIgnorePath(join("D:", "projects", "build", "build", "out.js"), roots)).toBe(true)
    expect(shouldIgnorePath(join("D:", "vendor", "myrepo", "vendor", "x.go"), roots)).toBe(true)
  })

  // 卷根是受支持的扫描根（isUnderPath 为它特判过：「否则扫整个卷的用户一个仓库都匹配不上」）。
  // 手写的前缀比较要求 root 之后紧跟一个分隔符，卷根永远匹配不上——这里两种形态都钉住，
  // 免得以后有人把 root 归属判断改回裸 startsWith
  it("卷根 scan root（D:\\ 与 /）按 root 之下的段判断，不把整条绝对路径拿来匹配", () => {
    for (const volume of ["D:\\", "/"]) {
      expect(shouldIgnorePath(join(volume, "code", "repo", "src", "a.ts"), [volume])).toBe(false)
      expect(shouldIgnorePath(volume, [volume])).toBe(false) // root 自身
      expect(shouldIgnorePath(join(volume, "code", "repo", "dist", "b.js"), [volume])).toBe(true) // root 之下的构建产物照旧跳过
    }
  })

  // 这一条才是「退化成整条路径匹配」真正咬人的地方：配置里的扫描根带个尾分隔符、或写成正斜杠
  //（Windows 上两种都合法且常见），裸字符串比较就整条对不上，于是拿绝对路径去逐段匹配——
  // 那个 root 下的仓库只要路径里有一段叫 build/vendor/dist，事件就被全部丢弃，
  // 界面上它永远停在过期状态，没有任何报错
  it("root 的尾分隔符 / 分隔符风格不同也要认得出来（否则那个 root 下的仓库静默停止刷新）", () => {
    const p = join("D:", "build", "myrepo", "src", "a.ts")
    expect(shouldIgnorePath(p, [join("D:", "build", "myrepo")])).toBe(false) // 基准形式
    expect(shouldIgnorePath(p, [`${join("D:", "build", "myrepo")}${sep}`])).toBe(false) // 尾分隔符
    expect(shouldIgnorePath(p, ["D:/build/myrepo"])).toBe(false) // 正斜杠写法
  })

  it("嵌套仓库按最长匹配根归属（调用方按长度倒序传入）", () => {
    const roots = [join("D:", "repo", "dist", "inner"), join("D:", "repo")] // 长度倒序
    // inner 是一个独立仓库，虽然它位于外层仓库的 dist/ 下，它自己的文件不该被忽略
    expect(shouldIgnorePath(join("D:", "repo", "dist", "inner", "src", "a.ts"), roots)).toBe(false)
    // 外层仓库的 dist/ 里的其它文件照常忽略
    expect(shouldIgnorePath(join("D:", "repo", "dist", "bundle.js"), roots)).toBe(true)
  })

  it("不碰 .git 内部：HEAD/index/refs 正是我们要监听的东西", () => {
    expect(shouldIgnorePath(join("D:", "repo", ".git", "HEAD"))).toBe(false)
    expect(shouldIgnorePath(join("D:", "repo", ".git", "index"))).toBe(false)
    expect(shouldIgnorePath(join("D:", "repo", ".git", "refs", "heads", "main"))).toBe(false)
  })

  it("仓库根目录本身不被忽略", () => {
    expect(shouldIgnorePath(join("D:", "repo"))).toBe(false)
    expect(shouldIgnorePath(join("D:", "repo", "src", "index.ts"))).toBe(false)
  })
})

// C2 的另一半：结构变化信号的**收窄**。递归监听看得见 scan root 下的一切，而 root 下
// 并不只有仓库——草稿目录、非 git 项目、被 excludes 排除的仓库都在这条未归属分支上，
// 它们的深层写入不可能改变仓库集合，却会把「拆了重建全部监听句柄」的重扫变成持续水龙头
describe("isStructuralPath — 未归属事件值不值得当成目录结构变化", () => {
  const root = join("D:", "code")

  it("末段是 .git → 任何深度都报（新仓库出现的确定信号）", () => {
    // 仓库在第 6 层时它的 .git 在第 7 层，按深度算会被自己排除掉，必须由这条兜住
    expect(isStructuralPath(join(root, "a", "b", "c", "d", "e", "f", ".git"), [root])).toBe(true)
    expect(isStructuralPath(join(root, "newrepo", ".git"), [root])).toBe(true)
  })

  it("scanner 能走到的深度以内 → 报（仓库目录本身的创建/改名/删除都落在这里）", () => {
    expect(isStructuralPath(join(root, "newrepo"), [root])).toBe(true)
    expect(isStructuralPath(join(root, "a", "b", "c", "d", "e", "f"), [root])).toBe(true) // 恰好第 6 层
    expect(isStructuralPath(root, [root])).toBe(true)
  })

  it("超过扫描深度 → 不报（那只可能是某个目录内部的内容变化）", () => {
    // 草稿/笔记目录、非 git 项目、被 excludes 排除的仓库的深层写入
    expect(isStructuralPath(join(root, "a", "b", "c", "d", "e", "f", "g"), [root])).toBe(false)
    expect(isStructuralPath(join(root, "notes", "2026", "07", "28", "x", "y", "z.md"), [root])).toBe(false)
  })

  it("说不清在哪棵树下 → 报（少报的代价是新仓库要等 30 分钟兜底重扫，而那个开关可以关掉）", () => {
    expect(isStructuralPath(join("E:", "elsewhere", "a", "b", "c", "d", "e", "f", "g"), [root])).toBe(true)
    expect(isStructuralPath(join(root, "a", "b", "c", "d", "e", "f", "g"), [])).toBe(true)
  })
})

// 绑定成功后的监听期错误分两类：EBUSY/EPERM/ENOENT 是「文件正被别人锁着 / 刚被删掉」的
// 日常噪音，对仓库状态没有任何信息量；其余的（比如 EMFILE 句柄耗尽）是真问题，必须留在日志里
describe("watcherErrorIsNoise — 监听期错误分级", () => {
  const targets = [join("D:", "repo"), join("D:", "repo", ".git", "index")]
  const err = (code: string, path?: string) => ({ code, path }) as NodeJS.ErrnoException

  it("监听目标底下某个文件锁着/没了 → 噪音", () => {
    for (const code of ["EBUSY", "EPERM", "ENOENT"]) {
      expect(watcherErrorIsNoise(err(code, join("D:", "repo", "obj", "x.tmp")), targets)).toBe(true)
    }
  })

  // 同样的错误码打在监听目标本身上，后果是整个仓库从此不再刷新——界面永远停在过期状态，
  // 而打包后日志是唯一诊断面。这是这批修复里最要紧的一条分级
  it("监听目标本身出错 → 必须报出来（整个仓库失去监听）", () => {
    for (const code of ["EBUSY", "EPERM", "ENOENT"]) {
      expect(watcherErrorIsNoise(err(code, join("D:", "repo")), targets)).toBe(false)
      expect(watcherErrorIsNoise(err(code, join("D:", "repo", ".git", "index")), targets)).toBe(false)
    }
  })

  it("路径不明 → 报出来（影响面说不清，宁可多一条日志）", () => {
    expect(watcherErrorIsNoise(err("EBUSY"), targets)).toBe(false)
    expect(watcherErrorIsNoise(err("EPERM", undefined), targets)).toBe(false)
  })

  it("句柄耗尽等真问题永远报出来", () => {
    for (const code of ["EMFILE", "ENOSPC"]) {
      expect(watcherErrorIsNoise(err(code, join("D:", "repo", "obj", "x.tmp")), targets)).toBe(false)
    }
  })

  it.runIf(process.platform === "win32")("Windows 上按大小写不敏感比对监听目标", () => {
    expect(watcherErrorIsNoise(err("EPERM", join("d:", "REPO")), targets)).toBe(false)
  })
})

/** 临时改写 process.platform 探测平台分叉；finally 还原，不污染其它用例 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...desc, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, "platform", desc)
  }
}

/** 记下 RepoWatcher 交给策略的那组回调，用来直接投喂溢出/错误信号 */
function captureStrategy(): { strategy: WatchStrategy; handlers: () => StrategyHandlers } {
  let captured: StrategyHandlers | undefined
  return {
    strategy: {
      async start(_roots, _repos, h) {
        captured = h
        return []
      },
      async stop() {},
    },
    handlers: () => captured!,
  }
}

describe("RepoWatcher — 归属映射", () => {
  it("setRepos 不重建监听（零 syscall）", async () => {
    const repo = makeRepo()
    let starts = 0
    const fake = {
      async start() { starts++; return [] },
      async stop() {},
    }
    const w = new RepoWatcher(() => {}, () => {}, 50, 100, fake)
    await w.setRoots([], [{ id: "A", path: repo }])
    expect(starts).toBe(1)
    w.setRepos([{ id: "A", path: repo }, { id: "B", path: repo + "-x" }])
    w.setRepos([])
    expect(starts).toBe(1) // 仓库列表变了三次，监听一次都没重建
    await w.close()
  })

  // 退出后还能重新建句柄 = 一批没人认领的监听：Windows 上递归 fs.watch 一直握着 scan root 的
  // 目录句柄，那个目录在进程退出前谁也删不掉（EPERM）。退出流程已经会先排空重扫链再关监听，
  // 但还有两条不被任何人等待的路能在关闭之后再调一次 setRoots（见 dispose 的注释），
  // 这道门闩是最后一手。反过来 close() 绝不能有这个语义：关掉自动监听开关之后还要能再打开
  it("dispose 之后 setRoots 不再建句柄；普通 close 之后仍能重新建立", async () => {
    const repo = join("D:", "work", "repo")
    let starts = 0
    const fake = { async start() { starts++; return [] }, async stop() {} }

    const reopenable = new RepoWatcher(() => {}, () => {}, 10, 0, fake)
    await reopenable.setRoots([], [{ id: "R", path: repo }])
    await reopenable.close() // 用户关掉自动监听
    await reopenable.setRoots([], [{ id: "R", path: repo }]) // 又打开
    expect(starts).toBe(2)

    const w = new RepoWatcher(() => {}, () => {}, 10, 0, fake)
    await w.setRoots([], [{ id: "R", path: repo }])
    expect(starts).toBe(3)
    await w.dispose()
    await w.setRoots([], [{ id: "R", path: repo }]) // 退出后迟到的重建请求
    expect(starts).toBe(3) // 一个句柄都没再建
    expect(w.coveredRepoCount()).toBe(0)
  })

  it("嵌套仓库按最深路径归属", async () => {
    const outer = join("D:", "work", "outer")
    const inner = join(outer, "vendor", "inner")
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    await w.setRoots([], [{ id: "OUTER", path: outer }, { id: "INNER", path: inner }])
    w.handleEventForTest(join(inner, "src", "a.ts"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual(["INNER"])
    await w.close()
  })

  // 裸 startsWith 会让 D:\repo 认领 D:\repo-other 的事件，那个仓库的刷新会记到别人头上
  it("前缀必须停在分隔符上", async () => {
    const repo = join("D:", "work", "repo")
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    await w.setRoots([], [{ id: "R", path: repo }])
    w.handleEventForTest(join("D:", "work", "repo-other", "a.ts"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([])
    await w.close()
  })

  it("落在已知仓库之外的事件 → 报告结构变化", async () => {
    const repo = join("D:", "work", "repo")
    const structural: number[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher(() => {}, () => structural.push(1), 10, 0, fake)
    await w.setRoots([join("D:", "work")], [{ id: "R", path: repo }])
    w.handleEventForTest(join("D:", "work", "brand-new-project", ".git"))
    expect(structural.length).toBe(1)
    await w.close()
  })

  /**
   * G2：归档仓库既不能刷新，**也不能报结构变化**。
   *
   * 递归 root 句柄照样看得见归档仓库里的写入。把它从归属映射里删掉（改造后 applyWatch/
   * applyRepos 的 `filter(!archived)` 就是这么做的）的后果是：每一次保存都找不到 owner →
   * 落进未归属分支 → 末段在扫描深度内 → 报结构变化 → 一轮 force=true 的全量重扫
   *（store.refreshAll + 全部句柄拆建），按 60 秒冷却持续重复。净效果荒谬：归档一个你正在用的
   * 仓库，会让应用比不归档时做多得多的后台工作，而归档前它连一个事件都不产生
   */
  it("归档仓库里的写入既不刷新它，也不报结构变化", async () => {
    const root = join("D:", "work")
    const fired: string[] = []
    const structural: string[] = []
    const fake = { async start() { return [root] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), (r) => structural.push(r), 10, 0, fake)
    await w.setRoots([root], [
      { id: "LIVE", path: join(root, "live") },
      { id: "ARCH", path: join(root, "arch"), archived: true },
    ])
    w.handleEventForTest(join(root, "arch", "src", "a.ts")) // 归档仓库的工作区写入
    w.handleEventForTest(join(root, "arch", ".git", "index")) // 以及它的 .git 内部
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([]) // 不刷新：它不上看板
    expect(structural).toEqual([]) // 更不能报结构变化：仓库集合根本没变

    w.handleEventForTest(join(root, "live", "src", "a.ts")) // 同一批设置下正常仓库照常刷新
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual(["LIVE"])
    expect(w.coveredRepoCount()).toBe(1) // 归档的不计入覆盖数，否则 coverage 虚高
    await w.close()
  })

  it("被忽略目录里的事件既不刷新也不报结构变化", async () => {
    const repo = join("D:", "work", "repo")
    const fired: string[] = []
    const structural: number[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => structural.push(1), 10, 0, fake)
    await w.setRoots([join("D:", "work")], [{ id: "R", path: repo }])
    w.handleEventForTest(join(repo, "node_modules", "x", "index.js"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([])
    expect(structural).toEqual([])
    await w.close()
  })

  // 递归监听下同一目录以不同大小写回报是常态（事件名来自内核，仓库路径来自 readdir）。
  // 两个平台上都真跑：改写 process.platform 后 setRepos + handleEventForTest 全是同步的，
  // 探针不会在 await 点之后才失效
  it("Windows 上大小写不同的事件路径仍归属到同一仓库", async () => {
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    withPlatform("win32", () => {
      w.setRepos([{ id: "R", path: join("D:", "Work", "Repo") }])
      w.handleEventForTest(join("d:", "work", "repo", "a.ts"))
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual(["R"])
    await w.close()
  })

  // 非 Windows 上大小写有意义：/home/Repo 与 /home/repo 是两个真实目录，
  // 归一化到一起会把一个仓库的刷新记到另一个头上
  it("非 Windows 上保留大小写", async () => {
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    withPlatform("linux", () => {
      w.setRepos([{ id: "R", path: join("/home", "Repo") }])
      w.handleEventForTest(join("/home", "repo", "a.ts"))
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([])
    await w.close()
  })

  // 钉的是「拿查表匹配上的那段祖先路径当仓库根」，而不是仓库表里的原始字符串：后者只要
  // 大小写差一点，shouldIgnorePath 就找不到根、退化成拿整条绝对路径匹配，于是放在
  // D:\Vendor\ 下的仓库因为路径里有 vendor 段被整个静默忽略——界面上它永远停在过期状态
  it("仓库位于 vendor/ 下且大小写与事件路径不一致时仍然刷新", async () => {
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    withPlatform("win32", () => {
      w.setRepos([{ id: "V", path: join("D:", "Vendor", "MyRepo") }])
      w.handleEventForTest(join("d:", "vendor", "myrepo", "src", "a.ts"))
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual(["V"])
    await w.close()
  })

  // coverage 虚高 = 界面在说「这个仓库有人看着」而其实没有，用户无从判断为什么它不刷新
  it("coverage 只数真正落在成功 root 之下的仓库", async () => {
    const root = join("D:", "work")
    const fake = { async start() { return [root] }, async stop() {} }
    const w = new RepoWatcher(() => {}, () => {}, 10, 0, fake)
    await w.setRoots([root], [
      { id: "IN", path: join(root, "repo") },
      { id: "OUT", path: join("D:", "work-other", "repo") }, // 裸 startsWith 会把它算进来
    ])
    expect(w.watchedRoots()).toEqual([root])
    expect(w.coveredRepoCount()).toBe(1)
    await w.close()
    expect(w.coveredRepoCount()).toBe(0) // 关掉之后没有任何仓库被监听
  })

  // 缓冲区溢出意味着这一批事件已经永久丢了。不接到重扫上的话，那些仓库会静默停在过期状态
  it("监听溢出 → 报告结构变化（丢掉的事件只能靠重扫补票）", async () => {
    const reasons: string[] = []
    const cap = captureStrategy()
    const w = new RepoWatcher(() => {}, (reason) => reasons.push(reason), 10, 0, cap.strategy)
    await w.setRoots([join("D:", "work")], [])
    cap.handlers().onOverflow("recursive watch overflow at D:\work")
    expect(reasons).toEqual(["recursive watch overflow at D:\work"])
    await w.close()
  })

  // 打包后日志是唯一诊断面：监听目标本身出错 = 那棵树从此不再有事件
  it("监听目标本身的错误必须进日志，目标底下的单文件噪音不进", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const cap = captureStrategy()
      const w = new RepoWatcher(() => {}, () => {}, 10, 0, cap.strategy)
      const root = join("D:", "work")
      await w.setRoots([root], [])
      const err = (code: string, path: string) => Object.assign(new Error(code), { code, path })
      cap.handlers().onError(err("EPERM", join(root, "obj", "x.tmp")), [root])
      expect(spy).not.toHaveBeenCalled()
      cap.handlers().onError(err("EPERM", root), [root])
      expect(spy).toHaveBeenCalledTimes(1)
      await w.close()
    } finally {
      spy.mockRestore()
    }
  })
})

// win/mac 的生产路径：内核事件 → reportedPath → resolve → findOwner → 防抖 → 触发。
// 上面那批归属用例走的是假策略，策略用例又不带 RepoWatcher，中间这条缝一直没人跑过——
// 而事件路径的坐标系（tmpdir 在本机与 CI 上都是 8.3 短名 C:\Users\ADMINI~1\...，
// 监听却必须挂在 realpath 上）正是在这条缝里咬人的：一旦两边形式不一致，
// 所有仓库都静默停止刷新，且每条事件都会被当成目录结构变化去触发重扫
describe("RepoWatcher + RecursiveRootStrategy — 真实文件系统端到端", () => {
  it("递归 root 下写文件 → 归属到正确的仓库，各刷新一次，不误报结构变化", async () => {
    const root = tmpRoot()
    const repoA = join(root, "alpha")
    const repoB = join(root, "beta")
    mkdirSync(join(repoA, "src"), { recursive: true })
    mkdirSync(join(repoB, ".git"), { recursive: true })
    const fired: string[] = []
    const structural: string[] = []
    const w = new RepoWatcher(
      (id) => fired.push(id),
      (reason) => structural.push(reason),
      100,
      2000,
      new RecursiveRootStrategy(),
    )
    await w.setRoots([root], [
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    expect(w.watchedRoots()).toEqual([root]) // 两个仓库一个句柄
    expect(w.coveredRepoCount()).toBe(2)
    await new Promise((r) => setTimeout(r, 300)) // 递归监听建立缓冲

    writeFileSync(join(repoA, "src", "deep.txt"), "x") // 深层工作区文件
    await waitFor(() => fired.length > 0)
    expect(fired).toEqual(["A"])

    writeFileSync(join(repoB, ".git", "index"), "x") // 另一个仓库的 .git 内部
    await waitFor(() => fired.length > 1)
    expect(fired).toEqual(["A", "B"])
    expect(structural).toEqual([]) // 落在已知仓库里的事件不该被当成结构变化
    await w.close()
  })

  it("递归 root 下新出现的目录 → 报结构变化（改造前要等最长 30 分钟的兜底重扫）", async () => {
    const root = tmpRoot()
    const repo = join(root, "known")
    mkdirSync(repo, { recursive: true })
    const structural: string[] = []
    const w = new RepoWatcher(() => {}, (reason) => structural.push(reason), 100, 2000, new RecursiveRootStrategy())
    await w.setRoots([root], [{ id: "K", path: repo }])
    await new Promise((r) => setTimeout(r, 300))
    mkdirSync(join(root, "brand-new-project", ".git"), { recursive: true })
    await waitFor(() => structural.length > 0)
    expect(structural.some((s) => s.includes("brand-new-project"))).toBe(true)
    await w.close()
  })

  // 多 scan root 是 RecursiveRootStrategy 的核心场景（每个 root 一个句柄），但全套测试里
  // 唯一用过两个 root 的地方（automation.test.ts）走的是假 watcher。这里补的四条钉住
  // start() 返回值、coverage、以及「单个 root 挂不上不拖垮其它 root」这条只在注释里
  // 承诺过、从没被验证过的性质
  it("两个真实 root 各自工作：分别写入触发各自的仓库，互不串台", async () => {
    const rootA = tmpRoot()
    const rootB = tmpRoot()
    const repoA = join(rootA, "alpha")
    const repoB = join(rootB, "beta")
    mkdirSync(join(repoA, ".git"), { recursive: true })
    mkdirSync(join(repoB, ".git"), { recursive: true })
    const fired: string[] = []
    const structural: string[] = []
    const w = new RepoWatcher(
      (id) => fired.push(id),
      (reason) => structural.push(reason),
      100,
      2000,
      new RecursiveRootStrategy(),
    )
    await w.setRoots([rootA, rootB], [
      { id: "A", path: repoA },
      { id: "B", path: repoB },
    ])
    expect(w.watchedRoots().slice().sort()).toEqual([rootA, rootB].slice().sort()) // 各自一个句柄，都挂上了
    expect(w.coveredRepoCount()).toBe(2)
    await new Promise((r) => setTimeout(r, 300)) // Windows 上递归监听建立后需要一点缓冲

    writeFileSync(join(repoA, ".git", "index"), "x")
    await waitFor(() => fired.length > 0)
    expect(fired).toEqual(["A"]) // 只有 A 触发，没有串到 B

    writeFileSync(join(repoB, ".git", "index"), "x")
    await waitFor(() => fired.length > 1)
    expect(fired).toEqual(["A", "B"])
    expect(structural).toEqual([]) // 两次写入都落在已知仓库里，不该被当成结构变化
    await w.close()
  })

  it("一个 root 挂不上（路径不存在），另一个仍然工作，且失守留下痕迹", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const rootGood = tmpRoot()
      const rootBad = join(tmpRoot(), "does-not-exist") // realpathSync.native 对它必抛 ENOENT → catch → 不进 ok
      const repoGood = join(rootGood, "good")
      const repoBad = join(rootBad, "bad") // 从未创建，只用来验证 coveredRepoCount 会把它排除
      mkdirSync(join(repoGood, ".git"), { recursive: true })
      const fired: string[] = []
      const w = new RepoWatcher((id) => fired.push(id), () => {}, 100, 2000, new RecursiveRootStrategy())
      await w.setRoots([rootGood, rootBad], [
        { id: "GOOD", path: repoGood },
        { id: "BAD", path: repoBad },
      ])

      expect(w.watchedRoots()).toEqual([rootGood]) // 坏的那个没能挂上，不进成功列表
      expect(w.coveredRepoCount()).toBe(1) // 只数好 root 下的仓库，BAD 不计入
      expect(spy).toHaveBeenCalled() // 失守必须留痕迹：onError 被调用了，不是被当噪音悄悄吞掉

      await new Promise((r) => setTimeout(r, 300))
      writeFileSync(join(repoGood, ".git", "index"), "x")
      await waitFor(() => fired.length > 0)
      expect(fired).toEqual(["GOOD"]) // 好的 root 完全不受坏 root 拖累
      await w.close()
    } finally {
      spy.mockRestore()
    }
  })

  it("coveredRepoCount() 跨 root 数得对，其中一个失守后如实下降", async () => {
    const rootA = tmpRoot()
    const rootB = tmpRoot()
    // repos 不需要真实存在：coveredRepoCount 只按路径字符串前缀判断，不碰文件系统
    const reposA = ["a1", "a2"].map((n) => join(rootA, n))
    const reposB = ["b1", "b2"].map((n) => join(rootB, n))
    const watched = [
      ...reposA.map((path, i) => ({ id: `A${i}`, path })),
      ...reposB.map((path, i) => ({ id: `B${i}`, path })),
    ]
    const w = new RepoWatcher(() => {}, () => {}, 100, 2000, new RecursiveRootStrategy())
    await w.setRoots([rootA, rootB], watched)
    expect(w.coveredRepoCount()).toBe(4) // 两个 root 各 2 个仓库，加起来 4

    // 模拟 rootB 失守之后的重扫重建：仓库列表不变，rootB 换成一个已经不存在的路径
    const rootBGone = join(tmpRoot(), "does-not-exist")
    await w.setRoots([rootA, rootBGone], watched)
    expect(w.coveredRepoCount()).toBe(2) // reposB 仍在列表里，但不再落在任何成功 root 之下
    await w.close()
  })

  // 已知粗糙面：targets 按裸字符串去重，root 与它的子目录会各挂一个句柄，同一棵树被监听
  // 两次——这里钉住的是「只是多花一份 syscall 成本，不是正确性问题」，不是要求改实现
  it("嵌套 root 各挂一个句柄，但一次写入只触发一次刷新，仓库不被重复计数", async () => {
    const rootA = tmpRoot()
    const rootB = join(rootA, "sub")
    mkdirSync(rootB, { recursive: true })
    const repo = join(rootB, "repo")
    mkdirSync(join(repo, ".git"), { recursive: true })
    const fired: string[] = []
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 100, 2000, new RecursiveRootStrategy())
    await w.setRoots([rootA, rootB], [{ id: "NESTED", path: repo }])
    expect(w.watchedRoots().slice().sort()).toEqual([rootA, rootB].slice().sort()) // 两个 target 都真的各自挂上
    expect(w.coveredRepoCount()).toBe(1) // 按仓库过滤，不是按 root 累加求和
    await new Promise((r) => setTimeout(r, 300))

    writeFileSync(join(repo, ".git", "index"), "x") // 同一次写入会被两个句柄各报一次
    await waitFor(() => fired.length > 0)
    await new Promise((r) => setTimeout(r, 400)) // 给可能的第二次触发留出时间：真出现的话会在这里现形
    expect(fired).toEqual(["NESTED"]) // 防抖把两个句柄各自报的重复事件合并成一次
    await w.close()
  })
})
