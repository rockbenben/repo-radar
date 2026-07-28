import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * `.git` 下用于判断「这个仓库自上轮扫描以来动过没有」的一小组**文件**路径。
 * 选它们的依据是「哪些操作会改变 heavy 那六个 git 命令的结果」：
 * - HEAD：切分支
 * - index：add / commit / checkout
 * - packed-refs：gc / pack-refs / fetch
 * - FETCH_HEAD：fetch
 * - refs/stash：stash push / pop（是文件，不在下面的目录遍历里；且它捕获的是**改写**
 *   同一个 ref，那不会动父目录的 mtime）
 * - logs/HEAD：任何 ref 更新（commit、checkout、merge、reset、fetch）都会追加
 * - config：remote add / remote set-url —— remotes 与 GitHub 关联全靠它
 *
 * 松散引用的**增删**不改这里的任何一个文件，由 refDirProbes 的目录遍历负责，见下。
 *
 * 这一组是补上一个能让看板静默显示过期数据的洞：`packed-refs` 只在 `gc` / `pack-refs` 时
 * 才动，而日常的 `git tag`、`git branch`、`git branch -d`、`git remote add/set-url` 写的
 * 全是松散引用与 `.git/config`。少了它们，这些操作之后指纹**逐字节不变** → heavy 命中缓存 →
 * 发版雷达的 release、可清理分支列表、remotes 全部冻结，而且**没有上界**：一直错到某次
 * 无关的 commit/fetch 为止。最刺眼的是「应用自己写完立刻读到旧数据」——`prune-branches`
 * 跑完 `git branch -d` 再 refreshOne，返回和广播的仍是那些已经被删掉的分支。
 *
 * 探针集合永远不可能证明完备，所以它不是唯一防线：应用自己刚写过盘的路径一律走
 * `RepoStore.refreshOne(id, { skipCache: true })`，把整类问题关掉（见 store.ts）。
 */
const PROBES = ["HEAD", "index", "packed-refs", "FETCH_HEAD", join("refs", "stash"), join("logs", "HEAD"), "config"]

/**
 * 遍历 `refs/` 时允许走过的目录数上界。触到就整体判定为不可缓存。
 *
 * 上界只数**目录**，所以它约束的是 ref 命名空间的形状而不是 ref 的数量：
 * 典型仓库 5–15 个（refs、heads、tags、remotes、remotes/origin，加上 feature/ release/ 之类的
 * 前缀），256 已经离谱地宽松。触到上界宁可返回 null 让调用方全价刷新，也不要
 * 「只遍历前 N 个」——那等于给漏判开了一个既随机又不可解释的口子。
 */
const REF_DIR_LIMIT = 256

/**
 * `.git/refs` 下**所有目录**（含 `refs` 自身）的 stat 摘要，按相对路径排序。
 * 返回 null = 目录数超出上界，调用方应当整体视为不可缓存。
 *
 * 为什么必须递归，而不是只 stat `refs/heads`、`refs/tags`、`refs/remotes` 三个顶层目录：
 * 在 `refs/heads/feature/` 里增删一个 ref，变的是 `refs/heads/feature` 的 mtime，
 * **顶层那个不动**。于是父目录已经存在时，`git branch feature/c`、`git tag rel/z`、
 * 以及同级还有兄弟 ref 存活的 `git tag -d rel/z` 全都让指纹逐字节不变——而 `feature/*`
 * 正是最主流的分支命名，这不是边角情况。后果与顶层那个洞同类且同样无上界。
 * （父目录**不存在**时反而是安全的：新建第一个 `feature/a` 要先创建 `refs/heads/feature`
 * 这个目录，顶层的 mtime 因此会动——正是这个不对称让漏洞看起来像已经被覆盖了。）
 *
 * 只数目录、不数 ref 文件：改写一个**已存在**的 ref 不动父目录 mtime，但那种情况由
 * HEAD 的 oid 与 logs/HEAD 覆盖。摘要里带上相对路径而不只是 stat 值，这样「目录本身
 * 的增删」即便撞上 mtime 相同也仍然是一个变化信号。
 *
 * 排序是必须的：readdirSync 的返回顺序不保证跨调用稳定，不排序会让指纹在内容根本没变时
 * 也抖动 —— 表现为缓存永远不命中，即这套机制整个失效，且没有任何报错。
 *
 * 符号链接天然不会造成死循环：Dirent 对软链报的是 isSymbolicLink()，isDirectory() 为假，
 * 所以不会被推进栈里。
 */
function refDirProbes(gitDir: string): string[] | null {
  const dirs: string[] = []
  const stack: string[] = [join(gitDir, "refs")]
  while (stack.length > 0) {
    const dir = stack.pop()!
    dirs.push(dir)
    if (dirs.length > REF_DIR_LIMIT) return null
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // refs 还不存在 / 无权限：这一层当没有，下面 stat 会记成 "-"
    }
    for (const e of entries) if (e.isDirectory()) stack.push(join(dir, e.name))
  }
  dirs.sort()
  return dirs.map((dir) => {
    const rel = relative(gitDir, dir)
    try {
      const s = statSync(dir)
      return `${rel}=${s.mtimeMs}:${s.size}`
    } catch {
      return `${rel}=-`
    }
  })
}

/**
 * `.git` 指纹。用于**跳过缓存**，不承担正确性兜底：漏判的后果上界是
 * tag/stash/remote/最近提交等「重」字段最多旧一轮（默认 30 分钟），
 * 而分支、工作区脏计数、ahead/behind 走的是每次都执行的 core，任何时候都是实时的。
 *
 * 返回 null = **不可缓存**，调用方必须当作永远未命中。这不是错误路径，有两个来源：
 * - worktree / submodule 的 `.git` 是文件而非目录，全部 probe 都 stat 失败；
 * - `refs/` 下的命名空间目录多到超出 REF_DIR_LIMIT。
 * 两种情况下若返回一个恒定字符串，这类仓库会永远命中缓存、heavy 永不刷新——
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
  const refDirs = refDirProbes(gitDir)
  if (refDirs === null) return null // 命名空间目录超出上界：宁可每轮全价刷新，也不要漏判
  parts.push(...refDirs)
  return parts.join("|")
}
