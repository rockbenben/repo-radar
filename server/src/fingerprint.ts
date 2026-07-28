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
 */
const PROBES = ["HEAD", "index", "packed-refs", "FETCH_HEAD", join("refs", "stash"), join("logs", "HEAD")]

/**
 * `.git` 指纹。用于**跳过缓存**，不承担正确性兜底：漏判的后果上界是
 * tag/stash/remote/最近提交等「重」字段最多旧一轮（默认 30 分钟），
 * 而分支、工作区脏计数、ahead/behind 走的是每次都执行的 core，任何时候都是实时的。
 *
 * 返回 null = **不可缓存**，调用方必须当作永远未命中。这不是错误路径：
 * worktree / submodule 的 `.git` 是文件而非目录，六个 probe 全部 stat 失败。
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
