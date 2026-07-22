import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 「SEA 时代自启意图是否已迁移过」这个一次性标记的桌面端专属存储。
 *
 * 缺陷 4 的修复：这个状态之前被塞进了 server/src/config.ts 的 Config——那是用户可见、
 * 可通过 PUT /api/config 修改的配置文件 schema。后果：用户会在自己的 config.json 里看到一个
 * 看不懂的内部字段（legacyAutostartMigrated），还能通过公开 API 把它改坏，进而干扰
 * cleanupLegacyEntries 的迁移判定（比如被改成 false，导致每次启动都重新尝试"继承"自启意图）。
 *
 * 这纯粹是桌面端的实现细节，用户不需要看见、也不该能改，因此仿照 window-state.json 的做法，
 * 单独落一个只有桌面端自己读写的小文件（main.ts 里与 window-state.json 放在同一个配置目录下）。
 *
 * 与 window-state.ts 的 loadState 不同：这里文件损坏（存在但 JSON.parse 失败，比如上次
 * 硬杀导致截断）不能悄悄当成"默认值"处理——调用方（cleanupLegacyEntries）必须能区分
 * "文件不存在"（全新安装，正常走默认值）与"文件存在但读不出来"（不确定用户是否已经迁移过，
 * 贸然按"未迁移"处理并继续删除遗留条目，一旦删完发现状态还是不确定，条目已经没了、
 * 迁移却可能永远不会再触发——这正是缺陷 1 的根源），因此用 ok/error 的返回值让调用方自己决定。
 */
export interface AutostartMigrationState {
  legacyAutostartMigrated: boolean
}

export const DEFAULT_MIGRATION_STATE: AutostartMigrationState = { legacyAutostartMigrated: false }

export type MigrationStateResult =
  | { ok: true; state: AutostartMigrationState }
  | { ok: false; error: string }

export function loadMigrationState(file: string): MigrationStateResult {
  if (!existsSync(file)) return { ok: true, state: { ...DEFAULT_MIGRATION_STATE } }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AutostartMigrationState>
    return { ok: true, state: { legacyAutostartMigrated: raw.legacyAutostartMigrated === true } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function saveMigrationState(file: string, state: AutostartMigrationState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8")
}
