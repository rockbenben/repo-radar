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

// GitHub 待办汇总：跨仓库「等我的」——后台限流用 gh 拉取并缓存
export interface GithubInbox {
  prs: number // 开放 PR 数
  issues: number // 开放 issue 数
  ciFailed: boolean // 最近一次工作流运行失败
  ciSha?: string | null // 远程默认分支 HEAD oid（CI「已处理」按它记；旧缓存无此字段）
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
  mergedBranches: string[] // 已合并进 HEAD、可安全清理的本地分支（不含当前分支与 main/master）
  branch: string | null // null = detached HEAD
  dirty: DirtyCounts
  ahead: number // -1 = 无 upstream
  behind: number // -1 = 无 upstream
  stashCount: number
  stashOldest: string | null // 最老一条 stash 的提交时间（ISO）；null = 无 stash。用于「搁了多久」提醒
  // 发版雷达：最新 tag 之后主干堆了多少提交。null = 从未打过 tag（没有发版习惯的仓库不提醒）
  release: { tag: string; ahead: number; tagDate: string } | null
  remotes: RemoteInfo[]
  lastCommit: CommitInfo | null
  health: HealthIssue[]
  githubInbox: GithubInbox | null // 跨仓库「等我的」：PR/issue/CI（后台补全，无 GitHub 远程或未拉到为 null）
  error: string | null // git 命令失败时的摘要，正常为 null
  scannedAt: string // ISO 8601
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

export interface HeatmapDay {
  date: string // YYYY-MM-DD
  count: number
}

export interface ActivityItem {
  id: string
  name: string
  displayName: string | null
  lastCommitDate: string | null // ISO；null = 空仓库
}
