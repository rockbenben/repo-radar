import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { GitError, runGit } from "./git"
import { isUnderPath } from "./watch-filter"

export interface ScaffoldResult {
  ok: boolean
  path?: string
  error?: string
}

const NAME_RE = /^[\w.-]+$/

/**
 * clone 先落到的临时目录前缀。带点号开头——scanner.ts 本就跳过所有点号开头的目录（无需额外改动），
 * 即使进程在克隆中途被硬切、留下这个目录，也绝不会被扫描器当成仓库显示在看板上。
 *
 * 为什么这里不做「残骸自动清理」（没有账本、没有启动时扫描）：
 *
 * 早前版本确实做过一整套——克隆前把临时目录路径记进一份 pending-clones.json 账本，启动时
 * 读账本、按记录逐个清扫。后来把那套整个删掉了，原因是重新权衡下来代价远大于收益：
 *   1. 残骸出现的条件很苛刻——必须恰好在克隆进行中被硬退出（比如托盘强杀），日常使用
 *      基本碰不到；
 *   2. 残骸是点号开头的目录（CLONE_TMP_PREFIX 本身就带点号），scanner.ts 本来就忽略它，
 *      界面上根本看不见，不会被当成坏仓库、也不会误导用户；
 *   3. 就算真的攒下了一个，用户手动删掉它只需一秒；
 *   而为了自动清理它，需要一整套跨进程共享状态的账本（账本写失败怎么办、删除失败要不要
 *   销账、清扫会不会误删别的实例正在进行中的克隆、同步删除会不会卡住启动……）——连续两轮
 *   代码审查报出的缺陷几乎全出在这套机制自身，维护它比它省下来的"用户手动删一个目录"的
 *   一秒钟贵得多。
 *
 * 真正有价值、值得保留的只有「先克隆到临时目录、成功后再 rename」这十几行本身：它是原子
 * 操作，保证磁盘上要么出现一个完整的仓库目录，要么什么都没有——不会出现一个顶着最终名字、
 * 有 .git 但没有 HEAD/refs 的半成品仓库。
 *
 * 如果将来又想把自动清理加回来，先重新确认上面三条是否还成立，而不是直接抄旧实现——
 * 旧实现在 git 历史里能找到（pending-clones.json / sweepCloneTmpDirs / json-store.ts）。
 */
export const CLONE_TMP_PREFIX = ".repo-radar-clone-"

// 「在某个扫描根之内」只有一份实现，见 watch-filter.ts 的 isUnderPath。这里曾经手写过
// 第二份（`p === root || p.startsWith(root + sep)`），恰好踩中 isUnderPath 注释里点名的
// 两个坑：盘符根 `D:\` 被 resolve 之后仍带尾分隔符，`root + sep` 成了 `D:\\`，谁都匹配
// 不上——把整个盘配成扫描根的用户，看板和分组都正常，唯独新建/克隆永远报「父目录必须在
// 已配置的扫描根目录之内」；另一个坑是无条件 toLowerCase，POSIX 上会把 /home/me/Code
// 判进 /home/me/code，项目建到扫描根之外还回 ok，卡片永远不出现。
const underRoot = (parent: string, roots: string[]): boolean => roots.some((r) => isUnderPath(parent, r))

/**
 * 新建一个空项目：mkdir + git init + 一个 README。父目录必须在已配置的扫描根之内。
 *
 * 不在这里处理排空/临时目录——mkdir + git init 是秒级操作（不像 cloneRepo 那样可能跑几分钟），
 * 调用方（routes.ts）把它包进 withRepoLock 就够了：退出时 10 秒的排空上限对它绰绰有余，
 * 见 routes.ts 里 /api/new-project 处的注释。
 */
export async function createProject(parent: string, name: string, roots: string[]): Promise<ScaffoldResult> {
  if (!NAME_RE.test(name)) return { ok: false, error: "名称只能包含字母、数字、下划线、连字符、点" }
  if (!isAbsolute(parent) || !existsSync(parent)) return { ok: false, error: "父目录不存在" }
  if (!underRoot(parent, roots)) return { ok: false, error: "父目录必须在已配置的扫描根目录之内" }
  const target = join(parent, name)
  if (existsSync(target)) return { ok: false, error: "目标目录已存在" }
  try {
    mkdirSync(target)
    await runGit(target, ["init", "-b", "main"])
    writeFileSync(join(target, "README.md"), `# ${name}\n`)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 清理克隆用的临时目录，绝不让清理本身的异常穿出去。Windows 上 runGit 超时后 child.kill() 只
 *  结束顶层 git 进程，git-remote-https/index-pack 之类的孙进程仍可能占着临时目录里的文件句柄，
 *  这时 rmSync 会抛 EBUSY/EPERM——force 选项只压制 ENOENT，压不住这些。
 *
 *  清理失败时不重试、不记账，只打一行日志给出残骸路径——见文件顶部注释：这类残骸点号开头、
 *  scanner 忽略、界面上看不见，用户想清也就是手动删一下，不值得为它再搭一套账本。 */
function safeCleanupTmp(tmpDir: string): void {
  try {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  } catch (err) {
    console.error(
      `[repo-radar] 清理克隆临时目录失败，残留在：${tmpDir}（不影响使用，scanner 会忽略这个点号开头的目录，可手动删除）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/** rename 失败时把 fs 错误码翻成用户可读的话，绝不把原始 fs 报文（含绝对路径）直接抛给界面。
 *
 *  不靠错误码猜——Windows 上 renameSync 抛 EPERM 更常见的原因是**源**临时目录被占用（git 子
 *  进程句柄、杀毒软件扫描、资源管理器开着那个目录），而不是目标存在，用错误码猜会说出一句与
 *  事实无关的话。改为不猜——rename 失败后显式检查 finalDir 是否真的存在，用事实决定说哪句话：
 *  确实存在 → 与克隆前预检查同一句话，保持体验一致；不存在 → 给一句可读的通用失败信息，附带
 *  原始错误码方便排查，不把原始 fs 报文（含绝对路径）直接抛给界面。 */
function friendlyRenameError(err: unknown, finalDir: string): string {
  if (existsSync(finalDir)) return "目标目录已存在"
  const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
  return `重命名克隆结果失败${code ? `（${code}）` : ""}`
}

/**
 * 从远程 URL 克隆到父目录（须在扫描根之内）。
 *
 * 先克隆到父目录同级的一个带前缀的临时目录，成功后再 rename 成最终名字——这样即便进程在克隆
 * 中途被硬切（比如托盘退出，见 queue.ts 顶部的注释：退出排空的上限是 10 秒，克隆一个大仓库
 * 可能要几分钟，排空对 clone 这类操作形同虚设，绝不该假装能等到它跑完），留下的也只是一个
 * 带识别前缀、扫描器本就忽略的临时目录，而不是一个用最终名字出现、有 .git 但没有 HEAD/refs
 * 的半成品仓库。临时目录与目标同级、同一文件系统，rename 不必处理跨设备的情况。
 *
 * 不记账、不做启动清扫——见 CLONE_TMP_PREFIX 顶部注释。
 */
export async function cloneRepo(url: string, parent: string, roots: string[]): Promise<ScaffoldResult> {
  const u = url.trim()
  if (u === "" || u.startsWith("-")) return { ok: false, error: "URL 非法" }
  if (!isAbsolute(parent) || !existsSync(parent)) return { ok: false, error: "父目录不存在" }
  if (!underRoot(parent, roots)) return { ok: false, error: "父目录必须在已配置的扫描根目录之内" }
  const derivedName = u.replace(/\.git$/, "").replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? ""
  const tmpName = `${CLONE_TMP_PREFIX}${randomBytes(8).toString("hex")}`
  const tmpDir = join(parent, tmpName)
  // URL 猜不出名字这种边缘情况（比如 url 本身就是路径分隔符结尾）：退而用随机后缀本身当目录名，
  // 保证总有一个非空、确定的最终目录名，不再依赖 git 自己在 parent 下随意起的名字
  const finalName = derivedName !== "" ? derivedName : tmpName.slice(CLONE_TMP_PREFIX.length)
  const finalDir = join(parent, finalName)
  if (existsSync(finalDir)) return { ok: false, error: "目标目录已存在" }

  try {
    await runGit(parent, ["clone", "--", u, tmpName], 300_000) // 网络操作，超时 5 分钟

    // 克隆耗时数秒到数分钟，期间可能有另一个并发请求（不同的临时目录名）抢先把 finalDir
    // 建好——rename 前再查一次，命中就按"目标已存在"处理，不要让它走到 rename 才在几分钟后
    // 炸出一句原始 ENOTEMPTY
    if (existsSync(finalDir)) {
      safeCleanupTmp(tmpDir)
      return { ok: false, error: "目标目录已存在" }
    }
    try {
      renameSync(tmpDir, finalDir)
    } catch (renameErr) {
      // 即便刚才检查过，rename 本身仍可能因为极窄的竞态或平台限制（比如目标名在文件系统上非法）
      // 撞上 ENOTEMPTY/EEXIST/EPERM 之类——具体说哪句话交给 friendlyRenameError 按事实判断
      //
      // 只有目标确实存在时，tmpDir 才是"多余的、可以清掉的"。目标不存在时（最典型：源被占用
      // 导致 rename 失败），tmpDir 实际上是一份已经克隆完整的仓库，绝不能删掉它——删了用户
      // 就白白丢失一次成功的克隆，留在磁盘上让用户自己处理
      if (existsSync(finalDir)) safeCleanupTmp(tmpDir)
      return { ok: false, error: friendlyRenameError(renameErr, finalDir) }
    }
    return { ok: true, path: finalDir }
  } catch (err) {
    // 正常失败（网络错误、URL 不存在等）留下的半成品临时目录不必留着，这里能清就清
    safeCleanupTmp(tmpDir)
    const msg =
      err instanceof GitError && err.stderr.trim() !== ""
        ? err.stderr.trim().split("\n").pop()!
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, error: msg }
  }
}
