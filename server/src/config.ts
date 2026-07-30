import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface Config {
  roots: string[]
  excludes: string[]
  manualRepos: string[]
  tags: Record<string, string[]>
  favorites: string[]
  groupOverrides: Record<string, string>
  notes: Record<string, string>
  archived: string[]
  lastOpened: Record<string, string> // 仓库 id → 上次通过编辑器/终端/目录打开的 ISO 时间
  // 文件监听实时刷新：**默认关闭**，可在面板打开。
  // 关掉的理由是成本与收益不成比例：一台机器上同时有几个项目在跑构建/测试时，递归监听看得见
  // scan root 下的一切写入，内核缓冲区持续溢出（实测 74 个仓库、每 62 秒一次，永不停），每次
  // 溢出都要补一轮全量重扫；而这个工具的用途是「看一眼各仓库什么状态」，秒级实时并不值那笔
  // 常驻开销。默认路径改为：兜底定时重扫 + 手动点重扫，需要实时的人自己打开
  autoWatch: boolean
  // 兜底全量重扫间隔（分钟）；0 = 关闭。文件监听不是万无一失的：网络盘 / WSL / OneDrive 这类
  // 同步目录收不全 inotify 事件，机器休眠期间的改动也完全没有事件——低频重扫是补票口
  autoScanMinutes: number
  // 同时挂文件监听的仓库数上限；0 = 无上限。真正的约束是文件句柄和 CPU（每个仓库要注册
  // 4 个监听目标），而这在 Linux（调大 inotify.max_user_watches 后能上几千）、Windows、
  // 网络盘之间差一个数量级——没有哪个硬编码值对所有人都对，所以交给用户。
  // 名额不够时收藏优先、其次按最近提交，超出的仓库靠兜底重扫刷新
  watchLimit: number
  autoFetchMinutes: number // 定时后台 fetch 间隔（分钟）；0 = 关闭（默认）
  notifications: boolean // GitHub「等我的」新增时弹系统通知：默认关闭（打扰性功能一律 opt-in）
  health: { staleDays: number; disabledRules: string[] }
  open: { editor: string; terminal: string; explorer: string }
}

export const DEFAULT_CONFIG: Config = {
  roots: [],
  excludes: ["node_modules", ".venv", "dist", "vendor"],
  manualRepos: [],
  tags: {},
  favorites: [],
  groupOverrides: {},
  notes: {},
  archived: [],
  lastOpened: {},
  autoWatch: false,
  autoScanMinutes: 30,
  watchLimit: 200,
  autoFetchMinutes: 0,
  notifications: false,
  health: { staleDays: 90, disabledRules: [] },
  open: {
    editor: 'code "{path}"',
    terminal: 'wt -d "{path}"',
    explorer: 'explorer "{path}"',
  },
}

/** 已废弃、但老配置文件里可能还留着的字段。合并时直接剔除——留着会让「配置里写了却不生效」
 *  变成查不出原因的谜，而配置文件应当如实反映程序真正会读的东西
 *  legacyAutostartMigrated（缺陷 4）：SEA 时代自启迁移标记曾被错误地放进这份用户可见/
 *  可通过 PUT /api/config 修改的配置——已挪到 desktop/src/autostart-state.ts 管理的桌面端
 *  专属状态文件，这里只负责把老配置文件里残留的这个字段清掉，不再声明、不再校验 */
const DROPPED_FIELDS = ["openMode", "legacyAutostartMigrated"] as const

/** 定时器间隔上限（分钟）。setInterval 的延迟是 32 位有符号毫秒：超过 2^31-1 会被 Node
 *  钳成 1ms，「很少扫一次」当场变成「一刻不停地扫」。上限就取溢出线本身
 *  （floor(2^31-1 / 60000) = 35791 分钟 ≈ 24.8 天）——收得更紧（如 7 天）会把旧版本里
 *  完全合法的取值（比如两周一次的 fetch）变成 400，或把老配置静默钳到更高频率。
 *  API 校验和装表的地方共用这一个数 */
export const MAX_INTERVAL_MINUTES = Math.floor((2 ** 31 - 1) / 60_000)

export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  const merged: Record<string, unknown> = {
    ...base,
    ...patch,
    health: { ...base.health, ...(patch.health ?? {}) },
    open: { ...base.open, ...(patch.open ?? {}) },
  }
  for (const field of DROPPED_FIELDS) delete merged[field]
  return merged as unknown as Config
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** 间隔字段（分钟）的统一校验。三道闸缺一不可：
 *  - Number.isFinite：`{"autoScanMinutes": 1e999}` 是合法 JSON，JSON.parse 给出 Infinity，
 *    只查 typeof 和 `< 0` 会放它过去，JSON.stringify 落盘时写成 null——功能永久静默关闭
 *  - Number.isInteger：0.001 同样过得了「非负有限数」，装表却是 60ms 的全量扫描死循环
 *  - 上限：见 MAX_INTERVAL_MINUTES（setInterval 32 位溢出）
 *  undefined = patch 里没带这个字段，不算错——POST 端点要求必填时自行先查。
 *  label 是报错里出现的字段名：POST /api/auto-* 收的请求字段叫 minutes，报错却写配置字段名
 *  的话，照着报错重试的集成方会带着 {"autoFetchMinutes": 5} 死循环撞 400 */
export function checkMinutes(
  body: Record<string, unknown>,
  key: "autoScanMinutes" | "autoFetchMinutes",
  label: string = key,
): string | null {
  const v = body[key]
  if (v === undefined) return null
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    return `${label} must be a non-negative number`
  if (!Number.isInteger(v)) return `${label} must be an integer`
  if (v > MAX_INTERVAL_MINUTES) return `${label} must be at most ${MAX_INTERVAL_MINUTES}`
  return null
}

export function validateConfigPatch(body: unknown): string | null {
  if (!isRecord(body)) return "body must be an object"
  for (const key of ["roots", "excludes", "manualRepos", "favorites", "archived"] as const) {
    if (body[key] !== undefined && !isStringArray(body[key])) return `${key} must be a string array`
  }
  if (body.tags !== undefined && (!isRecord(body.tags) || !Object.values(body.tags).every(isStringArray)))
    return "tags must be a record of string arrays"
  if (
    body.groupOverrides !== undefined &&
    (!isRecord(body.groupOverrides) || !Object.values(body.groupOverrides).every((v) => typeof v === "string"))
  )
    return "groupOverrides must be a record of strings"
  if (
    body.notes !== undefined &&
    (!isRecord(body.notes) || !Object.values(body.notes).every((v) => typeof v === "string"))
  )
    return "notes must be a record of strings"
  if (
    body.lastOpened !== undefined &&
    (!isRecord(body.lastOpened) || !Object.values(body.lastOpened).every((v) => typeof v === "string"))
  )
    return "lastOpened must be a record of strings"
  if (body.autoWatch !== undefined && typeof body.autoWatch !== "boolean") return "autoWatch must be a boolean"
  const minutes = checkMinutes(body, "autoScanMinutes")
  if (minutes !== null) return minutes
  const fetchMinutes = checkMinutes(body, "autoFetchMinutes")
  if (fetchMinutes !== null) return fetchMinutes
  if (body.watchLimit !== undefined) {
    const v = body.watchLimit
    // 上限没有溢出风险（只是个切片长度），但仍要挡住小数/非有限值：
    // 落盘成 null 或 NaN 会让 `limit > 0` 恒假，静默变成「无上限」
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
      return "watchLimit must be a non-negative integer"
  }
  if (body.notifications !== undefined && typeof body.notifications !== "boolean") return "notifications must be a boolean"
  if (body.health !== undefined) {
    if (!isRecord(body.health)) return "health must be an object"
    if (body.health.staleDays !== undefined && typeof body.health.staleDays !== "number")
      return "health.staleDays must be a number"
    if (body.health.disabledRules !== undefined && !isStringArray(body.health.disabledRules))
      return "health.disabledRules must be a string array"
  }
  if (
    body.open !== undefined &&
    (!isRecord(body.open) || !Object.values(body.open).every((v) => typeof v === "string"))
  )
    return "open must be a record of strings"
  return null
}

/** 数值字段的入库归一化：老版本校验松（接受小数、无上限），或手改/损坏写入了 null、
 *  越界值——这些已经在用户盘上，读进来必须收拾成合法值，不能原样带着走。
 *  不归一化的话，PUT /api/config 的整份 round-trip（GET→改一处→PUT）会被一个用户
 *  根本没碰的老字段卡成 400，任何无关设置都存不了 */
function sanitizeNumber(v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fallback
  return Math.min(Math.floor(v), max)
}

/**
 * **解析**不出来的 config.json 挪到一边保住原始字节，返回 true 表示「已保住，可以用默认值继续跑」。
 *
 * 只对解析失败调用，绝不对读失败调用（见 loadConfig）：读不出来不代表内容坏了。
 *
 * 这里**不能**照搬 json-store 的「坏了当空」：那四个文件丢了最多是慢一轮，而 config.json 装的是
 * 全部用户数据（tags/favorites/archived/notes/roots/groupOverrides/lastOpened）。当空继续的话，
 * 下一次 saveConfig —— 点一次「在编辑器打开」就会写一次 lastOpened，窗口频繁 —— 会把一份默认
 * 配置整份盖上去，用户的标签/收藏/归档从「文件还在、也许救得回来」变成「真的没了」。
 * 所以先改名保住坏文件（顺带让 config.json 消失，下轮走「文件不存在」→ 默认值），再继续。
 *
 * 备份名带时间戳而不是固定后缀：固定后缀的话第二次损坏会覆盖掉第一次那份备份，而第一份往往
 * 才是数据最全的那份——保住坏文件的整个意义就没了。
 *
 * 挪不动（目录只读 / 文件被杀软占住）就返回 false，由调用方抛出：宁可看板 500 让人立刻发现，
 * 也不能让一份默认配置把用户数据覆盖掉——500 是可恢复的，覆盖不是。
 */
function quarantineCorrupt(file: string): boolean {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
    renameSync(file, backup)
    console.error(`[repo-radar] config.json 解析失败，已备份为 ${backup} 并按默认设置继续 / corrupt config backed up`)
    return true
  } catch {
    return false
  }
}

export function loadConfig(file: string): Config {
  // 「读」与「解析」必须分开，且只有**解析**失败才算「文件坏了」。
  // 合在一个 try 里的话，任何非 ENOENT 的读失败——EACCES / EPERM / EBUSY / EIO / EMFILE，
  // 杀软或备份进程短暂占住，REPO_RADAR_CONFIG 指向网络盘 / OneDrive 时的瞬时抖动——都会被
  // 当成损坏：一份**字节完好**的 config.json 被改名成 config.json.corrupt-<时间戳>，返回默认
  // 配置，下一次 saveConfig（点一次「在编辑器打开」写 lastOpened 就触发）把默认值整份落盘，
  // 用户的标签/收藏/归档/便签就这么没了；日志还说「解析失败」，把人引去检查一份语法完全
  // 正确的 JSON。「读不出来 ⇒ 也挪不动 ⇒ 走响亮的 500」这个前提是假的：Windows 上只拒
  // FILE_READ_DATA 时 DELETE 权限仍在，rename 照常成功；POSIX 上 rename 只看父目录的 w+x，
  // 从不看文件自身的读权限。
  // 于是与 automation.ts 的 pathGone、repo-identity.ts 的 pathExists 取同一口径：只有 ENOENT
  // 算「没有这个文件」，其余读失败一律原样抛出，走 quarantineCorrupt 注释自己选的那条路——
  // 宁可看板 500 让人立刻发现，也不能让一份默认配置把用户数据覆盖掉：500 是可恢复的，覆盖不是。
  // 也正因如此不能再用 existsSync 预判：它内部吞掉一切错误，EACCES 同样返回 false，
  // 「不存在」与「读不了」又会被合成同一个答案，默认配置照样落盘
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG)
    throw err
  }
  let raw: Partial<Config>
  try {
    raw = JSON.parse(text) as Partial<Config>
  } catch (err) {
    // 不加 try/catch 的话，一次断电留下的截断文件会让这里每轮都抛：RepoStore.getConfig 无人接，
    // 看板永久 500，用户连「数据还在不在」都看不到
    if (!quarantineCorrupt(file)) throw err
    return structuredClone(DEFAULT_CONFIG)
  }
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), raw)
  cfg.autoScanMinutes = sanitizeNumber(cfg.autoScanMinutes, DEFAULT_CONFIG.autoScanMinutes, MAX_INTERVAL_MINUTES)
  cfg.autoFetchMinutes = sanitizeNumber(cfg.autoFetchMinutes, DEFAULT_CONFIG.autoFetchMinutes, MAX_INTERVAL_MINUTES)
  cfg.watchLimit = sanitizeNumber(cfg.watchLimit, DEFAULT_CONFIG.watchLimit)
  return cfg
}

export function saveConfig(file: string, config: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  // 先写同目录的临时文件再 rename，形状与 json-store.ts 的 write() 一致：writeFileSync 是
  // 「先截断再写」，崩溃/断电正好落在这个窗口里就留下一个截断的 config.json。而这个文件装的是
  // 全部用户数据，写它的路径有四条（roots / 元信息 / 归档 / lastOpened），其中 lastOpened
  // 每点一次「在编辑器打开」就写一次——窗口频繁且真实。同目录 rename 在 NTFS 与 POSIX 上
  // 都是原子替换，读方要么看到旧的完整内容、要么看到新的完整内容，不存在半截状态。
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8")
  renameSync(tmp, file)
}
