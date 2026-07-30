import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import type { CommitInfo, DirtyCounts, RemoteInfo, RepoStatus } from "./types"
import { mapLimit } from "./map-limit"
import { readRepoMeta } from "./meta"
import { detectLanguage } from "./lang"

export interface GitResult {
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly stdout = "", // 有些信息（如合并/stash 的 CONFLICT 行）git 打到 stdout，失败时也需保留
  ) {
    super(message)
    this.name = "GitError"
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 凡是**输出路径**的 git 命令都要带上它（全局参数，必须放在子命令之前）。git 默认
 * core.quotePath=true，会把路径里的非 ASCII 字节 C-quote 掉：中文/emoji/重音文件名在详情面板
 * 显示成 "caf\303\251.md"，diff 头是 `diff --git "a/\344\270\255\346\226\207…"`——
 * 而本应用的目标用户就是多语言仓库，这属于日常状态而非边角情形。
 *
 * 它只关掉**非 ASCII** 的转义：含 `"` / `\` / 控制字符的路径仍会被引号包起来，那是必须保留的
 * 行为（否则带换行的文件名会把逐行解析的输出撑破），别改成任何「全量不转义」的写法。
 * 分支名和 tag 名不受 quotePath 影响（实测裸 UTF-8），所以范围只有 diff / ls-files / stash show。
 */
const QUOTE_PATH_OFF = ["-c", "core.quotePath=false"]

/**
 * 每一条 `git log` 都要带上：用户 gitconfig 里 `log.showSignature=true`（签名提交的人常开）时，
 * git 会在**每条**提交的 --format 输出之前往 stdout 插一行验签结果（`Good "git" signature…`
 * 或 `No signature`）。四处 git log 全是「一行 = 一条提交」的解析，于是 3 条提交解析成 6 条，
 * 一半是 hash 为 "No signature"、message/author/date 全 undefined 的空条目——详情面板的
 * 「最近提交」和卡片预览里每条真提交后面夹一条空行，时间渲染成「刚刚」，React key 还撞。
 */
export const NO_SHOW_SIGNATURE = ["-c", "log.showSignature=false"]

/**
 * 凡是输出**提交信息/作者名/stash 说明**的 log 家族命令都要带上。用户在 gitconfig 里设
 * `i18n.logOutputEncoding=GBK`（中文 Windows 用户治 git log 乱码的标准做法，日文对应 cp932）
 * 之后，git 按该编码输出字节，而 runGit 无条件 setEncoding("utf8")，每个汉字都成 U+FFFD。
 *
 * 更糟的是它会被固化：lastCommit 在 RepoHeavy 里、git 退出码是 0 所以不算 degraded，这份乱码
 * 连同指纹一起写进 repo-cache.json。用户事后改回 gitconfig 也没用——指纹没变就一直命中坏缓存。
 */
export const LOG_UTF8 = ["-c", "i18n.logOutputEncoding=UTF-8"]

/**
 * diff 类命令必须带：用户设了 `color.ui=always` / `color.diff=always` 之后，git 即便在管道里
 * 也会上色，ANSI 转义进入被逐行解析的 diff 文本。前端按 `+`/`-`/`@@` 前缀上色（DetailPanel），
 * 行首变成 ESC 之后三个判据全落空——红绿高亮整个死掉，用户看到的是每行都挂着字面量 `[1m`。
 *
 * 必须用 `--no-color` 而不是 `-c color.ui=false`：后者压不住更具体的 `color.diff`（实测转义仍在）。
 */
const NO_COLOR = ["--no-color"]

export function runGit(cwd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, extraEnv?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: extraEnv ? { ...process.env, ...extraEnv } : undefined })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new GitError(`git ${args.join(" ")} timed out after ${timeoutMs}ms`, stderr, stdout))
    }, timeoutMs)
    // setEncoding 走 StringDecoder：多字节字符（中文等）跨 chunk 边界时缓存半个字符等下一块，
    // 逐 chunk Buffer.toString 会把边界上的字符各解各的、两边都成 U+FFFD（>64KB 的中文 log/diff 必现）
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    // 管道自身的 'error' 必须有人听。cwd 超过 Windows MAX_PATH(260) 时 spawn 是在**管道已建立
    // 之后**才失败的，stdout/stderr 各 emit 一次 `read ENOTCONN`；无人监听的流 error 会被 Node
    // 升级成进程级 uncaughtException，desktop 那边的兜底随即弹「repo-radar 遇到问题」并 exit(1)。
    // 而这条路径在启动扫描里必经——扫描根下只要有一个超长路径的仓库，应用每次启动都在同一处
    // 死掉，对话框里只有 `read ENOTCONN`，既不指出哪个仓库也不提路径长度，面板起不来也没法移除它。
    // 失败原因由下面 child.on("error") 的 GitError 如实上报，这里是重复信息，空监听即可。
    // 实测阈值精确为 260：259 字符干净走 child error，260 起必现两条 uncaught。
    child.stdout.on("error", () => {})
    child.stderr.on("error", () => {})
    child.stdout.on("data", (d: string) => (stdout += d))
    child.stderr.on("data", (d: string) => (stderr += d))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(new GitError(`failed to spawn git: ${err.message}`, ""))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new GitError(`git ${args.join(" ")} exited with ${code}`, stderr, stdout))
    })
  })
}

/** 把 git 输出按行拆分，trim 每行并丢掉空行——Windows CRLF 的尾随 \r 也一并去掉。列表类输出统一走这里。 */
export function splitLines(r: GitResult): string[] {
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "")
}

/**
 * 从 git 抛出的错误里取一句最有用的提示：优先 error:/fatal: 行（真正的原因），
 * 其次最后一条非 hint:/Aborting 行——切分支被脏工作区挡住时 stderr 末行是没用的「Aborting」，
 * 真原因在首行 error: 里。都没有才退回末行 / String(err)。
 */
export function gitErrMessage(err: unknown): string {
  // 无 stderr（超时/spawn 失败）时用 err.message——String(err) 会把 "GitError:" 类名前缀带进用户可见文案
  if (!(err instanceof GitError) || err.stderr.trim() === "") return err instanceof Error ? err.message : String(err)
  const lines = err.stderr.trim().split("\n").map((s) => s.trim()).filter((s) => s !== "")
  const real = lines.find((l) => /^(error|fatal):/i.test(l))
  return real ?? lines.filter((l) => !/^hint:|^Aborting\.?$/i.test(l)).pop() ?? lines[lines.length - 1]
}

/** git 命令成功时的「最后一行有意义输出」：合并 stdout+stderr、去空行、取末行。 */
function lastLine(r: GitResult): string {
  const out = (r.stdout + "\n" + r.stderr).trim().split("\n").filter((l) => l !== "")
  return out[out.length - 1] ?? ""
}

export function repoId(path: string): string {
  const normalized = path.replace(/\\/g, "/").toLowerCase()
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12)
}

/**
 * 仓库的根提交 hash（第一个没有父提交的 commit）。跨卷移动、从备份恢复、以及
 * `stat().ino` 不可用的文件系统上，这是识别「同一个仓库换了路径」的唯一判据。
 *
 * 只在身份认领时按需调用，日常扫描不跑。空仓库、多根提交、或命令失败一律返回 null，
 * 由认领逻辑当作「此判据不可用」处理（宁可不认，也不要认错）。
 */
export async function rootCommit(path: string): Promise<string | null> {
  try {
    const r = await runGit(path, ["rev-list", "--max-parents=0", "HEAD"])
    const lines = splitLines(r)
    return lines.length === 1 ? lines[0] : null // 多个根提交无法唯一标识，弃用
  } catch {
    return null
  }
}

/**
 * 当前 git 身份（用于工作记录默认「只看我」，按邮箱匹配）。
 * 优先全局身份——最能代表「我」，不受某个仓库本地 user.email 覆盖的影响（否则默认筛选可能把你的提交全藏了）；
 * 全局没设才退回该目录的有效配置。两者都取不到邮箱返回 null（前端据此默认「全部」）。
 */
export async function currentGitIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
  const read = (scope: string[], key: string) => runGit(cwd, ["config", ...scope, key]).then((r) => r.stdout.trim()).catch(() => "")
  let [email, name] = await Promise.all([read(["--global"], "user.email"), read(["--global"], "user.name")])
  if (email === "") [email, name] = await Promise.all([read([], "user.email"), read([], "user.name")])
  return email !== "" ? { name, email } : null
}

export interface ParsedStatus {
  branch: string | null
  ahead: number
  behind: number
  // 配置的上游（`# branch.upstream origin/x`），没配则为 null。
  // 光看 ahead/behind 分不出「没配上游」和「配了但远程分支已被删」——后者 git 照样给
  // branch.upstream、但给不出 branch.ab（远程跟踪 ref 没了，算不出差距），于是两种都是 -1
  upstream: string | null
  dirty: DirtyCounts
  // HEAD 的 commit oid。git 一直在 `--branch` 的输出里给这一行，以前没解析。
  // 指纹要用它判断「这个仓库自上轮以来有没有新提交」——白拿，不增加任何 git 调用。
  // 空仓库输出 `# branch.oid (initial)`，按 null 处理
  oid: string | null
}

export function parseStatus(out: string): ParsedStatus {
  let branch: string | null = null
  let ahead = -1
  let behind = -1
  let upstream: string | null = null
  let oid: string | null = null
  const dirty: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const v = line.slice("# branch.oid ".length).trim()
      oid = v === "(initial)" ? null : v
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length)
      branch = head === "(detached)" ? null : head
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ")[1] // 两字符 XY，"." 表示该侧无变化
      if (xy[0] !== ".") dirty.staged++
      if (xy[1] !== ".") dirty.unstaged++
    } else if (line.startsWith("u ")) {
      dirty.conflicted++
    } else if (line.startsWith("? ")) {
      dirty.untracked++
    }
  }
  return { branch, ahead, behind, upstream, dirty, oid }
}

export function parseRemotes(out: string): RemoteInfo[] {
  const seen = new Map<string, string>()
  for (const line of out.split("\n")) {
    const m = /^(\S+)\t(.+) \(fetch\)$/.exec(line)
    if (m) seen.set(m[1], m[2])
  }
  return [...seen].map(([name, url]) => ({ name, url }))
}

export function parseLastCommit(out: string): CommitInfo | null {
  const [hash, message, author, date] = out.trim().split("\0")
  if (!hash) return null
  return { hash, message, author, date }
}

export interface RepoDetail {
  recentCommits: CommitInfo[]
  stashes: StashEntry[]
  branches: string[] // 本地分支名（含当前分支），main/master 置顶，供详情面板切换
  remoteBranches: string[] // 远程独有分支（本地没有同名的），检出时 git 自动建跟踪分支
}

const HEADS_PREFIX = "refs/heads/"

/**
 * `git branch --format=%(refname)` 的输出 → 本地分支名。
 *
 * 必须用 %(refname) 而不是 %(refname:short)：游离 HEAD / rebase 进行中时 `git branch` 会多打
 * 一行伪条目（`(HEAD detached at v1)`、`(no branch, rebasing feat)`），在 :short 下它就是那串
 * 裸文本，会被当成真分支混进「可清理分支」和分支切换器——点清理必然报
 * `error: branch '(HEAD detached at v1)' not found`，切换过去是 `fatal: invalid reference`。
 * 而此时 parseStatus 给出的 branch 是 null，`b !== branch` 那道本该剔除当前 HEAD 的过滤对它恒真。
 *
 * 判据取 refs/heads/ 前缀而不是「丢掉 ( 开头的名字」：`git branch '(weird)'` 是合法分支，
 * 它的 %(refname) 是 refs/heads/(weird)，那个启发式会误杀真分支。伪条目没有 refname，
 * git 原样打出那串裸文本，所以前缀判据是无损的。
 */
function localBranchNames(r: GitResult): string[] {
  return splitLines(r)
    .filter((l) => l.startsWith(HEADS_PREFIX))
    .map((l) => l.slice(HEADS_PREFIX.length))
}

// 分支排序：main/master 置顶，其余字母序
function sortBranches(list: string[]): string[] {
  const rank = (b: string) => (b === "main" || b === "master" ? 0 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

async function recentCommitsOf(path: string): Promise<CommitInfo[]> {
  return runGit(path, [...NO_SHOW_SIGNATURE, ...LOG_UTF8, "log", "-10", "--format=%H%x1f%s%x1f%an%x1f%aI"])
    .then((r) =>
      splitLines(r).map((line) => {
        const [hash, message, author, date] = line.split("\x1f")
        return { hash, message, author, date }
      }),
    )
    .catch(() => [])
}

/**
 * commitsOnly=true 时只取最近提交（供卡片「⋯」预览用），跳过 stash 统计与两次 branch 列举——
 * 那些只在详情面板才需要，别让轻量预览也付出 N 次 git stash show 的代价。
 */
export async function getRepoDetail(path: string, commitsOnly = false): Promise<RepoDetail> {
  if (commitsOnly) return { recentCommits: await recentCommitsOf(path), stashes: [], branches: [], remoteBranches: [] }
  const [recentCommits, stashes, localBranches, remoteRaw] = await Promise.all([
    recentCommitsOf(path),
    listStashes(path), // 结构化 stash（含 sha/分支/改动量），供详情面板直接操作
    runGit(path, ["--no-optional-locks", "branch", "--format=%(refname)"]).then(localBranchNames).catch(() => []),
    runGit(path, ["--no-optional-locks", "branch", "-r", "--format=%(refname:short)"]).then(splitLines).catch(() => []),
  ])
  const branches = sortBranches(localBranches)
  const localSet = new Set(localBranches)
  // 远程分支：去掉 remote 前缀（origin/feature → feature），排除 origin/HEAD 与已有本地同名。
  // 只保留恰好存在于「一个」远程的名字——多个远程同名时 `git switch <name>` DWIM 会有歧义而失败，
  // 这类名字不提供（带上远程前缀又超出「一键切换」的范围）。
  const remoteNames = remoteRaw.filter((b) => b.includes("/") && !b.endsWith("/HEAD")).map((b) => b.slice(b.indexOf("/") + 1))
  const count = new Map<string, number>()
  for (const n of remoteNames) count.set(n, (count.get(n) ?? 0) + 1)
  const remoteBranches = [...new Set(remoteNames)]
    .filter((b) => !localSet.has(b) && count.get(b) === 1)
    .sort((a, b) => a.localeCompare(b))
  return { recentCommits, stashes, branches, remoteBranches }
}

const SWITCH_TIMEOUT_MS = 120_000

/**
 * 切到指定本地分支（git switch）。有冲突的未提交改动时 git 会拒绝而非丢弃——如实回报错误，
 * 绝不加 -f/--discard-changes（避免丢工作区改动）。
 */
export async function switchBranch(path: string, branch: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await runGit(path, ["switch", branch], SWITCH_TIMEOUT_MS)
    return { ok: true, message: lastLine(r) }
  } catch (err) {
    const msg = gitErrMessage(err)
    return { ok: false, message: msg }
  }
}

/** 新建并切换到分支（git switch -c）。分支已存在 / 名字非法时 git 报错，如实回报。 */
export async function createBranch(path: string, name: string): Promise<{ ok: boolean; message: string }> {
  try {
    await runGit(path, ["switch", "-c", name], SWITCH_TIMEOUT_MS)
    return { ok: true, message: `已创建并切换到 ${name}` }
  } catch (err) {
    const msg = gitErrMessage(err)
    return { ok: false, message: msg }
  }
}

// code 与 CommitCode 同一约定：稳定枚举供前端按语言组装文案，message 保留中文原文作日志/回退
export type DiscardCode = "discarded" | "outOfScope" | "unbornHead" | "error"
export interface DiscardResult {
  ok: boolean
  code: DiscardCode
  message: string
}

/**
 * 丢弃全部未提交改动：reset --hard HEAD（还原已跟踪的改动/删除）+ clean -fd（删未跟踪文件/目录，
 * 但保留 .gitignore 忽略项，不加 -x 以免误删 node_modules/.env 等）。**不可恢复**。
 */
export async function discardChanges(path: string): Promise<DiscardResult> {
  // --untracked-files=normal 与 getRepoCore 那条同理，缺了它整个复核会被 gitconfig 的
  // status.showUntrackedFiles=no 架空：`? ` 行全没了，before 与 residual 双双是空串，
  // 下面 nothingChanged 里的 `residual !== ""` 一票否决——纯嵌套仓库场景又会报绿色成功
  const readStatus = () =>
    runGit(path, ["--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=normal"])
      .then((r) => r.stdout)
      .catch(() => null)
  try {
    // 动手之前的快照。只看「之后还剩什么」分不出「丢干净了，剩的是 git 碰不了的」与「一个字节
    // 都没丢，剩的还是原样」——后者要报成功就成了空口宣告（见下方判据）
    const before = await readStatus()
    try {
      await runGit(path, ["reset", "--hard", "HEAD"], COMMIT_TIMEOUT_MS)
    } catch (resetErr) {
      // reset 失败：只有「整个仓库一个提交都没有」才走空仓库路径。用 rev-list --all 判定——
      // 若仓库其实有提交（rev-parse 偶发失败等），此时 read-tree --empty + clean 会把已提交文件当未跟踪删掉，
      // 是灾难性的，绝不能做：有任何不确定（rev-list 非空或本身失败）就抛出原错误、如实报失败。
      const noCommits = await runGit(path, ["rev-list", "-n", "1", "--all"]).then((r) => r.stdout.trim() === "").catch(() => false)
      if (!noCommits) {
        // HEAD 未出生但仓库别处有提交 = orphan 分支（`git switch --orphan gh-pages`）。这里**不**放宽
        // 上面那条判据去走空仓库路径：那条路会 read-tree --empty + clean -fd 把整个工作区清空，而
        // rev-list 的偏执正是在挡这个。只把 git 的内部术语（`fatal: ambiguous argument 'HEAD'`）换成
        // 一句用户看得懂的话——判据用 rev-parse 而不是匹配报错文本，git 的报错是会本地化的
        const headBorn = await runGit(path, ["rev-parse", "--verify", "HEAD"]).then(() => true).catch(() => false)
                  // 必须是**独立的 code**，不能塞进 code:"error"：那条 code 的不变量是「message 就是 git 原始
        // 输出」，前端 msg.discardFail 的 {err} 透传正建立在它上面。塞一句中文进去，18 种语言的
        // 用户都会读到中文——而改之前那里是 git 自己的报错，git 的报错**是**走 gettext 本地化的
        if (!headBorn) return { ok: false, code: "unbornHead", message: "当前分支还没有提交（orphan 分支），这里暂不支持丢弃改动" }
        throw resetErr
      }
      // 确属空仓库：清空暂存区让已 add 的文件转未跟踪，交给下面 clean 删除（否则「丢弃」会漏掉暂存的新文件）。
      await runGit(path, ["read-tree", "--empty"], COMMIT_TIMEOUT_MS)
    }
    // clean 单独 try：走到这里 reset 已经成功，已跟踪的改动是**真的、不可恢复地**没了。把 clean
    // 的失败交给最外层 catch 会返回一句笼统的「丢弃失败：warning: failed to remove locked.txt」——
    // 唯一的动词是 warning、主语是个未跟踪文件，用户读完的结论是「什么都没发生」，于是不会去重做
    // 那份工作。那是真实的数据丢失被一句错误提示盖住。Windows 上触发它只需要一个被别的进程
    // 打开的未跟踪文件，或一个正被终端/dev server 当作 CWD 的未跟踪目录。
    // 注意这里**不动 ok 的边界**：clean 失败以前返回 ok:false，现在仍然是 ok:false，只是在
    // ok:false 内部换个更准的分类，没有任何路径的成败判定被挪动。
    let cleanFailed: string | null = null
    try {
      await runGit(path, ["clean", "-fd"], COMMIT_TIMEOUT_MS)
    } catch (cleanErr) {
      cleanFailed = gitErrMessage(cleanErr)
    }
    // 复核一次再宣告成功。两类东西这两条 git 根本碰不到，而弹窗刚承诺「将丢弃 N 处未提交改动」：
    //   · submodule 里的改动——`reset --hard` 不递归进去。porcelain v2 用 sub 字段首字符 S 标记
    //     （`1 .M S.M. … sub`）。
    //   · 未跟踪的**嵌套 git 仓库**——`clean -fd` 对它们静默跳过（退出 0、无输出、条目原样留着）。
    //     它是 `? ` 行，与普通未跟踪目录长得一模一样，认不出来。
    // 所以判据分两支：看得见 submodule 残留，或者**整份 status 一个字节都没变**（等于什么都没丢）。
    // 只用后者不够——真改动 + 嵌套仓库并存时 status 变了、但仍有东西没丢；只用前者也不够——
    // 纯嵌套仓库时 status 没变却会报绿色成功，用户能一直点下去而磁盘毫无变化。
    // 复核本身读不到时不翻案（那两条 git 已经成功了）。
    const residual = await readStatus()
    const stuck = residual === null ? 0 : residual.split("\n").filter((l) => /^[12] \S+ S/.test(l)).length
    const nothingChanged = residual !== null && residual !== "" && residual === before
    if (stuck > 0 || nothingChanged || cleanFailed !== null) {
      // message 只作日志与兜底；界面按 code 走 i18n。文案必须与**原因无关**——这个分支现在同时
      // 覆盖 submodule 残留、纯嵌套仓库、clean 失败三种，把原因写死在句子里，每多一种就要再改
      // 一遍 18 份文案，而漏改的那次用户会看到一句与实际原因不符的解释
      return { ok: false, code: "outOfScope", message: cleanFailed ?? "有一部分改动这次没能丢弃" }
    }
    return { ok: true, code: "discarded", message: "已丢弃未提交改动" }
  } catch (err) {
    const msg = gitErrMessage(err)
    return { ok: false, code: "error", message: msg }
  }
}

const STASH_SEP = "\x1f"
const STASH_TIMEOUT_MS = 60_000

export interface StashEntry {
  ref: string // 当前的 stash@{n}；仅用于就地 diff/统计，操作一律按 sha 定位（不受丢弃/弹出后重新编号影响）
  sha: string // stash 提交 id；稳定不变。几乎唯一——仅当两条 stash 内容+时间戳(秒)+父提交全同才会撞 sha（罕见，且此时两者可互换）
  branch: string | null // 从 "WIP on <branch>:" 解析出的分支
  message: string // stash 描述，如 "WIP on main: e728679 2"
  date: string // ISO 8601 提交时间
  files: number
  insertions: number
  deletions: number
}

// stash 提交不可变：按 sha 记住改动量统计，避免每次详情/收纳箱打开都重跑 N 个 git stash show。
// 加一个上限，长期运行也不会无界增长（stash 丢弃后其 sha 条目留着是无害的，命中即失效由 sha 唯一性保证）。
const stashStatCache = new Map<string, { files: number; insertions: number; deletions: number }>()
const STASH_STAT_CACHE_MAX = 2000
// 单仓库内 `git stash show` 的并发上限。取 8 与 routes.ts 那层的仓库并发一致：两层相乘后
// 峰值有界（8 × 8），而不是「仓库数 × 每仓 stash 数」那样跟着用户的 stash 堆积无限长
const STASH_STAT_CONCURRENCY = 8

// `git stash show --include-untracked` 需 git ≥ 2.32。探测一次 git 版本并缓存，避免每条 stash 都「带 flag 失败再重试」的双倍进程。
let untrackedSupported: boolean | null = null
// 在飞探测：K 条 stash 在同一 tick 里全看到 untrackedSupported === null，各自 spawn 一个
// `git --version`，探测本身就成了它要省的那种进程扇出。与 github.ts 的 viewerInFlight 同一形状。
let untrackedProbe: Promise<boolean> | null = null
async function includeUntrackedSupported(cwd: string): Promise<boolean> {
  if (untrackedSupported !== null) return untrackedSupported
  if (untrackedProbe) return untrackedProbe
  untrackedProbe = (async () => {
    try {
      const v = await runGit(cwd, ["--version"]).then((r) => r.stdout).catch(() => null)
      // 探测本身失败（spawn 抖动、被杀毒锁住等）：本次保守不带 flag，但**不缓存**——否则一次抖动会永久降级，
      // 之后所有 stash show 都漏掉未跟踪内容（未跟踪-only 的 stash 会误报 files:0），直到重启。下次再探即可。
      if (v === null) return false
      const m = v.match(/(\d+)\.(\d+)/)
      // 解析出版本才缓存；解析不出（异常输出）当「不支持」并缓存：安全地少一份未跟踪统计，而不是带 flag 失败
      untrackedSupported = m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32) : false
      return untrackedSupported
    } finally {
      untrackedProbe = null // 失败那次不缓存结论，清掉在飞句柄才能下次重探
    }
  })()
  return untrackedProbe
}
// 按探测到的版本决定是否带 --include-untracked；不做「失败即退回」的兜底重试——那会把真错误掩盖成「diff 无未跟踪内容」。失败直接抛。
async function stashShow(path: string, extra: string[], ref: string): Promise<GitResult> {
  // -c core.quotePath=false：见 QUOTE_PATH_OFF。stash diff 里的中文/emoji 文件名否则是 "\344\270\255…"
  const args = [...QUOTE_PATH_OFF, "--no-optional-locks", "stash", "show", ...NO_COLOR]
  if (await includeUntrackedSupported(path)) args.push("--include-untracked")
  args.push(...extra, ref)
  return runGit(path, args)
}

/** 列出单个仓库的全部 stash（含改动量统计）。任一步失败都退化为空/零，绝不抛。 */
export async function listStashes(path: string): Promise<StashEntry[]> {
  const r = await runGit(path, [...LOG_UTF8, "--no-optional-locks", "stash", "list", `--format=%H${STASH_SEP}%gd${STASH_SEP}%cI${STASH_SEP}%gs`]).catch(() => null)
  if (r === null) return []
  const rows = splitLines(r).map((line) => {
    const [sha, ref, date, message] = line.split(STASH_SEP)
    const bm = message?.match(/^(?:WIP on|On) ([^:]+):/)
    return { sha, ref, date: date ?? "", message: message ?? "", branch: bm ? bm[1] : null }
  })
  // 限并发，不用 Promise.all：每条 stash 一个 `git stash show` 子进程，裸 Promise.all 的峰值是
  // 「本仓库的 stash 条数」，而 routes.ts 那层的 mapLimit(repos, 8) 只掐住了仓库这一维——
  // 实测峰值 = min(仓库数,8) × 每仓 stash 数（单仓 120 条 → 120 个并发 git；8 仓 × 25 条 → 200 个）。
  // 打开「收纳箱」或任一详情面板即触发，整机卡几秒；进程受限时 spawn 失败，而统计失败的降级是
  // 静默记 0，那些 stash 会在收纳箱里显示成「0 文件 / 0 行」——收纳箱正好提供批量丢弃。
  return mapLimit(rows, STASH_STAT_CONCURRENCY, async (row) => {
    const cached = stashStatCache.get(row.sha)
    if (cached) return { ...row, ...cached }
    let files = 0
    let insertions = 0
    let deletions = 0
    let ok = false
    try {
      // 用 sha（stash 提交号）而非 stash@{n}：并发 drop/pop 重新编号时统计不会张冠李戴，且与缓存 key（row.sha）一致
      const st = await stashShow(path, ["--numstat"], row.sha)
      for (const line of splitLines(st)) {
        const [add, del] = line.split("\t")
        files++
        if (add !== undefined && add !== "-") insertions += Number(add) || 0
        if (del !== undefined && del !== "-") deletions += Number(del) || 0
      }
      ok = true
    } catch {
      /* 统计失败则记 0 且不缓存（下次重试）*/
    }
    const stat = { files, insertions, deletions }
    // 只在版本探测「有定论」时缓存：探测瞬时失败的那一轮没带 --include-untracked，
    // 统计可能漏掉未跟踪内容——按 sha 永久缓存会让「纯未跟踪的 stash」永远显示 0 文件，
    // 用户当空 stash 批量丢弃就真丢数据了。无定论则本轮先用、下轮重算。
    if (ok && untrackedSupported !== null) {
      if (stashStatCache.size >= STASH_STAT_CACHE_MAX) stashStatCache.clear() // 到上限整体清空，避免无界增长
      stashStatCache.set(row.sha, stat)
    }
    return { ...row, ...stat }
  })
}

// 一次列出「sha → 当前 stash@{n}」映射。按 sha 定位不受丢弃/弹出后的重新编号影响。
// 极罕见地两条 stash 撞同一 sha 时（内容+时间戳+父提交全同）此 Map 只留后者，但那两条字节相同、可互换，
// 逐次 drop 即可清空——不因此退回 (sha,index) 定位（index 会漂移，带来更糟的错位）。stashDiff/stashAction/dropStashes 共用。
async function stashRefMap(path: string): Promise<Map<string, string>> {
  const r = await runGit(path, ["--no-optional-locks", "stash", "list", `--format=%H${STASH_SEP}%gd`]).catch(() => null)
  const map = new Map<string, string>()
  if (r === null) return map
  for (const line of splitLines(r)) {
    const [h, ref] = line.split(STASH_SEP)
    if (h !== undefined && ref !== undefined) map.set(h, ref)
  }
  return map
}

/**
 * 只读：取某条 stash 的完整 diff（截断保护）。stash 确实不存在返回 null（→ 404）；
 * stash list / stash show 真失败则**抛出**（由路由转 500），绝不静默成空 diff（那会被误显示成「无改动」）。
 */
export async function stashDiff(path: string, sha: string): Promise<string | null> {
  // 读列表失败要抛（→500），不能当成「stash 不存在」（→404）
  const listing = await runGit(path, ["--no-optional-locks", "stash", "list", "--format=%H"])
  if (!splitLines(listing).includes(sha)) return null // 确实没有这条 stash → 404
  // 直接把 sha（stash 是提交，git stash show 接受提交号）传给 stash show，不经 stash@{n}——
  // 免疫并发 drop/pop 造成的重新编号：即便这条刚被丢弃，提交对象仍在，diff 仍是它本身。失败则抛 →500。
  let diff = (await stashShow(path, ["-p"], sha)).stdout
  if (diff.length > DIFF_MAX_CHARS) diff = diff.slice(0, DIFF_MAX_CHARS) + "\n… (diff 已截断)"
  return diff
}

export type StashOp = "apply" | "pop" | "drop"

/**
 * 对单条 stash 执行 apply/pop/drop，按 sha 定位当前 ref（sha 唯一，且重新编号后仍稳定）。
 * pop 遇冲突时 git 会保留该 stash 并非零退出——如实回报 stderr，工作区的冲突由下次刷新体现。
 */
export async function stashAction(path: string, sha: string, op: StashOp): Promise<{ ok: boolean; message: string; conflict?: boolean }> {
  const ref = (await stashRefMap(path)).get(sha)
  if (ref === undefined) return { ok: false, message: "stash 未找到（可能已被处理）" }
  try {
    // 强制 C locale：冲突时 git 把 "CONFLICT (…)" 打到 stdout，本地化 git 会翻译这行导致下面的正则漏判——
    // 用英文输出保证冲突识别稳定（apply/pop 撞冲突时改动已入工作区、stash 仍保留，必须准确区分而非报「失败」）
    const r = await runGit(path, ["stash", op, ref], STASH_TIMEOUT_MS, { LC_ALL: "C" })
    return { ok: true, message: lastLine(r) }
  } catch (err) {
    const stdout = err instanceof GitError ? err.stdout : ""
    const msg = gitErrMessage(err) // 取 error:/fatal: 行——apply/pop 被本地改动挡住时末行是没用的「Aborting」
    // apply/pop 撞冲突：改动已带标记应用进工作区、stash 仍保留（pop 不会丢），属「需手动解决」而非纯失败。
    // 依据 git 打到 stdout 的 "CONFLICT (…)" 行判定——只认本次操作产生的冲突，不会把工作区原有的未合并路径误判。
    const conflict = (op === "apply" || op === "pop") && /^CONFLICT\b/im.test(stdout)
    return { ok: false, message: msg, conflict }
  }
}

/**
 * 批量丢弃同一仓库内的多条 stash，按 sha 定位。一次列出 sha→ref，解析出各自当前 index，
 * 从高到低删除——高位丢弃不会使低位重新编号。sha 已不在列表里的回报「未找到」。
 */
export async function dropStashes(path: string, shas: string[]): Promise<{ sha: string; ok: boolean; message: string }[]> {
  const results: { sha: string; ok: boolean; message: string }[] = []
  // 每删一条前重新解析 sha→当前 ref：批量删除耗时数秒，期间用户在终端里 pop/drop 会让
  // 预先算好的 index 整体位移，按陈旧 index 删会**删错别人**（不可恢复）。逐条重列表，
  // TOCTOU 窗口缩到毫秒级；且每次都用最新编号，也就无需「从高往低删」的排序技巧。
  for (const sha of shas) {
    const ref = (await stashRefMap(path)).get(sha)
    if (ref === undefined) {
      results.push({ sha, ok: false, message: "stash 未找到（可能已被处理）" })
      continue
    }
    try {
      await runGit(path, ["stash", "drop", ref])
      results.push({ sha, ok: true, message: "已丢弃" })
    } catch (err) {
      results.push({ sha, ok: false, message: gitErrMessage(err) })
    }
  }
  return results
}

/**
 * 把当前未提交改动（含未跟踪 -u）收进一条新 stash。用「stash 条数是否增加」判断是否真的存进去了——
 * 比匹配 git 输出文案稳（-m 消息会被回显到 stdout，且文案随 git 语言而变），无改动时回 empty:true。
 */
export async function createStash(path: string, message: string): Promise<{ ok: boolean; message: string; empty?: boolean }> {
  const args = ["stash", "push", "--include-untracked"]
  if (message.trim() !== "") args.push("-m", message.trim())
  try {
    const before = await stashCount(path) // 失败则抛（还没 push，安全）→ 外层 catch
    await runGit(path, args, STASH_TIMEOUT_MS) // push；本身失败 → 外层 catch
    let after: number
    try {
      after = await stashCount(path)
    } catch {
      // push 已成功但事后计数失败：保守当作「已存进去」，绝不误报「没有可暂存」（那会让用户以为改动丢了）
      return { ok: true, message: "已收进 stash" }
    }
    if (after <= before) return { ok: false, empty: true, message: "没有可暂存的改动" } // 条数没增 = 没东西可存
    return { ok: true, message: "已收进 stash" }
  } catch (err) {
    const msg = gitErrMessage(err)
    return { ok: false, message: msg }
  }
}

async function stashCount(path: string): Promise<number> {
  const r = await runGit(path, ["--no-optional-locks", "stash", "list", "--format=%H"]) // 失败则抛，供调用方区分「读失败」与「0 条」
  return splitLines(r).length
}

export type RepoAction = "fetch" | "pull" | "push"

export const ACTION_ARGS: Record<RepoAction, string[]> = {
  fetch: ["fetch"],
  pull: ["pull", "--ff-only"],
  push: ["push"],
}

const ACTION_TIMEOUT_MS = 120_000

export async function runRepoAction(path: string, action: RepoAction): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await runGit(path, ACTION_ARGS[action], ACTION_TIMEOUT_MS)
    const lines = (r.stdout + "\n" + r.stderr).trim().split("\n")
    return { ok: true, message: lines[lines.length - 1] ?? "" }
  } catch (err) {
    if (err instanceof GitError && err.stderr.trim() !== "") {
      const lines = err.stderr.trim().split("\n")
      return { ok: false, message: lines[lines.length - 1] }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 安全删除已合并的本地分支（git branch -d，只删已合并的，未合并会失败而非强删）。
 * 返回每个分支的删除结果。
 */
export async function deleteBranches(path: string, names: string[]): Promise<{ name: string; ok: boolean; message: string }[]> {
  const out: { name: string; ok: boolean; message: string }[] = []
  for (const name of names) {
    try {
      await runGit(path, ["branch", "-d", name])
      out.push({ name, ok: true, message: "已删除" })
    } catch (err) {
      const msg = gitErrMessage(err)
      out.push({ name, ok: false, message: msg })
    }
  }
  return out
}

const DIFF_MAX_CHARS = 20_000

export interface RepoDiff {
  diff: string
  untracked: string[]
}

export async function getRepoDiff(path: string): Promise<RepoDiff> {
  let diff = ""
  // 三条命令都带 QUOTE_PATH_OFF：diff 头和未跟踪列表都是**路径**，不带就是一屏八进制转义
  try {
    const r = await runGit(path, [...QUOTE_PATH_OFF, "--no-optional-locks", "diff", ...NO_COLOR, "HEAD"])
    diff = r.stdout
  } catch {
    try {
      const r = await runGit(path, [...QUOTE_PATH_OFF, "--no-optional-locks", "diff", ...NO_COLOR])
      diff = r.stdout
    } catch {
      diff = ""
    }
  }
  if (diff.length > DIFF_MAX_CHARS) {
    diff = diff.slice(0, DIFF_MAX_CHARS) + "\n… (diff 已截断)"
  }
  const untracked = await runGit(path, [...QUOTE_PATH_OFF, "--no-optional-locks", "ls-files", "--others", "--exclude-standard"])
    .then((r) => r.stdout.split("\n").filter((line) => line !== ""))
    .catch(() => [])
  return { diff, untracked }
}

const COMMIT_TIMEOUT_MS = 120_000

// code 是稳定枚举，供前端按语言组装文案；message 保留中文原文作日志/回退；detail 是 git 原始报错
export type CommitCode = "committed" | "committedPushed" | "pushFailed" | "commitError"
export interface CommitResult {
  ok: boolean
  code: CommitCode
  message: string
  detail?: string
}

export async function commitRepo(path: string, message: string, push: boolean): Promise<CommitResult> {
  try {
    await runGit(path, ["add", "-A"], COMMIT_TIMEOUT_MS)
    await runGit(path, ["commit", "-m", message], COMMIT_TIMEOUT_MS)
  } catch (err) {
    const detail = gitErrMessage(err)
    return { ok: false, code: "commitError", message: detail, detail }
  }

  if (push) {
    try {
      await runGit(path, ["push"], COMMIT_TIMEOUT_MS)
      return { ok: true, code: "committedPushed", message: "已提交并推送" }
    } catch (err) {
      const detail = gitErrMessage(err)
      return { ok: true, code: "pushFailed", message: `已提交，推送失败：${detail}`, detail }
    }
  }

  return { ok: true, code: "committed", message: "已提交" }
}

/** status 一条命令就能得到的部分。永远执行——工作区脏状态必须实算，不能缓存 */
export interface RepoCore {
  branch: string | null
  dirty: DirtyCounts
  ahead: number
  behind: number
  upstream: string | null
  oid: string | null
}

/**
 * 需要额外 6 个 git 进程的部分。这些结果**只会因 `.git` 里的变化而变**，因此可以按指纹缓存。
 *
 * 「只由 `.git` 决定」是这个接口的准入条件，不是描述。displayName（package.json 的 name）、
 * description（README 首段）、language（根目录列表）曾经也在这里，但它们全部来自**工作区**：
 * 任何一个都不可能出现在一个完全由 `.git` 算出来的指纹里，于是改 package.json 的 name——
 * 正是用户重命名项目的那一刻——卡片标题会一直冻结到某次无关的 git 操作为止。
 * 它们已经移到 composeStatus 里永远执行（都不 spawn 进程，只是几次 existsSync/readFileSync
 * 和一次 readdirSync），从此不再依赖探针集合的完备性。往这里加字段之前先问一遍：
 * 它会不会因为工作区的变化而变？会的话就不属于这里。
 */
export interface RepoHeavy {
  stashCount: number
  stashOldest: string | null
  release: { tag: string; ahead: number; tagDate: string } | null
  remotes: RemoteInfo[]
  lastCommit: CommitInfo | null
  mergedBranches: string[]
}

/** 1 个 git 进程。status 失败（非 git 目录、git 缺失）直接抛出，由调用方决定如何降级。
 *  --no-optional-locks：读状态时不刷新/写 .git/index，避免触发文件监听的自反馈 */
export async function getRepoCore(path: string): Promise<RepoCore> {
  const status = await runGit(path, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"])
  const parsed = parseStatus(status.stdout)
  return { branch: parsed.branch, dirty: parsed.dirty, ahead: parsed.ahead, behind: parsed.behind, upstream: parsed.upstream, oid: parsed.oid }
}

/**
 * getRepoHeavy 的返回值。**heavy 与 degraded 必须一起走**，不能只返回 heavy。
 *
 * 六个子命令各自 catch 并填一个默认值（`[]` / `null` / `0`），于是「这个仓库真的没有远程」
 * 与「`git remote -v` 这一次 spawn 失败/被杀软锁住/在网络盘上超时了」在返回值里长得一模一样。
 * 调用方分不清，就会把降级结果连同当前指纹写进 `repo-cache.json`——而指纹是 `.git` 的 stat
 * 快照，仓库没动它就不变，于是此后**每一轮**都命中这条坏缓存：卡片红着「没有远程仓库」、
 * GitHub 描述与 PR/CI 收件箱被清空、`githubTargets` 把这个仓库整个过滤掉再也不去拉、
 * 从远程推导的 displayName 也没了。点重扫不管用，重启也不管用（坏条目在磁盘上，还有 30 天
 * 年龄护栏）。改造前 `getRepoStatus` 每轮重算，同样的临时失败一个周期内自愈。
 */
export interface RepoHeavyResult {
  heavy: RepoHeavy
  /** 本次结果里至少有一个字段是失败后填的默认值，不是仓库的真实状态。
   *  照常返回给本轮使用（有总比没有强），但**绝不能固化进指纹缓存** */
  degraded: boolean
}

/**
 * 至多 6 个 git 进程，全部并发。
 *
 * 需要 core 而不只是 branch：branch 用于剔除 mergedBranches 里的当前分支，**oid 用于区分
 * 「正当的空结果」与「真降级」**。这条边界做错会引入新 bug，两个方向都错得很实在：
 *  · 把正当空结果判成降级 → 每个空仓库/无 tag 仓库**永远无法缓存**，每轮付全价；
 *  · 把真降级判成正当结果 → 就是上面 RepoHeavyResult 描述的那条坏缓存。
 *
 * 判据取 `core.oid === null`（即 `status --porcelain=v2 --branch` 报的 `# branch.oid (initial)`）
 * 而不是匹配 stderr 文案：本机 git 2.48 实测，无提交的仓库里 `log -1` 报
 * 「does not have any commits yet」、`branch --merged` 报「malformed object name HEAD」——
 * 两句都会随 git 版本和 locale 变，而 branch.oid 是机器可读的稳定契约。
 *
 * 其余三个子命令没有「正当失败」：无 stash / 无 tag / 无远程时 git 都是 0 退出 + 空输出
 * （已实测），因此它们只要抛就是真降级。
 */
export async function getRepoHeavy(path: string, core: Pick<RepoCore, "branch" | "oid">): Promise<RepoHeavyResult> {
  const { branch } = core
  const hasCommits = core.oid !== null
  let degraded = false
  /** 「这个值是失败后填的默认值」——原样返回给本轮用，但打上标记，别让调用方拿去固化 */
  const degrade = <T>(fallback: T): T => {
    degraded = true
    return fallback
  }
  const [stashInfo, release, remotes, lastCommit, mergedRaw] = await Promise.all([
    // stash 条数 + 最老一条的时间（list 新→旧，最老在末行）——「搁了多久」提醒用。
    // 无 stash 时 0 退出 + 空输出，所以抛出一律是真失败
    runGit(path, ["stash", "list", "--format=%cI"])
      .then((r) => {
        const lines = splitLines(r)
        return { count: lines.length, oldest: lines.length > 0 ? lines[lines.length - 1] : null }
      })
      .catch(() => degrade({ count: 0, oldest: null as string | null })),
    // 发版雷达：按「创建时间」取全库最新 tag（annotated 记打 tag 的时间、lightweight 记提交时间）。
    // 不用 describe——它只找 HEAD 可达的最近 tag，会漏掉未合并分支上刚发的版、日期也会错拿提交时间。
    // 计数用 HEAD --not --tags（HEAD 上不被任何 tag 覆盖的提交）：即便最新 tag 不是 HEAD 的祖先
    // （比如在老维护分支上补发 v1.0.1），也不会把 merge-base 以来的所有提交都算成「未发版」。
    (async () => {
      let r: GitResult
      try {
        r = await runGit(path, ["for-each-ref", "refs/tags", "--sort=-creatordate", "--count=1", "--format=%(refname:short)%00%(creatordate:iso-strict)"])
      } catch {
        return degrade(null) // for-each-ref 连列都列不出来 = 真失败
      }
      const [tag, tagDate] = r.stdout.trim().split("\0")
      // 从未打过 tag：for-each-ref 0 退出 + 空输出，这是**正确答案**而不是失败。
      // 判成降级的话，所有还没发过版的仓库（新项目的常态）永远缓存不上，每轮全价
      if (!tag) return null
      try {
        const aheadR = await runGit(path, ["rev-list", "--count", "HEAD", "--not", "--tags"])
        return { tag, ahead: Number(aheadR.stdout.trim()) || 0, tagDate: tagDate ?? "" }
      } catch {
        // 有 tag 却数不出「未发版提交数」：唯一正当的情形是 HEAD 还没有提交（孤儿分支上打过 tag），
        // 其余都是真失败。宁可整条 release 返 null，也不要编一个 ahead=0 显示到发版雷达上
        return hasCommits ? degrade(null) : null
      }
    })(),
    // 无远程时 0 退出 + 空输出，所以抛出一律是真失败——这正是 H2 里那条坏缓存的入口
    runGit(path, ["remote", "-v"]).then((r) => parseRemotes(r.stdout)).catch(() => degrade([] as RemoteInfo[])),
    runGit(path, [...NO_SHOW_SIGNATURE, ...LOG_UTF8, "log", "-1", "--format=%H%x00%s%x00%an%x00%aI"])
      .then((r) => parseLastCommit(r.stdout))
      // 空仓库无 HEAD 时 git log 非零退出，那是「还没有提交」这个正确答案；有提交却读不出来才是降级
      .catch(() => (hasCommits ? degrade(null) : null)),
    // --format 必须在 --merged 之前：否则 git 会把 --format=… 当成 --merged 的 commit 参数而报错
    runGit(path, ["branch", "--format=%(refname)", "--merged"])
      .then(localBranchNames)
      // 同上：无 HEAD 时 --merged 无从解析（实测 fatal: malformed object name HEAD），是正当空结果
      .catch(() => (hasCommits ? degrade([] as string[]) : [])),
  ])
  return {
    heavy: {
      stashCount: stashInfo.count,
      stashOldest: stashInfo.oldest,
      release,
      remotes,
      lastCommit,
      // 可安全清理的已合并分支。**只有站在主干上时才判得准**：不带 base 的 `--merged` 判的是
      // 「已合并进 HEAD」，站在 feature 上时它会把尚未并进主干的 develop 也算进来；游离 HEAD 时
      // 更糟——parseStatus 给出 branch=null，下面那道剔除当前分支的过滤恒真，于是**你正站着的
      // 那条分支**进了列表，而「清理已合并分支」是全应用唯一没有二次确认的破坏性按钮，一点下去
      // 那些提交就没有任何分支能到达（实测 git fsck 报 unreachable，只剩 reflog 兜 90 天）。
      // 主干只认 main/master——这一行原本就是这么假设的（按名字排除的正是这两个）。
      // 判不出「相对谁安全」时就不给列表：不做无法证实的安全承诺。
      mergedBranches: branch === "main" || branch === "master" ? mergedRaw.filter((b) => b !== "main" && b !== "master") : [],
    },
    degraded,
  }
}

/**
 * 把 core + heavy 拼成看板用的完整状态。装饰字段（tags/favorite/…）留给 RepoStore.decorate。
 *
 * displayName / description / language 在这里现算，**不进 heavy 也就不进指纹缓存**：
 * 它们分别来自 package.json 的 name、README 首段、根目录列表——统统是工作区的东西，
 * 而指纹完全由 `.git` 算出来，不可能反映它们的变化。放在 heavy 里的那阵子，
 * 改 package.json 的 name（正是用户重命名项目的时刻）卡片标题会一直冻结到某次无关的
 * git 操作为止。代价是每仓库每轮几次 existsSync/readFileSync 加一次 readdirSync，
 * 一个进程都不 spawn——当初并进 heavy 是图结构方便，不是为了省开销。
 */
export function composeStatus(path: string, id: string, core: RepoCore, heavy: RepoHeavy): RepoStatus {
  const meta = readRepoMeta(path, heavy.remotes)
  return {
    id,
    path,
    name: basename(path),
    displayName: meta.displayName,
    description: meta.description,
    language: detectLanguage(path),
    group: "",
    tags: [],
    favorite: false,
    archived: false,
    note: null,
    lastOpened: null,
    mergedBranches: heavy.mergedBranches,
    branch: core.branch,
    dirty: core.dirty,
    ahead: core.ahead,
    behind: core.behind,
    upstream: core.upstream,
    stashCount: heavy.stashCount,
    stashOldest: heavy.stashOldest,
    release: heavy.release,
    remotes: heavy.remotes,
    lastCommit: heavy.lastCommit,
    health: [],
    githubInbox: null,
    error: null,
    scannedAt: new Date().toISOString(),
  }
}

/** 完整刷新（core + heavy）。id 可由调用方指定——身份账本认领后，仓库沿用老 id 而不是按新路径重算 */
export async function getRepoStatus(path: string, id: string = repoId(path)): Promise<RepoStatus> {
  const core = await getRepoCore(path)
  // 这条路径不落盘任何东西，降级与否只影响「要不要写缓存」，这里丢掉它即可（旧行为不变）
  const { heavy } = await getRepoHeavy(path, core)
  return composeStatus(path, id, core, heavy)
}
