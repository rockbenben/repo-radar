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
  autoWatch: boolean // 文件监听实时刷新：默认关闭，需在面板手动开启
  autoFetchMinutes: number // 定时后台 fetch 间隔（分钟）；0 = 关闭（默认）
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
  autoFetchMinutes: 0,
  health: { staleDays: 90, disabledRules: [] },
  open: {
    editor: 'code "{path}"',
    terminal: 'wt -d "{path}"',
    explorer: 'explorer "{path}"',
  },
}

export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    health: { ...base.health, ...(patch.health ?? {}) },
    open: { ...base.open, ...(patch.open ?? {}) },
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

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
  if (body.autoFetchMinutes !== undefined && (typeof body.autoFetchMinutes !== "number" || body.autoFetchMinutes < 0))
    return "autoFetchMinutes must be a non-negative number"
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

export function loadConfig(file: string): Config {
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG)
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>
  return mergeConfig(structuredClone(DEFAULT_CONFIG), raw)
}

export function saveConfig(file: string, config: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2))
}
