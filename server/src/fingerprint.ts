import { statSync } from "node:fs"
import { join } from "node:path"

/**
 * `.git` 下用于判断「这个仓库自上轮扫描以来动过没有」的一小组路径。
 * 选它们的依据是「哪些操作会改变 heavy 那六个 git 命令的结果」：
 * - HEAD：切分支
 * - index：add / commit / checkout
 * - packed-refs：gc / pack-refs / fetch
 * - FETCH_HEAD：fetch
 * - refs/stash：stash push / pop
 * - logs/HEAD：任何 ref 更新（commit、checkout、merge、reset、fetch）都会追加
 * - config：remote add / remote set-url —— remotes 与 GitHub 关联全靠它
 * - refs/heads、refs/tags、refs/remotes（**三个目录**）：松散引用的增删只改所在目录的
 *   mtime，不碰上面任何一个文件
 *
 * 后四条是补上一个能让看板静默显示过期数据的洞：`packed-refs` 只在 `gc` / `pack-refs` 时
 * 才动，而日常的 `git tag`、`git branch`、`git branch -d`、`git remote add/set-url` 写的
 * 全是松散引用与 `.git/config`。少了它们，这些操作之后指纹**逐字节不变** → heavy 命中缓存 →
 * 发版雷达的 release、可清理分支列表、remotes 全部冻结，而且**没有上界**：一直错到某次
 * 无关的 commit/fetch 为止。最刺眼的是「应用自己写完立刻读到旧数据」——`prune-branches`
 * 跑完 `git branch -d` 再 refreshOne，返回和广播的仍是那些已经被删掉的分支。
 * 代价是每仓库每轮多 4 次 statSync（各约 5µs），对比省下的一次 spawn（约 6ms）可忽略。
 *
 * 探针集合永远不可能证明完备，所以它不是唯一防线：应用自己刚写过盘的路径一律走
 * `RepoStore.refreshOne(id, { skipCache: true })`，把整类问题关掉（见 store.ts）。
 */
const PROBES = [
  "HEAD",
  "index",
  "packed-refs",
  "FETCH_HEAD",
  join("refs", "stash"),
  join("logs", "HEAD"),
  "config",
  join("refs", "heads"),
  join("refs", "tags"),
  join("refs", "remotes"),
]

/**
 * `.git` 指纹。用于**跳过缓存**，不承担正确性兜底：漏判的后果上界是
 * tag/stash/remote/最近提交等「重」字段最多旧一轮（默认 30 分钟），
 * 而分支、工作区脏计数、ahead/behind 走的是每次都执行的 core，任何时候都是实时的。
 *
 * 返回 null = **不可缓存**，调用方必须当作永远未命中。这不是错误路径：
 * worktree / submodule 的 `.git` 是文件而非目录，全部 probe 都 stat 失败。
 * 若此时返回一个恒定字符串，这类仓库会永远命中缓存、heavy 永不刷新——
 * 那是个只在少数用户身上出现、且完全没有报错的静默失效。
 */
export function gitFingerprint(repoPath: string, oid: string | null): string | null {
  const gitDir = join(repoPath, ".git")
  try {
    if (!statSync(gitDir).isDirectory()) return null
  } catch {
    return null // 仓库不存在 / 无权限：交给完整路径去报真正的错
  }
  const parts = [oid ?? "-"]
  for (const rel of PROBES) {
    try {
      const s = statSync(join(gitDir, rel))
      parts.push(`${s.mtimeMs}:${s.size}`)
    } catch {
      parts.push("-") // 不存在是常态（FETCH_HEAD / refs/stash），从无到有本身就是变化信号
    }
  }
  return parts.join("|")
}
