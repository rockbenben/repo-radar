import { spawn } from "node:child_process"
import type { GithubInbox } from "./types"

const GH_TIMEOUT_MS = 15_000

interface GhResult {
  code: number | null
  stdout: string
  stderr: string
}

function runGh(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, windowsHide: true })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS)
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface GithubPr {
  number: number
  title: string
  url: string
  isDraft: boolean
}

export interface GithubRun {
  status: string // queued | in_progress | completed
  conclusion: string | null // success | failure | cancelled | ...（未完成时 null）
  workflowName: string
  headBranch: string
}

export interface GithubStatus {
  ok: boolean
  error: string | null // gh 未安装 / 未登录 / 无 GitHub 远程 等
  prs: GithubPr[]
  run: GithubRun | null // 最近一次工作流运行
}

/** 本机是否装了 gh（后台补全前的探测）。装了就不会中途消失——正结果缓存，免得每轮轮询都白 spawn 一次；失败不缓存（可能刚在装）。 */
let ghOk: true | undefined
export async function ghAvailable(): Promise<boolean> {
  if (ghOk) return true
  const v = await runGh(process.cwd(), ["--version"])
  if (v.code === 0) ghOk = true
  return v.code === 0
}

/**
 * 从远程 URL 解析出 owner/repo（https / ssh / scp 形式）；解析不出返回 null。
 * 主机名必须恰为 github.com——不做子串匹配，corp-github.com / xgithub.com 不是 GitHub，
 * 否则会拿别人家 me/proj 的 PR/issue/CI 数据糊到无关仓库上。
 */
export function githubSlug(url: string): string | null {
  // userinfo 用 [^@/\s]+ ——须放行 user:token@（CI/token 克隆的标准形式），不能只允许 \w.-
  const m = url.trim().match(/^(?:(?:https?|git|ssh):\/\/)?(?:[^@/\s]+@)?([\w.-]+)[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/i)
  if (!m) return null
  const host = m[1].toLowerCase()
  if (host !== "github.com" && host !== "www.github.com") return null
  return `${m[2]}/${m[3]}`
}

/**
 * 多远程时挑「那一个」GitHub 远程：优先名为 origin 的，否则第一个——
 * 与前端跳转（remoteWeb 同样 origin 优先）保持同序，保证「计数来自哪个仓库，点开就是哪个仓库」。
 */
export function githubRemoteUrl(remotes: { name: string; url: string }[]): string | undefined {
  const gh = remotes.filter((r) => githubSlug(r.url) !== null)
  return (gh.find((r) => r.name === "origin") ?? gh[0])?.url
}

/**
 * 取指定 GitHub 仓库（owner/repo）的描述。显式传仓库、不依赖 cwd 的默认远程，
 * 避免多远程时 gh 选错仓库、与缓存键不一致。
 * 区分两种「拿不到」：查询失败（未登录/网络/限流）返回 null——调用方**不要缓存**，下次重试；
 * 查询成功但确认无描述返回 { description: null }——可以放心缓存 7 天。
 * 混为一谈的话，一次未登录启动会把全部仓库落盘成「无描述」，登录后 7 天内都不重拉。
 */
export async function getGithubDescription(slug: string): Promise<{ description: string | null } | null> {
  const res = await runGh(process.cwd(), ["repo", "view", slug, "--json", "description"])
  if (res.code !== 0) return null
  try {
    const obj = JSON.parse(res.stdout || "{}") as { description?: unknown }
    const d = typeof obj.description === "string" ? obj.description.trim() : ""
    return { description: d === "" ? null : d }
  } catch {
    return null
  }
}

const INBOX_FIELDS =
  "pullRequests(states:OPEN){totalCount} issues(states:OPEN){totalCount} defaultBranchRef{target{... on Commit{oid statusCheckRollup{state}}}}"
const INBOX_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${INBOX_FIELDS}}}`
// 已知当前登录用户时：issue 减掉我自己开的（filterBy）；PR 没有 createdBy 过滤，用 search 直接数「别人开的 open PR」。
// 「等我的」应是别人提的——自己开的 issue 是备忘、自己开的 PR 是 WIP，都不算
const INBOX_QUERY_ME =
  `query($owner:String!,$name:String!,$me:String!,$prq:String!){repository(owner:$owner,name:$name){${INBOX_FIELDS} ` +
  `mine:issues(states:OPEN,filterBy:{createdBy:$me}){totalCount}} prOthers:search(query:$prq,type:ISSUE){issueCount}}`

// 当前登录用户名：只在真拿到时才记死；失败不缓存（下次重试，避免一次抖动永久关掉自开 issue 过滤）。
// viewerInFlight 去重首轮并发（60 个仓库同时开跑时只查一次登录名）。
let viewerLogin: string | undefined
let viewerInFlight: Promise<string | null> | null = null
async function ensureViewer(): Promise<string | null> {
  if (viewerLogin !== undefined) return viewerLogin
  if (viewerInFlight) return viewerInFlight
  viewerInFlight = (async () => {
    try {
      const res = await runGh(process.cwd(), ["api", "graphql", "-f", "query={viewer{login}}"])
      if (res.code !== 0) return null // 本次失败：不缓存，下次再试
      const login = (JSON.parse(res.stdout) as { data?: { viewer?: { login?: string } } }).data?.viewer?.login
      if (typeof login === "string" && login !== "") {
        viewerLogin = login
        return login
      }
      return null // 解析不出：不缓存
    } catch {
      return null
    } finally {
      viewerInFlight = null
    }
  })()
  return viewerInFlight
}

interface RawInboxResponse {
  data?: {
    repository?: {
      pullRequests?: { totalCount?: number }
      issues?: { totalCount?: number }
      mine?: { totalCount?: number }
      defaultBranchRef?: { target?: { oid?: string; statusCheckRollup?: { state?: string } | null } | null } | null
    } | null
    prOthers?: { issueCount?: number } | null
  }
}

/**
 * 把 gh 返回的原始 stdout/退出码解析成 GithubInbox。从 getGithubInbox 里单独抽出来，
 * 是为了脱离真实 gh 子进程即可单测——限流兜底、口径标记这些分支只有这样才有办法被测试钉死。
 * 不看退出码只看数据：gh 对含 errors 的 GraphQL 响应会非零退出，但 stdout 仍带部分数据——
 * search 被二级限流时 repository 字段往往是好的，别因此把整个仓库的 PR/issue/CI 置 null（会冻住旧缓存）
 * me：本次是否已知登录用户名，决定 prs/issues 走「不含自己」还是「含自己」的口径（见 byViewer）。
 * prevPrs/prevIssues：上次缓存的 PR/issue 数——search（prOthers）与 mine 字段都可能被二级限流单独置空，
 * 缺失时各自沿用对应的上次计数，避免在「不含自己/含自己的总数」间来回震荡，或把「自己开的」误算成 0。
 */
export function parseInboxResponse(
  stdout: string,
  code: number | null,
  me: string | null,
  prevPrs?: number,
  prevIssues?: number,
): GithubInbox | null {
  try {
    const j = JSON.parse(stdout) as RawInboxResponse
    const repo = j.data?.repository
    // pullRequests/issues 字段本身缺失 = 该字段被 GraphQL 错误置空（限流/权限），不是「0 个」——
    // 返回 null 保留旧缓存，绝不把查询失败落盘成 prs:0/issues:0 的假干净（会顶掉之前正确的数据，还带新 TTL）
    if (!repo || !repo.pullRequests || !repo.issues) return null
    // gh 非零退出 = 响应带 errors。此时 defaultBranchRef 为 null 分不清「真没有默认分支」还是「该字段被错误置空」——
    // 宁可整份丢弃保留旧缓存，别把 CI 红洗成 ciFailed:false 落盘（正常响应里它为 null 是合法的空仓库情形）
    if (code !== 0 && !repo.defaultBranchRef) return null
    const state = repo.defaultBranchRef?.target?.statusCheckRollup?.state
    const totalIssues = repo.issues.totalCount ?? 0
    // 只算别人开的：PR 用 search 计数（-author:me）。search 字段失败（限流）时沿用上次值防震荡；
    // 取不到登录名（me=null）时必须用**新鲜总数**——这时每轮都会走 prevPrs 的话，
    // 旧值带着新 TTL 反复回写、自我固化，合并/新开 PR 永远反映不出来
    const prOthers = j.data?.prOthers?.issueCount
    // mine（自己开的 issue 数）与 prOthers 同样会被二级限流单独置空——之前这里缺失时直接按 0 算，
    // 等于把「自己开的 issue 数」算成 0，issues 总数虚高同样多，弹一条假的「Issue +N」，
    // 12 分钟后又跌回去且没有任何更正。用上一轮缓存的 issues 数直接顶上（它已经是「减去自己」之后
    // 的口径，可以直接复用，不必再减一次）；没有旧缓存兜底时退回未减的总数——首次查询就撞上限流属实少见，
    // 且此时上层的 before 必为 null，notify.ts 本就不会为「首次」弹通知，退回总数不会造成误报
    const mine = repo.mine?.totalCount
    return {
      prs: me ? (typeof prOthers === "number" ? prOthers : (prevPrs ?? repo.pullRequests.totalCount ?? 0)) : (repo.pullRequests.totalCount ?? 0),
      issues: !me ? totalIssues : typeof mine === "number" ? Math.max(0, totalIssues - mine) : (prevIssues ?? totalIssues),
      ciFailed: state === "FAILURE" || state === "ERROR",
      // 远程默认分支的 HEAD oid：CI 红的「已处理」按它记——别人推了新提交（oid 变）新的失败才会重现。
      // 用本地 HEAD 记的话，远端 CI 又红了而你本地没提交，永远不会再提醒
      ciSha: repo.defaultBranchRef?.target?.oid ?? null,
      // 口径标记：me 已知即代表 prs/issues 本轮都按「减去自己」口径计算（哪怕某个字段触发了上面的
      // 限流兜底，兜底用的 prevPrs/prevIssues 本身也是「减去自己」口径的旧值，口径依然成立）。
      // notify.ts 靠它判断前后两轮的计数是否可比——viewerLogin 一旦解析成功进程内不会再失效，
      // 所以危险方向是重启之后：上一次会话缓存的是「减去自己」，这次会话首个 viewer 查询失败
      // （me=null，开机自启/网络刚上时常见）而仓库查询成功，全部仓库会同时切回「含自己」口径，
      // 直接做差会全线虚高，必须能分辨出口径切换了
      byViewer: me !== null,
    }
  } catch {
    return null // stdout 不是 JSON（gh 未装/未登录的报错文本）
  }
}

/**
 * 汇总某 GitHub 仓库的「等我的」：开放 PR 数、别人开的 open issue 数、默认分支最新提交的 CI 是否失败。
 * 一次 GraphQL 拿齐（比三条 gh 子命令快约 3 倍），供后台限流轮询用。查询失败 / 仓库取不到返回 null（上层保留旧值）。
 * prevPrs/prevIssues：上次缓存的 PR/issue 数，见 parseInboxResponse 的兜底说明。
 */
export async function getGithubInbox(slug: string, prevPrs?: number, prevIssues?: number): Promise<GithubInbox | null> {
  const [owner, name] = slug.split("/")
  if (!owner || !name) return null
  const me = await ensureViewer()
  const args = me
    ? [
        "api",
        "graphql",
        "-f",
        `query=${INBOX_QUERY_ME}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `me=${me}`,
        "-f",
        `prq=repo:${slug} is:pr is:open -author:${me}`,
      ]
    : ["api", "graphql", "-f", `query=${INBOX_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`]
  const res = await runGh(process.cwd(), args)
  return parseInboxResponse(res.stdout, res.code, me, prevPrs, prevIssues)
}

/** 按需查询某仓库的开放 PR 与最近 CI 状态（需本机安装并登录 gh）。纯本地触发，无后台调用。 */
export async function getGithubStatus(cwd: string): Promise<GithubStatus> {
  const empty: GithubStatus = { ok: false, error: null, prs: [], run: null }

  if (!(await ghAvailable())) return { ...empty, error: "本机未安装 GitHub CLI（gh）" } // 复用缓存探测，别每次点开都白 spawn 一次 --version

  const prRes = await runGh(cwd, ["pr", "list", "--state", "open", "--json", "number,title,url,isDraft"])
  if (prRes.code !== 0) {
    const msg = prRes.stderr.trim().split("\n").pop() || "gh 查询失败"
    // 常见：未登录、当前目录不是 GitHub 仓库
    return { ...empty, error: /auth|logged in|login/i.test(msg) ? "gh 未登录（运行 gh auth login）" : msg }
  }

  let prs: GithubPr[] = []
  try {
    prs = JSON.parse(prRes.stdout || "[]") as GithubPr[]
  } catch {
    prs = []
  }

  const runRes = await runGh(cwd, ["run", "list", "--limit", "1", "--json", "status,conclusion,workflowName,headBranch"])
  let run: GithubRun | null = null
  if (runRes.code === 0) {
    try {
      const arr = JSON.parse(runRes.stdout || "[]") as GithubRun[]
      run = arr[0] ?? null
    } catch {
      run = null
    }
  }

  return { ok: true, error: null, prs, run }
}
