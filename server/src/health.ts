import type { Config } from "./config"
import type { HealthIssue, RepoStatus } from "./types"

type Rule = (repo: RepoStatus, config: Config) => HealthIssue | null

const RULES: Record<string, Rule> = {
  conflicted: (r) =>
    r.dirty.conflicted > 0
      ? { rule: "conflicted", severity: "error", message: `${r.dirty.conflicted} 个文件处于冲突状态` }
      : null,
  "no-remote": (r) =>
    r.remotes.length === 0 ? { rule: "no-remote", severity: "error", message: "没有远程仓库，仅存在于本机" } : null,
  "detached-head": (r) =>
    r.branch === null ? { rule: "detached-head", severity: "error", message: "处于游离 HEAD 状态" } : null,
  dirty: (r) => {
    const n = r.dirty.staged + r.dirty.unstaged + r.dirty.untracked
    return n > 0 ? { rule: "dirty", severity: "warn", message: `${n} 处未提交改动` } : null
  },
  unpushed: (r) => (r.ahead > 0 ? { rule: "unpushed", severity: "warn", message: `${r.ahead} 个提交未推送` } : null),
  // upstream 非 null 时不报：那是「配了上游、但远程分支已被删」（PR 合并后自动删分支 + fetch --prune
  // 的日常结果），git 给不出 branch.ab 所以 ahead 同样是 -1。说它「未跟踪上游」与事实相反，
  // 还会把用户推向 `git push -u`——那会把刚合并删掉的远程分支重新推回去
  "no-upstream": (r) =>
    r.remotes.length > 0 && r.branch !== null && r.ahead === -1 && r.upstream === null
      ? { rule: "no-upstream", severity: "warn", message: "当前分支未跟踪上游" }
      : null,
  behind: (r) => (r.behind > 0 ? { rule: "behind", severity: "info", message: `落后远程 ${r.behind} 个提交` } : null),
  "stash-left": (r) =>
    r.stashCount > 0 ? { rule: "stash-left", severity: "info", message: `有 ${r.stashCount} 条 stash 未处理` } : null,
  stale: (r, cfg) => {
    if (!r.lastCommit) return null
    const days = (Date.now() - new Date(r.lastCommit.date).getTime()) / 86400_000
    return days > cfg.health.staleDays
      ? { rule: "stale", severity: "info", message: `已 ${Math.floor(days)} 天没有提交` }
      : null
  },
}

export function checkHealth(repo: RepoStatus, config: Config): HealthIssue[] {
  if (repo.error) return [] // error 状态单独展示，不叠加体检
  const disabled = new Set(config.health.disabledRules)
  const issues: HealthIssue[] = []
  for (const [id, rule] of Object.entries(RULES)) {
    if (disabled.has(id)) continue
    const issue = rule(repo, config)
    if (issue) issues.push(issue)
  }
  return issues
}
