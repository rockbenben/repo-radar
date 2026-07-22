import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { CLONE_TMP_PREFIX, cloneRepo, createProject } from "../src/scaffold"
import { cleanupFixtures, makeRepo } from "./fixtures"

// 好几个测试要模拟"克隆的 rename（tmpDir -> finalDir）失败"——vi.spyOn 在 ESM 下挡在
// "Module namespace is not configurable" 报错上（node:fs 的具名导出不可重新定义），
// 只能整模块 mock 后自己接管 renameSync/rmSync：默认原样代理给真实实现，测试里用
// mockImplementationOnce 覆盖单次调用，用完自动回落到默认代理，不污染其它用例
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, rmSync: vi.fn(actual.rmSync), renameSync: vi.fn(actual.renameSync) }
})
// 同理 mock runGit：要模拟"进程被硬切、孙进程已经在临时目录里写了部分文件"这个真实场景
// （见 scaffold.ts safeCleanupTmp 的注释），真实触发这个时序在测试里不可靠，直接接管一次调用
vi.mock("../src/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git")>()
  return { ...actual, runGit: vi.fn(actual.runGit) }
})

const dirs: string[] = []
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-scaffold-"))
  dirs.push(d)
  return d
}

afterAll(() => {
  cleanupFixtures()
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("createProject", () => {
  it("creates a dir with git init and README under a configured root", async () => {
    const r = root()
    const res = await createProject(r, "028-new-thing", [r])
    expect(res.ok).toBe(true)
    const target = join(r, "028-new-thing")
    expect(existsSync(join(target, ".git"))).toBe(true)
    expect(existsSync(join(target, "README.md"))).toBe(true)
    // 真的是个 git 仓库
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: target, encoding: "utf8" }).trim()).toBe("true")
  })

  it("rejects unsafe names", async () => {
    const r = root()
    expect((await createProject(r, "../evil", [r])).ok).toBe(false)
    expect((await createProject(r, "a/b", [r])).ok).toBe(false)
    expect((await createProject(r, "", [r])).ok).toBe(false)
  })

  it("rejects a parent outside all roots", async () => {
    const r = root()
    const other = root()
    expect((await createProject(other, "x", [r])).ok).toBe(false)
  })

  it("rejects when the target already exists", async () => {
    const r = root()
    expect((await createProject(r, "dup", [r])).ok).toBe(true)
    const again = await createProject(r, "dup", [r])
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/已存在/)
  })
})

describe("cloneRepo", () => {
  it("clones a local source repo into a parent under root", async () => {
    const src = makeRepo() // 有一个提交的普通仓库，可按本地路径 clone
    const parent = root()
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(true)
    expect(existsSync(join(parent, basename(src), ".git"))).toBe(true)
  })
  it("rejects empty url, unsafe url, and parent outside roots", async () => {
    const parent = root()
    expect((await cloneRepo("", parent, [parent])).ok).toBe(false)
    expect((await cloneRepo("--upload-pack=evil", parent, [parent])).ok).toBe(false)
    expect((await cloneRepo(makeRepo(), root(), [parent])).ok).toBe(false) // parent 不在 root 内
  })

  // clone 先落到同级的隐藏临时目录，成功后再 rename 成最终名字——
  // 正常跑完之后，parent 下不该留下任何 CLONE_TMP_PREFIX 开头的目录，只有最终名字的仓库
  it("clones via a hidden tmp dir first, then renames to the final name with no leftover", async () => {
    const src = makeRepo()
    const parent = root()
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(true)
    expect(res.path).toBe(join(parent, basename(src)))
    const entries = readdirSync(parent)
    expect(entries).toEqual([basename(src)]) // 没有残留的临时目录
    expect(entries.some((e) => e.startsWith(CLONE_TMP_PREFIX))).toBe(false)
  })

  it("正常失败（比如目标已存在）不留下临时目录", async () => {
    const src = makeRepo()
    const parent = root()
    const first = await cloneRepo(src, parent, [parent])
    expect(first.ok).toBe(true)
    const again = await cloneRepo(src, parent, [parent]) // 目标已存在，提前拒绝，压根没开始 clone
    expect(again.ok).toBe(false)
    const leftovers = readdirSync(parent).filter((e) => e.startsWith(CLONE_TMP_PREFIX))
    expect(leftovers).toEqual([])
  })

  // 并发克隆到同一目标——两边都通过了克隆前的预检查（那一刻目标还不存在），下载完成后
  // 只有一个能 rename 成功；输的一方必须拿到与预检查相同的友好错误，而不是 rename 抛出的
  // 原始 "ENOTEMPTY: directory not empty, rename '...' -> '...'" fs 报文
  it("并发克隆到同一目标：输的一方拿到友好错误而不是原始 fs 报文", async () => {
    const src = makeRepo()
    const parent = root()
    const [a, b] = await Promise.all([cloneRepo(src, parent, [parent]), cloneRepo(src, parent, [parent])])
    const results = [a, b]
    expect(results.filter((r) => r.ok)).toHaveLength(1) // 恰好一个成功
    const fails = results.filter((r) => !r.ok)
    expect(fails).toHaveLength(1)
    expect(fails[0].error).toBe("目标目录已存在") // 与预检查同一句话
    expect(fails[0].error).not.toMatch(/ENOTEMPTY|EEXIST|EPERM|rename\b/i) // 不泄漏原始 fs 报文
    expect(readdirSync(parent).some((e) => e.startsWith(CLONE_TMP_PREFIX))).toBe(false) // 双方的临时目录都清干净了
  })

  // catch 里的清理（rmSync）本身也可能失败——真实场景是 Windows 上 runGit 超时后
  // child.kill() 只结束顶层 git，git-remote-https/index-pack 之类的孙进程仍占着临时目录里的
  // 文件句柄（force 只压 ENOENT，压不住 EBUSY/EPERM）。mock runGit 模拟"进程被硬切前已经在
  // 临时目录里写了部分文件"，再 mock rmSync 模拟清理失败——这个异常绝不能穿出 cloneRepo，
  // 把已经准备好的「克隆失败」错误变成带原始 fs 报文的 500
  it("清理临时目录失败时不抛出，仍优雅返回克隆本身的错误", async () => {
    const parent = root()
    const { runGit, GitError } = await import("../src/git")
    const { rmSync: mockedRmSync } = await import("node:fs")
    let leftover = ""
    vi.mocked(runGit).mockImplementationOnce(async (cwd: string, args: string[]) => {
      const tmpName = args[args.length - 1] // clone 的最后一个参数就是目标目录名
      leftover = join(cwd, tmpName)
      mkdirSync(leftover, { recursive: true })
      writeFileSync(join(leftover, "partial.pack"), "x") // 模拟被硬切前已经写下的半成品文件
      throw new GitError("git clone timed out after 300000ms", "")
    })
    vi.mocked(mockedRmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    })
    const res = await cloneRepo("https://example.invalid/wont-be-used.git", parent, [parent])
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(res.error).not.toMatch(/EBUSY/i) // 清理失败的报错不该混进克隆本身的错误文案里
    expect(existsSync(leftover)).toBe(true) // 清理确实失败了，目录还在（残留，不再自动清扫，见 scaffold.ts 顶部注释）
  })

  // 克隆后还有两条失败路径也会调用清理，第一条：rename 前重查发现 finalDir 已在克隆期间被并发建好
  it("路径A（rename 前的 finalDir 竞态检查）：清理临时目录失败也不影响返回结果", async () => {
    const src = makeRepo()
    const parent = root()
    const { runGit } = await import("../src/git")
    const { rmSync: mockedRmSync } = await import("node:fs")
    let tmpDir = ""
    vi.mocked(runGit).mockImplementationOnce(async (cwd: string, args: string[]) => {
      const tmpName = args[args.length - 1]
      tmpDir = join(cwd, tmpName)
      mkdirSync(tmpDir, { recursive: true }) // 模拟克隆本身顺利完成
      mkdirSync(join(parent, basename(src))) // 模拟另一个并发操作抢先建好了最终目录
      return { stdout: "", stderr: "" }
    })
    vi.mocked(mockedRmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    })
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(false)
    expect(res.error).toBe("目标目录已存在")
    expect(existsSync(tmpDir)).toBe(true) // 清理确实失败了，临时目录还在
  })

  // 第二条失败路径——renameSync 本身抛错。目标目录必须真的存在（mock 里显式建出来），
  // 这样才会走到"确实需要清理临时目录"这条分支
  it("路径B（renameSync 本身抛错，目标确实已存在）：清理临时目录失败也不影响返回结果", async () => {
    const src = makeRepo()
    const parent = root()
    let tmpDir = ""
    const { renameSync, rmSync: mockedRmSync } = await import("node:fs")
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      tmpDir = from as string
      mkdirSync(to as string) // 目标确实已经存在（比如并发操作抢先建好），才会触发清理
      throw Object.assign(new Error("some rename failure"), { code: "EPERM" })
    })
    vi.mocked(mockedRmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    })
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(false)
    expect(tmpDir).not.toBe("")
    expect(existsSync(tmpDir)).toBe(true) // 清理确实失败了，临时目录还在
  })

  // Windows 上 renameSync 抛 EPERM 更常见的原因是源临时目录被占用（git 子进程句柄/杀毒软件/
  // 资源管理器打开着），而不是目标存在。这种情况下临时目录里其实是个克隆完整的仓库，绝不能
  // 顺手删掉——用户会白白丢失一次已经成功的克隆。不能靠错误码猜，rename 失败后要显式检查
  // 目标是否存在再决定说哪句话、要不要清理
  it("rename 因源被占用而失败（目标其实不存在）——不误报'目标已存在'，也不清理临时目录", async () => {
    const src = makeRepo()
    const parent = root()
    let tmpDir = ""
    const { renameSync } = await import("node:fs")
    vi.mocked(renameSync).mockImplementationOnce((from) => {
      tmpDir = from as string
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }) // 目标始终没被创建
    })
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(false)
    expect(res.error).not.toBe("目标目录已存在") // 不能靠错误码瞎猜
    expect(res.error).toMatch(/EPERM/) // 给出可读的通用失败信息，带原始错误码
    expect(existsSync(tmpDir)).toBe(true) // 没有被清理——它其实是个克隆完整的仓库
  })

  it("rename 失败且目标确实已存在——按'目标已存在'处理，并清理临时目录", async () => {
    const src = makeRepo()
    const parent = root()
    let tmpDir = ""
    const { renameSync } = await import("node:fs")
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      tmpDir = from as string
      mkdirSync(to as string) // 模拟目标确实已经存在（比如并发操作抢先建好）
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
    })
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(false)
    expect(res.error).toBe("目标目录已存在")
    expect(existsSync(tmpDir)).toBe(false) // 目标确实存在，这份多余的临时目录该被清掉
  })
})
