import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import type { CommitInfo, DirtyCounts, RemoteInfo, RepoStatus } from "./types"
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
  dirty: DirtyCounts
}

export function parseStatus(out: string): ParsedStatus {
  let branch: string | null = null
  let ahead = -1
  let behind = -1
  const dirty: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length)
      branch = head === "(detached)" ? null : head
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
  return { branch, ahead, behind, dirty }
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

// 分支排序：main/master 置顶，其余字母序
function sortBranches(list: string[]): string[] {
  const rank = (b: string) => (b === "main" || b === "master" ? 0 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

async function recentCommitsOf(path: string): Promise<CommitInfo[]> {
  return runGit(path, ["log", "-10", "--format=%H%x1f%s%x1f%an%x1f%aI"])
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
    runGit(path, ["--no-optional-locks", "branch", "--format=%(refname:short)"]).then(splitLines).catch(() => []),
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

/**
 * 丢弃全部未提交改动：reset --hard HEAD（还原已跟踪的改动/删除）+ clean -fd（删未跟踪文件/目录，
 * 但保留 .gitignore 忽略项，不加 -x 以免误删 node_modules/.env 等）。**不可恢复**。
 */
export async function discardChanges(path: string): Promise<{ ok: boolean; message: string }> {
  try {
    try {
      await runGit(path, ["reset", "--hard", "HEAD"], COMMIT_TIMEOUT_MS)
    } catch (resetErr) {
      // reset 失败：只有「整个仓库一个提交都没有」才走空仓库路径。用 rev-list --all 判定——
      // 若仓库其实有提交（rev-parse 偶发失败等），此时 read-tree --empty + clean 会把已提交文件当未跟踪删掉，
      // 是灾难性的，绝不能做：有任何不确定（rev-list 非空或本身失败）就抛出原错误、如实报失败。
      const noCommits = await runGit(path, ["rev-list", "-n", "1", "--all"]).then((r) => r.stdout.trim() === "").catch(() => false)
      if (!noCommits) throw resetErr
      // 确属空仓库：清空暂存区让已 add 的文件转未跟踪，交给下面 clean 删除（否则「丢弃」会漏掉暂存的新文件）。
      await runGit(path, ["read-tree", "--empty"], COMMIT_TIMEOUT_MS)
    }
    await runGit(path, ["clean", "-fd"], COMMIT_TIMEOUT_MS)
    return { ok: true, message: "已丢弃未提交改动" }
  } catch (err) {
    const msg = gitErrMessage(err)
    return { ok: false, message: msg }
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

// `git stash show --include-untracked` 需 git ≥ 2.32。探测一次 git 版本并缓存，避免每条 stash 都「带 flag 失败再重试」的双倍进程。
let untrackedSupported: boolean | null = null
async function includeUntrackedSupported(cwd: string): Promise<boolean> {
  if (untrackedSupported !== null) return untrackedSupported
  const v = await runGit(cwd, ["--version"]).then((r) => r.stdout).catch(() => null)
  // 探测本身失败（spawn 抖动、被杀毒锁住等）：本次保守不带 flag，但**不缓存**——否则一次抖动会永久降级，
  // 之后所有 stash show 都漏掉未跟踪内容（未跟踪-only 的 stash 会误报 files:0），直到重启。下次再探即可。
  if (v === null) return false
  const m = v.match(/(\d+)\.(\d+)/)
  // 解析出版本才缓存；解析不出（异常输出）当「不支持」并缓存：安全地少一份未跟踪统计，而不是带 flag 失败
  untrackedSupported = m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32) : false
  return untrackedSupported
}
// 按探测到的版本决定是否带 --include-untracked；不做「失败即退回」的兜底重试——那会把真错误掩盖成「diff 无未跟踪内容」。失败直接抛。
async function stashShow(path: string, extra: string[], ref: string): Promise<GitResult> {
  const args = ["--no-optional-locks", "stash", "show"]
  if (await includeUntrackedSupported(path)) args.push("--include-untracked")
  args.push(...extra, ref)
  return runGit(path, args)
}

/** 列出单个仓库的全部 stash（含改动量统计）。任一步失败都退化为空/零，绝不抛。 */
export async function listStashes(path: string): Promise<StashEntry[]> {
  const r = await runGit(path, ["--no-optional-locks", "stash", "list", `--format=%H${STASH_SEP}%gd${STASH_SEP}%cI${STASH_SEP}%gs`]).catch(() => null)
  if (r === null) return []
  const rows = splitLines(r).map((line) => {
    const [sha, ref, date, message] = line.split(STASH_SEP)
    const bm = message?.match(/^(?:WIP on|On) ([^:]+):/)
    return { sha, ref, date: date ?? "", message: message ?? "", branch: bm ? bm[1] : null }
  })
  return Promise.all(
    rows.map(async (row) => {
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
    }),
  )
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
  try {
    const r = await runGit(path, ["--no-optional-locks", "diff", "HEAD"])
    diff = r.stdout
  } catch {
    try {
      const r = await runGit(path, ["--no-optional-locks", "diff"])
      diff = r.stdout
    } catch {
      diff = ""
    }
  }
  if (diff.length > DIFF_MAX_CHARS) {
    diff = diff.slice(0, DIFF_MAX_CHARS) + "\n… (diff 已截断)"
  }
  const untracked = await runGit(path, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard"])
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

export async function getRepoStatus(path: string): Promise<RepoStatus> {
  // status 失败（非 git 目录、git 缺失）直接抛出，由调用方决定如何降级
  // --no-optional-locks：读状态时不刷新/写 .git/index，避免触发文件监听的自反馈
  const status = await runGit(path, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"])
  const parsed = parseStatus(status.stdout)
  const [stashInfo, release, remotes, lastCommit, mergedRaw] = await Promise.all([
    // stash 条数 + 最老一条的时间（list 新→旧，最老在末行）——「搁了多久」提醒用
    runGit(path, ["stash", "list", "--format=%cI"])
      .then((r) => {
        const lines = splitLines(r)
        return { count: lines.length, oldest: lines.length > 0 ? lines[lines.length - 1] : null }
      })
      .catch(() => ({ count: 0, oldest: null as string | null })),
    // 发版雷达：按「创建时间」取全库最新 tag（annotated 记打 tag 的时间、lightweight 记提交时间）。
    // 不用 describe——它只找 HEAD 可达的最近 tag，会漏掉未合并分支上刚发的版、日期也会错拿提交时间。
    // 计数用 HEAD --not --tags（HEAD 上不被任何 tag 覆盖的提交）：即便最新 tag 不是 HEAD 的祖先
    // （比如在老维护分支上补发 v1.0.1），也不会把 merge-base 以来的所有提交都算成「未发版」。
    // 没打过 tag → null（没发版习惯的仓库不提醒）。
    (async () => {
      try {
        const r = await runGit(path, ["for-each-ref", "refs/tags", "--sort=-creatordate", "--count=1", "--format=%(refname:short)%00%(creatordate:iso-strict)"])
        const [tag, tagDate] = r.stdout.trim().split("\0")
        if (!tag) return null
        const aheadR = await runGit(path, ["rev-list", "--count", "HEAD", "--not", "--tags"])
        return { tag, ahead: Number(aheadR.stdout.trim()) || 0, tagDate: tagDate ?? "" }
      } catch {
        return null
      }
    })(),
    runGit(path, ["remote", "-v"])
      .then((r) => parseRemotes(r.stdout))
      .catch(() => []),
    runGit(path, ["log", "-1", "--format=%H%x00%s%x00%an%x00%aI"])
      .then((r) => parseLastCommit(r.stdout))
      .catch(() => null), // 空仓库无 HEAD 时 git log 非零退出
    // --format 必须在 --merged 之前：否则 git 会把 --format=… 当成 --merged 的 commit 参数而报错
    runGit(path, ["branch", "--format=%(refname:short)", "--merged"])
      .then((r) => r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
      .catch(() => []), // 已合并进 HEAD 的本地分支（含当前分支/主干，下面再排除）
  ])
  // 可安全清理的已合并分支：排除当前分支与主干（main/master）
  const mergedBranches = mergedRaw.filter((b) => b !== parsed.branch && b !== "main" && b !== "master")
  const meta = readRepoMeta(path, remotes)
  return {
    id: repoId(path),
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
    mergedBranches,
    branch: parsed.branch,
    dirty: parsed.dirty,
    ahead: parsed.ahead,
    behind: parsed.behind,
    stashCount: stashInfo.count,
    stashOldest: stashInfo.oldest,
    release,
    remotes,
    lastCommit,
    health: [],
    githubInbox: null,
    error: null,
    scannedAt: new Date().toISOString(),
  }
}
