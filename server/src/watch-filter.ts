import { resolve } from "node:path"

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
 */
export function shouldIgnorePath(p: string, roots: readonly string[] = []): boolean {
  // 前缀必须停在分隔符上：裸 startsWith 会让根 `D:\repo` 认领 `D:\repo-other\...`，
  // 那个仓库的 build/ 判断就跑到别人的坐标系里去了
  const root = roots.find((r) => p === r || (p.startsWith(r) && /[\\/]/.test(p[r.length] ?? "")))
  const rest = root === undefined ? p : p.slice(root.length)
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
