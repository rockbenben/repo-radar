import { relative, resolve } from "node:path"
import { MAX_DEPTH as SCAN_MAX_DEPTH } from "./scanner"

/**
 * 监听时整段跳过的目录名。除了 node_modules，主要是各语言的构建产物目录：内容由构建工具
 * 高频重写，Windows 上这些临时文件还常带独占锁——chokidar 一去 watch 就是 EBUSY，日志被刷满
 * 跟仓库状态毫无关系的错误（实测 MSBuild 的 app\obj\*_wpftmp.csproj.nuget.g.props）。
 * 它们基本都在 .gitignore 里，变化本来就不进 git status，少监听不会漏掉任何看板上的变化。
 *
 * 代价：仓库里如果有同名的**受版本控制**的目录（比如手写的 dist/），改动不会即时触发刷新，
 * 要等兜底重扫。相比日志被噪音淹没、以及 EBUSY 可能连带拖垮整个监听实例，这个代价值得。
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  "obj",
  "bin",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
])

/**
 * 按**路径段**判断，不做子串匹配：`p.includes("node_modules")` 会让「仓库恰好放在名字含
 * node_modules 的目录下」时整个仓库被静默忽略——看板永远不刷新，且没有任何提示。
 *
 * 只看仓库根目录**以下**的段。仓库自己或它的上级目录叫 build/vendor/dist 完全合法
 * （`D:\vendor\myrepo`、`D:\projects\build`），拿绝对路径整条去匹配的话这些仓库会被整个
 * 忽略掉——同样是「静默不刷新」，比噪音严重得多。roots 为空时退化成整条路径匹配。
 *
 * root 归属与相对段都交给 `isUnderPath` / `relative` 算，不再自己写一份前缀比较：手写那份
 * 是裸字符串比较，尾分隔符（`D:\code\`）、分隔符风格（`D:/code`）、Windows 大小写只要差一点
 * 就整条匹配不上，于是**退化成拿绝对路径整条去比**——那个 root 下的所有仓库会因为路径里
 * 恰好有一段 build/vendor 被整个静默忽略，界面上它们永远停在过期状态。卷根（`D:\`、`/`）
 * 也只有 `isUnderPath` 处理对（它为「b 已以分隔符结尾」特判过），同一个边界不该有第二份实现。
 */
export function shouldIgnorePath(p: string, roots: readonly string[] = []): boolean {
  const root = roots.find((r) => isUnderPath(p, r))
  const rest = root === undefined ? p : relative(resolve(root), resolve(p))
  return rest.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))
}

/**
 * 监听期错误分级。EBUSY/EPERM（文件被独占锁着）、ENOENT（readdir 到 watch 之间文件没了）
 * 出现在**监听目标底下的某个文件**上时是本地开发的日常噪音，对仓库状态零信息量。
 *
 * 但同样这三个码出现在**监听目标本身**上时是完全另一回事：网络共享上的仓库、被杀软锁住的
 * 目录、被删掉或改名的仓库，chokidar 报的就是这几个码，而后果是那个仓库**从此不再刷新**——
 * 界面上它会永远停在一个过期状态，其它仓库照常更新。打包后日志是唯一的诊断面，这种情况
 * 必须留下痕迹，否则用户和维护者都无从判断。
 *
 * 因此按「出事的路径是不是监听目标本身」分级；路径不明时一律报出来（宁可多一条日志，
 * 也不要把一个说不清影响面的错误咽掉）。其余错误码（EMFILE 句柄耗尽、ENOSPC inotify 上限）
 * 永远是真问题。
 */
export function watcherErrorIsNoise(err: NodeJS.ErrnoException, targets: readonly string[] = []): boolean {
  if (err.code !== "EBUSY" && err.code !== "EPERM" && err.code !== "ENOENT") return false
  const failed = err.path
  if (typeof failed !== "string") return false
  return !targets.some((t) => samePath(t, failed))
}

/** Windows 路径大小写不敏感，且同一目录可能以不同大小写回报；比较前统一 */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 「这条错误意味着监听目标本身失守了」——调用方据此触发一轮重扫补票并重建监听。
 *
 * 与 watcherErrorIsNoise 是两件事：那个决定**要不要记日志**（只有 EBUSY/EPERM/ENOENT 才有
 * 可能是噪音），这个决定**要不要补救**，而且刻意**不看错误码**。`fs.watch` 在 emit error
 * 之前就把句柄关了，所以 EMFILE、EIO、FSEvents 失败之后那棵树同样是死的，只是码不同。
 * 按码白名单分流的话，Windows 上一次重负载构建引发的瞬时 EMFILE，加上「用户关掉了周期
 * 兜底重扫」（autoScanMinutes = 0 是合法配置），就等于这个 root 下的所有仓库在进程余下的
 * 生命周期里全部冻结：界面上它们永远停在过期状态，其它 root 照常更新，用户无从判断。
 *
 * 路径不明时算失守：补救是幂等的（调用方还有防抖），宁可多重建一次，
 * 也不要把一棵已经死掉的树当噪音咽下去。
 */
export function watchTargetLost(err: NodeJS.ErrnoException, targets: readonly string[]): boolean {
  const failed = err.path
  if (typeof failed !== "string") return true
  return targets.some((t) => samePath(t, failed))
}

/**
 * 「p 就是 root 或落在 root 之下」。递归监听下这条判断在两个地方决定正确性：策略要靠它
 * 判断某个 manualRepo 是否已被某个 root 覆盖，coverage 要靠它数出真正被监听的仓库。
 *
 * 前缀必须停在分隔符上：裸 startsWith 会让 `D:\repo` 认领 `D:\repo-other`——前者的事件
 * 被记到后者头上（刷新的是错误的仓库），coverage 也会虚高，界面就在说「这个仓库有人看着」
 * 而实际没有。Windows 上还要大小写不敏感：同一目录以不同大小写回报是常态。
 */
export function isUnderPath(p: string, root: string): boolean {
  const a = foldCase(resolve(p))
  const b = foldCase(resolve(root))
  if (!a.startsWith(b)) return false
  const rest = a.slice(b.length)
  // b 已经以分隔符结尾（盘符根 `D:\`、posix 根 `/`）时不能再要求下一个字符是分隔符，
  // 否则把整个盘当扫描根的用户会一个仓库都匹配不上
  return rest === "" || /^[\\/]/.test(rest) || /[\\/]$/.test(b)
}

function foldCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p
}

/**
 * 一条**不属于任何已知仓库**的事件路径，值不值得当成「目录结构变化」上报。
 *
 * win/mac 的递归监听看得见 scan root 下的一切，而 root 下并不只有仓库：草稿/笔记/下载目录、
 * 不是 git 仓库的项目、以及被用户放进 excludes 的仓库（它不进 scan()，所以永远不在归属表里）
 * 都会源源不断地产生未归属事件。每一条都上报的话，结构重扫的信号源就是一个持续的水龙头，
 * 而结构重扫走的是 force=true（拆了重建全部监听句柄）的贵路径。
 *
 * 判据是「这条路径**有没有可能**是一次仓库集合的变化」：
 * - 末段是 `.git`：新仓库出现的确定信号，任何深度都要报（scanner 只找到 MAX_DEPTH 层，
 *   但 `.git` 在仓库目录之下又多一层，按深度算会被自己排除掉）
 * - 相对 root 的深度不超过 scanner 的 MAX_DEPTH：仓库只可能出现在这个范围内，因此
 *   「仓库目录本身被创建/改名/删除」这类事件必然落在这里
 * 更深的写入只可能是某个目录**内部**的内容变化，扫描结果不会因它而不同。
 *
 * 说不清在哪棵树下（roots 为空、或落在 manualRepos 那种 root 之外的监听目标下）时一律上报：
 * 少报一次的代价是「新仓库要等 30 分钟兜底重扫才出现」，而那个开关用户是可以关掉的。
 */
export function isStructuralPath(p: string, roots: readonly string[] = []): boolean {
  const abs = resolve(p)
  if (abs.split(/[\\/]/).pop() === ".git") return true
  const root = roots.find((r) => isUnderPath(abs, r))
  if (root === undefined) return true
  const rel = relative(resolve(root), abs)
  if (rel === "") return true
  return rel.split(/[\\/]/).length <= SCAN_MAX_DEPTH
}
