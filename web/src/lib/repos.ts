import type { RepoStatus } from "../types"

/**
 * 从仓库路径切出父目录，供「+ 新建项目 / 克隆」预填。
 *
 * 卷根是唯一不能把分隔符一起切掉的情况：`D:\015-foo` 切成 `D:` 是盘符相对路径、`/015-foo`
 * 切成空串，服务端的 isAbsolute 两种都判假，回一句与事实相反的「父目录不存在」。而这个值是
 * 应用自己算出来的，用户点一下「创建」就撞上，唯一的出路是猜到要手打 `D:\`。
 */
export function parentOf(path: string, name: string): string {
  const withSep = path.slice(0, path.length - name.length) // 连分隔符一起留着
  return /^([a-zA-Z]:)?[\\/]$/.test(withSep) ? withSep : withSep.slice(0, -1)
}

export function mergeRepo(repos: RepoStatus[], repo: RepoStatus): RepoStatus[] {
  const index = repos.findIndex((r) => r.id === repo.id)
  if (index === -1) return [...repos, repo]
  const next = [...repos]
  next[index] = repo
  return next
}
