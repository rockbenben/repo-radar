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
  // prs/issues 的计数口径：true = 已减去当前登录用户自己开的；旧缓存无此字段（undefined）视同「不确定」。
  // desktop/src/notify.ts 用它判断前后两轮的计数是否可比——口径切换时直接做差会全线虚高，必须能识别出来
  byViewer?: boolean
  // 累计「新到达」数：每轮 max(0, 本轮 - 上轮) 累加，只增不减。**不是 GitHub 返回的字段**，
  // 由 InboxCache.getWithArrivals 附加（缓存条目上记账，见 inbox-cache.ts）。
  //
  // 存在的理由：前端队列的「已处理」水位存在浏览器 localStorage 里，而把水位往下调只发生在
  // 渲染进程活着、且恰好观察到那次下探的时候（web/src/App.tsx 的清理 effect）。托盘常驻
  // （--tray / 开机自启）恰恰是「没有渲染进程」的形态：4 个 PR 全被合掉（差值 ≤ 0，不弹通知，
  // 也没有任何人下调水位）、随后来了 2 个新的 → 系统通知「PR +2」照弹，用户点进来，前端却按
  // 2 ≤ 4 判定为已处理，「该你了」里根本没有这条，而且清理 effect 紧接着把水位降到 2，
  // 2 ≤ 2 依然成立——再也不会出现。计数在服务端累加之后，通知与队列读的是同一条数据链。
  prsAdded?: number
  issuesAdded?: number
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
  ahead: number // -1 = 无 upstream，或配了上游但远程分支已被删（此时 upstream 非 null）
  behind: number // -1 = 同上
  upstream: string | null // 配置的上游分支名；null = 真的没配上游
  stashCount: number
  stashOldest: string | null // 最老一条 stash 的提交时间（ISO）；null = 无 stash。用于「搁了多久」提醒
  // 发版雷达：最新 tag 之后主干堆了多少提交。null = 从未打过 tag（没有发版习惯的仓库不提醒）
  release: { tag: string; ahead: number; tagDate: string } | null
  remotes: RemoteInfo[]
  lastCommit: CommitInfo | null
  // 最后一次提交的**提交者**时间（%cI）；lastCommit.date 是作者时间（%aI）。
  // stale 体检规则与 lastActivity 都按它算——rebase / cherry-pick / amend 保留作者时间，
  // 只有 %cI 反映「提交是什么时候落下的」。null = 没有提交，或读不到
  committedAt: string | null
  // 「最近一次动过这个仓库」的 ISO 时间：工作区未提交改动的最新 mtime 与最后提交时间取晚者。
  // null = 空仓库且工作区干净。排序/统计的「最近活跃」按它，**不按 lastCommit**——改了一天
  // 没提交的仓库按提交时间会沉到「三个月前提交过」的那批下面，而它恰恰是最该浮上来的。
  // 被 .gitignore 忽略的文件不算数（git status 本来就不报），构建产物不会伪造活跃。
  lastActivity: string | null
  health: HealthIssue[]
  githubInbox: GithubInbox | null // 跨仓库「等我的」：PR/issue/CI（后台补全，无 GitHub 远程或未拉到为 null）
  error: string | null // git 命令失败时的摘要，正常为 null
  scannedAt: string // ISO 8601
  // 疑似旧身份（搬移提示，见 repo-identity.ts 的 suspect）：这条卡片是新铸的 id，但账本里
  // 恰有一条已失联、origin URL 相同的老条目——标签可能还挂在那边。null/undefined = 没有线索。
  // 提示不是结论：只有用户在卡片上确认后才会发生身份迁移（rebind）
  suspect?: { oldId: string; oldPath: string } | null
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
  lastActivityDate: string | null // ISO；排序与列表上显示的相对时间都按它。见 RepoStatus.lastActivity
  // 仍然保留：统计面板的「空仓库」计数问的是「有没有提交过」，那是提交口径的问题，
  // 不能被「工作区有未跟踪文件」顶掉——否则 git init 完写了两个文件的目录不再算空仓库
  lastCommitDate: string | null // ISO；null = 空仓库
}
