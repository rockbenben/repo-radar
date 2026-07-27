import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  autoWatch: boolean // 文件监听实时刷新：默认开启（纯本地、无网络、无打扰），可在面板关闭
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
  autoWatch: true,
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

export function loadConfig(file: string): Config {
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG)
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), raw)
  cfg.autoScanMinutes = sanitizeNumber(cfg.autoScanMinutes, DEFAULT_CONFIG.autoScanMinutes, MAX_INTERVAL_MINUTES)
  cfg.autoFetchMinutes = sanitizeNumber(cfg.autoFetchMinutes, DEFAULT_CONFIG.autoFetchMinutes, MAX_INTERVAL_MINUTES)
  cfg.watchLimit = sanitizeNumber(cfg.watchLimit, DEFAULT_CONFIG.watchLimit)
  return cfg
}

export function saveConfig(file: string, config: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2))
}
