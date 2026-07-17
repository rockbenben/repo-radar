import { runGit, splitLines } from "./git"
import { mapLimit } from "./store"

export interface WorklogCommit {
  repoId: string
  repoName: string
  hash: string // 短 hash（7 位）
  date: string // committer ISO 8601（含时区偏移），仅用于按绝对时刻排序
  day: string // 本地日期 YYYY-MM-DD（Node 从 %cI 按本机本地时区算，分组与范围过滤同一时区）
  time: string // 本地 HH:mm
  subject: string
  author: string // 作者名 %an
  authorEmail: string // 作者邮箱 %ae（前端按邮箱筛选「提交人」，比名字稳）
}

export interface WorklogResult {
  commits: WorklogCommit[]
  failed: string[] // 读取失败的仓库名（结果可能不全，前端据此提示）
}

/**
 * 各仓库的「有效 user.email」并集（仓库本地覆盖优先于全局，git config 自动就近取）。
 * 「只看我」按整组邮箱匹配——只用全局邮箱的话，本地覆盖了 user.email 的仓库（如工作机 work@corp）
 * 里你的提交会被默认筛选静默漏掉。git config 不走对象库，70 仓库并发读也只要零点几秒。
 */
export async function collectUserEmails(paths: string[]): Promise<string[]> {
  const emails = await mapLimit(paths, 8, (p) => runGit(p, ["config", "user.email"]).then((r) => r.stdout.trim()).catch(() => ""))
  return [...new Set(emails.filter((e) => e !== ""))]
}

const SEP = "\x1f"
const WORKLOG_TIMEOUT_MS = 120_000 // 全量遍历各分支历史可能较久（大仓库），给足超时，避免默认 30s 误判成读取失败
// 单仓库提交数上限：扫描根下混进一个百万提交的第三方大库（linux/chromium 克隆）时，
// 无上限的 git log 会产出上百 MB stdout、物化上百万对象，8 并发直接把整个服务打挂。
// 5 万足够覆盖任何人写的时间段查询；命中上限且窗口可能没扫全时记 partial（下方判定），不静默少报。
const WORKLOG_MAX_COMMITS = 50_000
const p2 = (n: number) => String(n).padStart(2, "0")

/**
 * 汇总一组仓库在 [since, until] 天范围内的提交（含全部本地分支、排除 merge），新→旧。
 * since/until 为 YYYY-MM-DD，按机器本地时区取两端整天闭区间。day/time 用 Node 从 %cI 按本机本地时区算
 * （不依赖 git 的 --date=format-local，老版本 git 也稳）。某仓库 git log 失败则计入 failed，绝不静默吞掉。
 *
 * 范围过滤放到 Node 里按 day 做（不用 git 的 --since/--until）：git 的 --since 遇到比截止点更旧的提交就停止
 * 沿该父链回溯，若历史里存在非单调的 committer 时间（rebase/cherry-pick/graft 把旧时间戳放到了上面），
 * 夹在区间内、却位于那条更旧提交之后的提交会被漏掉。全量遍历各分支再按日期筛，才不会静默少报。
 */
export async function getWorklog(
  repos: { id: string; name: string; displayName: string | null; path: string }[],
  since: string,
  until: string,
): Promise<WorklogResult> {
  const failed: string[] = []
  const per = await mapLimit(repos, 8, async (r) => {
    try {
      // --branches HEAD：连游离 HEAD 上的提交一起算（只给 --branches 会漏掉 detached 状态下做的提交，且不报 partial）。
      // HEAD 未出生（orphan 分支刚 checkout、init+fetch 未检出）时带 HEAD 会 exit 128——退回只查 --branches，别把好仓库误报成读取失败。
      // %s 放最后一列：subject 里若混进字面 \x1f 不会把 author/email 串位，多出的段在解析时并回 subject
      const args = (revs: string[]) => [
        "--no-optional-locks",
        "log",
        ...revs,
        "--no-merges",
        `--max-count=${WORKLOG_MAX_COMMITS}`,
        `--format=%h${SEP}%cI${SEP}%an${SEP}%ae${SEP}%s`,
      ]
      const res = await runGit(r.path, args(["--branches", "HEAD"]), WORKLOG_TIMEOUT_MS).catch(() => runGit(r.path, args(["--branches"]), WORKLOG_TIMEOUT_MS))
      const lines = splitLines(res)
      // 命中上限且截断处（最老一条）仍不早于 since：更深处可能还有窗口内的提交没扫到 → 计入 failed，
      // 前端会亮「结果可能不全」；截断处已早于窗口则说明窗口内已扫全，无需提示
      if (lines.length >= WORKLOG_MAX_COMMITS && (lines[lines.length - 1]?.split(SEP)[1] ?? "").slice(0, 10) >= since) {
        failed.push(r.displayName ?? r.name)
      }
      return lines
        .map((line) => {
          const [hash, date, author, authorEmail, ...rest] = line.split(SEP)
          const subject = rest.join(SEP)
          const d = new Date(date)
          const ok = !Number.isNaN(d.getTime())
          return {
            repoId: r.id,
            repoName: r.displayName ?? r.name,
            hash,
            date,
            day: ok ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : (date ?? "").slice(0, 10),
            time: ok ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : "",
            subject: subject ?? "",
            author: author ?? "",
            authorEmail: authorEmail ?? "",
          }
        })
        .filter((c) => c.day >= since && c.day <= until) // 天为单位的闭区间
    } catch {
      // 区分「空仓库（一个提交都没有）」与「真读取失败」：前者不算失败，后者才计入 failed。
      // 用 rev-list --all 判定——空仓库 git log --branches 会非零退出但并非错误；rev-list 本身失败则保守当作有提交（记失败）。
      const hasAny = await runGit(r.path, ["--no-optional-locks", "rev-list", "-n", "1", "--all"]).then((x) => x.stdout.trim() !== "").catch(() => true)
      if (hasAny) failed.push(r.displayName ?? r.name)
      return []
    }
  })
  // 按绝对时刻排序（新→旧）：%cI 带各自时区偏移，字符串比较会按墙钟文本排错序，须解析成时间戳
  const commits = per.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return { commits, failed }
}
