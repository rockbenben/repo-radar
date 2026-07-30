// 与 server/src/types.ts 保持手动同步；两边同改
export interface RemoteInfo {
  name: string
  url: string
}

export interface CommitInfo {
  hash: string
  message: string
  author: string
  date: string // ISO 8601
}

export interface DirtyCounts {
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export interface HealthIssue {
  rule: string
  severity: "error" | "warn" | "info"
  message: string
}

export interface RepoStatus {
  id: string
  path: string
  name: string
  displayName: string | null // package.json name → origin URL 末段 → null（前端回退 name）
  description: string | null // GitHub 描述（有远程且已补全时优先）→ package.json description → README 首段 → null
  language: string | null // 从标志文件识别的主要语言/技术栈，如 TypeScript / Rust / Python；null = 未识别
  group: string
  tags: string[]
  favorite: boolean
  archived: boolean // 归档：默认从主看板收起
  note: string | null // 项目便签 / 待办，null = 无
  lastOpened: string | null // 上次通过编辑器/终端/目录打开的 ISO 时间；null = 从未
  mergedBranches: string[] // 已合并、可安全清理的本地分支
  branch: string | null // null = detached HEAD
  dirty: DirtyCounts
  ahead: number // -1 = 无 upstream，或配了上游但远程分支已被删（此时 upstream 非 null）
  behind: number // -1 = 同上
  upstream: string | null // 配置的上游分支名；null = 真的没配上游
  stashCount: number
  stashOldest: string | null // 最老一条 stash 的提交时间（ISO）；null = 无 stash
  release: { tag: string; ahead: number; tagDate: string } | null // 最新 tag 之后堆的提交；null = 从未打 tag
  remotes: RemoteInfo[]
  lastCommit: CommitInfo | null
  health: HealthIssue[]
  githubInbox: GithubInbox | null // 跨仓库「等我的」：PR/issue/CI（后台补全，无 GitHub 远程或未拉到为 null）
  error: string | null
  scannedAt: string // ISO 8601
}

export interface GithubInbox {
  prs: number // 开放 PR 数
  issues: number // 开放 issue 数
  ciFailed: boolean // 最近一次工作流失败
  ciSha?: string | null // 远程默认分支 HEAD oid（CI「已处理」按它记；旧缓存无此字段）
  // 服务端逐轮累加的「新到达」数（只增不减，旧缓存无此字段）。队列的「已处理」判定拿它当基线：
  // 面板关着的那些轮次没有渲染进程去看计数的下探，光比水位会把「合光了又来新的」判成已处理
  prsAdded?: number
  issuesAdded?: number
}

export interface StashEntry {
  ref: string // 当前的 stash@{n}
  sha: string // stash 提交 id，仓库内唯一（git 合并字节相同的 stash）；操作/选择一律按它定位
  branch: string | null
  message: string
  date: string // ISO 8601
  files: number
  insertions: number
  deletions: number
}

export interface RepoStashes {
  id: string
  name: string
  displayName: string | null
  path: string
  stashes: StashEntry[]
}

export interface BatchResultItem {
  repoId: string
  name: string
  ok: boolean
  message: string
  output?: string // 批量执行命令时的输出尾部（fetch/pull/push 不含）
  code?: number | null // 命令退出码
}

export interface BatchProgress {
  taskId: string
  action: string
  done: number
  total: number
  current: string | null // 正在处理的仓库名
  results: BatchResultItem[]
  finished: boolean
}

export interface GithubStatus {
  ok: boolean
  error: string | null
  prs: { number: number; title: string; url: string; isDraft: boolean }[]
  prsTruncated: boolean // prs 被服务端上限截断：计数要显示成「N+」，否则与「恰好 N 个」无从区分
  run: { status: string; conclusion: string | null; workflowName: string; headBranch: string } | null
}

export interface HeatmapDay {
  date: string // YYYY-MM-DD
  count: number
}

export interface WorklogCommit {
  repoId: string
  repoName: string
  hash: string
  date: string // committer ISO 8601（含时区偏移），已在服务端按绝对时刻排好序
  day: string // 本地日期 YYYY-MM-DD（服务端本地时区，分组用）
  time: string // 本地 HH:mm
  subject: string
  author: string // 作者名 %an
  authorEmail: string // 作者邮箱 %ae（按提交人筛选用）
}

export interface ActivityItem {
  id: string
  name: string
  displayName: string | null
  lastCommitDate: string | null // ISO；null = 空仓库
}
